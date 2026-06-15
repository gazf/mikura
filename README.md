# mikura — 御蔵

Samba / WebDAV / LDAP に依存しない、モダンなファイル共有システム。
**WinFsp** (Windows File System Proxy) でマウントした仮想ドライブを、独自 REST/WSS の Deno サーバーが裏で支える構成。

> ADR-021 で **CfApi → WinFsp** に移行。CfApi では構造的に達成できなかった
> 「オフライン即時切断」(= SMB 同等のセッション切断 UX) を実現するための転換。

## アーキテクチャ

```
Windows エクスプローラー
  ↓ 標準ファイルシステム API
WinFsp (winfsp-x64.sys ファイルシステムドライバ)
  ↓ ユーザーモード コールバック (function pointer, [UnmanagedCallersOnly])
mikura client (C# .NET 10, Clean Architecture)
  ├─ WinFsp.Native    : 自前 modern P/Invoke binding (LibraryImport, AOT-ready)
  │                     IFileSystem / FileSystemHost を提供 (ADR-032)
  ├─ WinFsp.Interop   : BackendFileSystem (IRP → IFileSystemBackend), OnlineGate
  ├─ Mikura.Core      : ServerBackend (ADR-016 ロック / ADR-022 refcount),
  │                     SyncEngine, WriteCoalescer (ADR-029, ADR-030)
  ├─ Mikura.Transport : HttpServerApi / HttpEventStream (REST + WSS)
  └─ Mikura.App       : WinForms tray host
  ↓ HTTPS + WSS
mikura server (Deno + Hono + Deno KV)
  ├─ 認証・認可 (JWT、Device ID)
  ├─ ファイル操作 (ローカル FS、`data/` + `staging/`)
  ├─ Range PATCH ベースの chunked upload セッション (ADR-025)
  ├─ ファイルロック管理 (ADR-018: TTL 30s + WSS heartbeat 10s)
  └─ イベント配信 (API-driven broadcast)
```

- **読み取り**: per-IRP byte-range fetch (`GET /content` + `Range:` ヘッダ)
- **書き込み**: kernel write を `POST /uploads` → `PATCH /uploads/:id` → `POST /uploads/:id/finalize` セッションに転送、サーバー側は `staging/` に積んで finalize で `data/` に POSIX rename
- **オフライン**: WSS 切断で `OnlineGate` が落ち、以後の callback は即 `STATUS_NETWORK_UNREACHABLE`

## 前提条件

クライアント実行機に **WinFsp 2.1+ MSI** をインストールしておく必要があります。
ダウンロード: <https://winfsp.dev/rel/>

`WinFsp.Native` は runtime に `winfsp-x64.dll` を `HKLM\SOFTWARE\WOW6432Node\WinFsp\InstallDir` から resolve します
(fallback: `%ProgramFiles(x86)%\WinFsp\bin\`)。`winfsp-msil.dll` への依存は ADR-032 で撤去済み。
ビルドだけなら WSL / Linux でも通ります (P/Invoke は実行時 resolve なので Linux 上でも compile は通る)。
CI (Linux runner) では `Mikura.Core` / `Mikura.Transport` / `WinFsp.Native` (managed 部分) を検証しています。

## セットアップ

### サーバー (Linux / WSL2 / macOS)

```bash
cd server
deno task seed   # 初期データ投入
deno task dev    # 開発サーバー起動 (port 8700, --watch)
deno task test   # テスト
```

サーバーは起動時に `server/` 直下に以下を自動作成します:

- `data/` — 確定済みファイルツリー (`MIKURA_DATA_ROOT`)
- `staging/` — chunked upload セッションの中間置き場 (`MIKURA_STAGING_ROOT`)、finalize で `data/` に rename(2)

### クライアント (Windows)

```bash
cd client
dotnet build
dotnet run --project src/Mikura.App
```

設定で `Sync Root` にドライブ文字 (例 `Z:`) を入れると、その文字でマウントされます。
Device ID は `device.json` に永続化されます (実行ファイル隣)。

## ドキュメント

- [docs/decisions/](docs/decisions/) — Architecture Decision Records (ADR-021 が現行アーキの根拠、ADR-025 が chunked upload セッション API、ADR-032 が現行 WinFsp .NET binding)
- [CLAUDE.md](CLAUDE.md) — リポジトリのコーディング規約 / AI アシスタント向けガイド
