# mikura — 御蔵

## Overview

Modern file-sharing system built on **WinFsp** (Windows File System Proxy) + a Deno REST/WSS server. The client mounts a virtual drive whose backend is the mikura HTTP server; reads stream on-demand byte-ranges, writes are forwarded as chunked upload sessions, all locking and sync runs through HTTPS/WSS.

ADR-021 documents the migration from CfApi to WinFsp — undertaken to gain SMB-equivalent offline-immediate-disconnect that CfApi could not deliver.

## Layout

- `server/` — Deno + TypeScript (Hono, Deno KV)
- `client/` — C# .NET 10 / Windows Forms. Clean Architecture, 4 layers:
  - `WinFsp.Interop` — `Fsp.FileSystemBase`-derived `BackendFileSystem` adapter, `OnlineGate`, `BackendFileSystemHost`
  - `Mikura.Core` — domain models, abstractions (`IServerApi`, `IEventStream`, `IFileSystemBackend`), `ServerBackend`, `SyncEngine`
  - `Mikura.Transport` — REST/WSS HTTP impl (`HttpServerApi`, `HttpEventStream`)
  - `Mikura.App` — WinForms host (`TrayAppContext`, `SettingsForm`)

## Current implementation

- Projection: WinFsp callback-driven. `BackendFileSystem` translates IRPs to `IFileSystemBackend` calls (ADR-021 supersedes ADR-013).
- Offline gate: `OnlineGate` flips on WSS disconnect; every callback returns `STATUS_NETWORK_UNREACHABLE` so existing handles die immediately — the migration's raison d'être.
- Read: per-IRP byte-range fetch via `GET /content` with `Range:` header. No whole-file hydrate; `_originalServerSize` per handle bounds the fetch.
- Write: kernel writes are forwarded chunk-by-chunk through `ChunkedUploader` (`Channel<UploadChunk>` bounded(1) + 4 workers, `ArrayPool` 4MB max) over the `POST /uploads` → `PATCH /uploads/:id` → `POST /uploads/:id/finalize` session API (ADR-025). Server stages to a sibling `staging/` dir and POSIX-renames into `data/` on finalize.
- Cleanup: WinFsp `Cleanup` with `CleanupSetLastWriteTime` → drain uploader → finalize session → release lock (ADR-016 retained, ADR-020 retained at concept level). `PostCleanupWhenModifiedOnly = false`; `Close` is a safety-net for lock release.
- Locking: acquired in `ServerBackend.OpenAsync` per Device ID (ADR-016, ADR-022 process-local refcount via `LockSlot`); write-intent + lock denial = immediate `STATUS_ACCESS_DENIED`; TTL via Deno KV `expireIn` 30s + WSS heartbeat 10s (ADR-018). `Rename` force-releases src/dst locks (ADR-024).
- Volume info: `GET /volume` reports real FS capacity via `node:fs/promises` `statfs` against `DATA_ROOT` (so Docker bind/named volumes report host capacity). Client caches with 30s background refresh.
- Event broadcast: API-driven. Each mutation route calls `broadcastFileEvent("created"|"modified"|"deleted", path, meta?)`; `Deno.watchFs` retired (rename events were unreliable).
- Device ID: persisted in `device.json` next to the client executable.
- Authorization: REST and WSS both filter through `checkPermission`.

## Prerequisites

WinFsp 2.1+ MSI must be installed on the client machine: <https://winfsp.dev/rel/>

