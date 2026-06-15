# mikura — 御蔵

## Overview

Modern file-sharing system built on **WinFsp** (Windows File System Proxy) + a Deno REST/WSS server. The client mounts a virtual drive whose backend is the mikura HTTP server; reads stream on-demand byte-ranges, writes are forwarded as chunked upload sessions, all locking and sync runs through HTTPS/WSS.

ADR-021 documents the migration from CfApi to WinFsp — undertaken to gain SMB-equivalent offline-immediate-disconnect that CfApi could not deliver. ADR-032 documents the move from the official `winfsp-msil.dll` .NET binding to an in-house modern P/Invoke binding (`WinFsp.Native`).

## Layout

- `server/` — Deno + TypeScript (Hono, Deno KV)
- `client/` — C# .NET 10 / Windows Forms. 5 projects:
  - `WinFsp.Native` — in-house WinFsp .NET binding (LibraryImport + function pointers + `[UnmanagedCallersOnly]`). Provides `IFileSystem` / optional `IAsyncFileIo` + `FileSystemHost`. AOT-ready, no `winfsp-msil` dependency. (ADR-032)
  - `WinFsp.Interop` — adapter that bridges `IFileSystemBackend` (Mikura.Core) ↔ `IFileSystem` (WinFsp.Native). Holds `BackendFileSystem`, `BackendFileSystemHost`, `OnlineGate`.
  - `Mikura.Core` — domain models, abstractions (`IServerApi`, `IEventStream`, `IFileSystemBackend`), `FileSystemBackend`, `SyncEngine`.
  - `Mikura.Transport` — REST/WSS HTTP impl (`HttpServerApi`, `HttpEventStream`).
  - `Mikura.App` — WinForms host (`TrayAppContext`, `SettingsForm`).

## Current implementation

- Projection: WinFsp callback-driven. `BackendFileSystem` (in `WinFsp.Interop`) translates IRPs to `IFileSystemBackend` calls. Callbacks are bound via function pointers in `FileSystemHost.PopulateInterface` (ADR-032). Per-Create FileContext is mandatory via `UmFileContextIsUserContext2` flag.
- Offline gate: `OnlineGate` flips on WSS disconnect; every callback returns `STATUS_NETWORK_UNREACHABLE` so existing handles die immediately — the migration's raison d'être.
- Read: per-IRP byte-range fetch via `GET /content` with `Range:` header. No whole-file hydrate; `_originalServerSize` per handle bounds the fetch. Per-handle prefetch cache armed on sequential streaks (ADR-031).
- Write: kernel writes are forwarded through `WriteCoalescer` (path-shared, range-coalesce + multipart/byteranges, 4-deep send pipeline, bounded `ArrayPool` 4MB max) over the `POST /uploads` → `PATCH /uploads/:id` (multipart for non-contiguous ranges) → `POST /uploads/:id/finalize` session API (ADR-025, ADR-029). Server stages to a sibling `staging/` dir and POSIX-renames into `data/` on finalize.
- Cleanup: WinFsp `Cleanup` with `CleanupSetLastWriteTime` → drain in-flight async I/O → finalize session → release lock (ADR-016 retained, ADR-020 retained at concept level). `PostCleanupWhenModifiedOnly = false`; `Close` is a safety-net for lock release. `shouldUpload` requires `HasLock` so 2nd Cleanup on the same Create handle (kernel can issue) doesn't re-fire StartUpload (ADR-032 Bug 1 lesson).
- Locking: acquired in `FileSystemBackend.OpenAsync` per Device ID (ADR-016, ADR-022 process-local refcount via `LockSlot`); write-intent + lock denial = immediate `STATUS_ACCESS_DENIED`; TTL via Deno KV `expireIn` 30s + WSS heartbeat 10s (ADR-018). `Rename` force-releases src/dst locks (ADR-024).
- Volume info: `GET /volume` reports real FS capacity via `node:fs/promises` `statfs` against `DATA_ROOT` (so Docker bind/named volumes report host capacity). Client caches with 30s background refresh.
- Event broadcast: API-driven. Each mutation route calls `broadcastFileEvent("created"|"modified"|"deleted", path, meta?)`; `Deno.watchFs` retired (rename events were unreliable).
- Device ID: persisted in `device.json` next to the client executable.
- Authorization: REST and WSS both filter through `checkPermission`.

## Prerequisites

WinFsp 2.1+ MSI must be installed on the client machine: <https://winfsp.dev/rel/>