The csproj resolves `winfsp-msil.dll` from `$(MSBuildProgramFiles32)\WinFsp\bin\` on Windows or `/mnt/c/Program Files (x86)/WinFsp/bin/` from WSL.

## Server dev

```bash
cd server
deno task dev      # dev server (port 8700, --watch)
deno task test
deno task seed     # initial data
```

Server data layout (siblings under `server/`, both auto-created at startup):

- `data/` — committed file tree (`MIKURA_DATA_ROOT`)
- `staging/` — in-flight chunked upload sessions (`MIKURA_STAGING_ROOT`); finalize = `rename(2)` into `data/`

## Client dev

```bash
cd client
dotnet build
dotnet run --project src/Mikura.App  # Windows only
```

## Coding rules

- Server: TypeScript strict mode, idiomatic Hono patterns
- REST API paths: forward slashes, relative to data root
- Path validation required: reject `..` and null bytes
- Use Deno KV atomic ops to prevent races
- C#: `unsafe` は `WinFsp.Native` 層 (関数ポインタ + 生 native memory) と一部 IRP buffer 受け渡しに限定で使用可、それ以外は要らない。`Mikura.Core` / `Mikura.Transport` / `Mikura.App` は managed only
- C#: prefer zero-alloc (DTOs as `readonly struct`, `ArrayPool`, `stackalloc` with `ArrayPool` fallback)
- C#: WinFsp 層は AOT-ready (`<IsAotCompatible>true</IsAotCompatible>` 永続化済み) なので、reflection / `JsonSerializer.Deserialize<T>` / `Activator.CreateInstance` 等の reflection API は `WinFsp.Native` / `WinFsp.Interop` には入れない (analyzer が warning として弾く)

## Environment-identifying strings

**NEVER include environment-identifying strings anywhere that ends up in the public repo — commit messages, source code, comments, tests, docstrings, ADRs, READMEs, log strings, fixture data — in any form, under any circumstances.**

This includes: local file names from manual testing (especially titles / catalog numbers / personal media), absolute paths, usernames, hostnames, real IP addresses, internal URLs, real Device ID hex from local logs, specific byte sizes / counts measured on the developer's own machine, or anything that would not be appropriate if a stranger read the public repo. A past leak required wiping the entire git history and recreating the repository — this rule is non-negotiable.

Describe changes and behavior at the level of project source only. When the explanation genuinely needs to reference an environment-specific value, **generalize it before writing**: "85MB の MP4" → "数十 MB の動画ファイル", `D:\Users\...\report.xlsx` → "ローカル Excel ファイル", `192.168.1.5` → "LAN 上の別 host", `B9011E00 / 3A211E00` → "複数の Device ID"。Omitting context is a fallback; replacing with a generalized stand-in is the preferred technique because the reader still gets the meaning. The same generalization rule applies to numeric measurements taken on the developer's own machine ("実機: 30MB ファイル copy で 90MB" → "数十 MB のファイル copy で常駐メモリが数倍に膨らむ"): keep the *shape* of the observation, drop the *exact* values.

Test fixtures, sample paths, and example identifiers in code must use obviously-synthetic names (`/Movie.mp4`, `Book1.xlsx`, `192.168.0.1` as a documentation example, `dev-abc12345`) rather than real ones from manual testing.

## Docs

- [docs/decisions/](docs/decisions/) — Architecture Decision Records (個別 ADR は `docs/decisions/ADR-NNN-*.md`、index は [docs/decisions/README.md](docs/decisions/README.md))

## Logs

- Server: `server/mikura-server.log` (`console.log/warn/error` tee, append mode)
- Client: `client/src/Mikura.App/bin/Debug/<TFM>/mikura-client.log` (`Trace.WriteLine` + uncaught exceptions logged as `[FATAL]`/`[ERROR]`)

## Working efficiently (codebase 探索 / context 節約)

- **log は絶対 `Read` しない**。`mikura-client.log` は CDM 等の負荷テスト後に **数十 MB** まで成長する。常に `grep` または `tail -N` で部分取り込み (`grep "ERROR\|FATAL" log | tail -30` や `tail -200 log` 等)。1 回うっかり全体 Read すると context が一発で吹き飛ぶ
- **800 行超の hot file** (`Mikura.Core/FileSystem/FileSystemBackend.cs`, `WinFsp.Native/FileSystemHost.cs` 等) は `grep -n <symbol> <file>` で対象行特定 → `Read offset:N limit:M` で部分取り込み。全体 Read は避ける
- **「どこで X してるか」「Y はどのファイル」「Z の責務は誰」**のような探索が 3 query 超になりそうなら `Explore` subagent を `Agent(subagent_type='Explore', ...)` で spawn。main loop の context を消費しないで結論だけ受け取れる
- **`dotnet test` 出力**は常に `--verbosity quiet 2>&1 | tail -10` でフィルタ。verbose だと test ごとに数行ずつ流れる
- **`dotnet build` 出力**も `2>&1 | tail -8` で末尾だけ取る。warning / error は末尾の "X Warning(s) Y Error(s)" 行に集約される
- **ADR は分割済み** (`docs/decisions/ADR-NNN-*.md`)、特定 ADR の内容が必要なら個別ファイルだけ Read。`docs/decisions/README.md` が index、まずそれを見て該当 ADR を特定する