`WinFsp.Native` resolves `winfsp-x64.dll` at runtime via `NativeApi.Resolve` (`HKLM\SOFTWARE\WOW6432Node\WinFsp\InstallDir` + fallback to `%ProgramFiles(x86)%\WinFsp\bin\`). `winfsp-msil.dll` is no longer referenced (ADR-032).

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

- Server: TypeScript strict mode, idiomatic Hono patterns.
- REST API paths: forward slashes, relative to data root.
- Path validation required: reject `..` and null bytes.
- Use Deno KV atomic ops to prevent races.
- C#: `unsafe` is permitted only in `WinFsp.Native` (function pointers + raw native memory) and a few IRP buffer paths in `WinFsp.Interop`. `Mikura.Core` / `Mikura.Transport` / `Mikura.App` stay fully managed.
- C#: prefer zero-alloc (DTOs as `readonly struct`, `ArrayPool`, `stackalloc` with `ArrayPool` fallback).
- C#: `WinFsp.Native` / `WinFsp.Interop` are AOT-ready (`<IsAotCompatible>true</IsAotCompatible>` is locked in). Do not introduce reflection there — no `JsonSerializer.Deserialize<T>`, no `Activator.CreateInstance`, no `Type.GetType(string)`, no `Assembly.Load`. The analyzer will flag these at build time.
- Tests: see [[testing-philosophy]] and [[testing-fake-pattern]] — assert responsibilities, not coverage. Use hand-written fakes (state + counters + toggles), not Moq, for stateful collaborators.

## Environment-identifying strings

**NEVER include environment-identifying strings anywhere that ends up in the public repo — commit messages, source code, comments, tests, docstrings, ADRs, READMEs, log strings, fixture data — in any form, under any circumstances.**

This includes: local file names from manual testing (especially titles / catalog numbers / personal media), absolute paths, usernames, hostnames, real IP addresses, internal URLs, real Device ID hex from local logs, specific byte sizes / counts measured on the developer's own machine, or anything that would not be appropriate if a stranger read the public repo. A past leak required wiping the entire git history and recreating the repository — this rule is non-negotiable.

Describe changes and behavior at the level of project source only. When the explanation genuinely needs to reference an environment-specific value, **generalize it before writing**: "an 85 MB MP4" → "a video file of a few dozen MB", `D:\Users\...\report.xlsx` → "a local Excel file", `192.168.1.5` → "another host on the LAN", `B9011E00 / 3A211E00` → "multiple Device IDs". Omitting context is a fallback; replacing with a generalized stand-in is the preferred technique because the reader still gets the meaning. The same generalization rule applies to numeric measurements taken on the developer's own machine ("a real run: copying a 30 MB file pushed resident memory to 90 MB" → "copying a file of a few dozen MB inflates resident memory several times over"): keep the *shape* of the observation, drop the *exact* values.

Test fixtures, sample paths, and example identifiers in code must use obviously-synthetic names (`/Movie.mp4`, `Book1.xlsx`, `192.168.0.1` as a documentation example, `dev-abc12345`) rather than real ones from manual testing.

## Docs

- [docs/decisions/](docs/decisions/) — Architecture Decision Records, one file per ADR (`docs/decisions/ADR-NNN-*.md`). Index lives at [docs/decisions/README.md](docs/decisions/README.md).

## Logs

- Server: `server/mikura-server.log` (`console.log/warn/error` tee, append mode).
- Client: `client/src/Mikura.App/bin/Debug/<TFM>/mikura-client.log` (`Trace.WriteLine` + uncaught exceptions logged as `[FATAL]` / `[ERROR]`).

## Working efficiently (codebase navigation / context budget)

- **Never `Read` log files in full.** `mikura-client.log` can grow to tens of MB after a CDM benchmark or any sustained load. Always slice with `grep` or `tail -N` (e.g. `grep "ERROR\|FATAL" log | tail -30`, `tail -200 log`). One accidental full Read can blow the entire context budget.
- **Hot files >800 lines** (`Mikura.Core/FileSystem/FileSystemBackend.cs`, `WinFsp.Native/FileSystemHost.cs`, etc.) should be navigated with `grep -n <symbol> <file>` to locate the section, then `Read offset:N limit:M`. Avoid whole-file Reads.
- For exploration queries that look like "where is X done", "which file defines Y", "who is responsible for Z" and span more than ~3 lookups, spawn an `Explore` subagent via `Agent(subagent_type='Explore', ...)`. The agent's context is separate, so only the summary returns to the main loop.
- `dotnet test` output: always filter as `--verbosity quiet 2>&1 | tail -10`. Verbose mode emits multiple lines per test.
- `dotnet build` output: same idea, `2>&1 | tail -8`. Warnings/errors collapse to the final "X Warning(s), Y Error(s)" lines.
- ADRs are split per file. To read about a specific decision, find it via [docs/decisions/README.md](docs/decisions/README.md) and Read only that one ADR file — not the whole `docs/decisions/` directory.
- **Documents consumed mainly by AI assistance (ADRs, this CLAUDE.md) are written in English** for tokenizer efficiency. User-facing documents (`README.md`, code comments, commit messages, UI strings, log messages) remain in Japanese. See [[doc-language-convention]] in memory.
