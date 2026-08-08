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

mikura console (Deno + Hono、別プロセス / 既定は起動しない)
  └─ 管理画面。KV には触れず `/admin/*` を HTTP で叩く BFF (ADR-033)
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

### 管理コンソール (任意 / 管理作業をするときだけ起動)

```bash
cd console
MIKURA_API_URL=http://127.0.0.1:8700 deno task dev
# → http://127.0.0.1:8701/console/
```

ユーザー・グループ・権限・招待・端末・監査ログをブラウザから操作できます。
ログインには管理トークンを貼り付けます (`cd server && deno task seed` の出力、
または `deno run --allow-all --unstable-kv issue-token.ts` で再発行)。

設計上の性質 (ADR-033):

- API サーバとは**別プロセス**。既定で loopback にしか bind しないので、
  外から見えるポートには一切現れません。リモートから使うときは SSH
  ポートフォワード等を経由してください。
- Deno KV もデータルートも開きません。パーミッション (`--unstable-kv` なし、
  書き込み権限なし) でそれが強制されています。
- 管理トークンは console プロセスのメモリにしか置かれず、ブラウザにも
  ディスクにも出ません。console を止めれば攻撃面はゼロになります。

| 環境変数 | 既定 | 意味 |
| --- | --- | --- |
| `MIKURA_API_URL` | `http://127.0.0.1:8700` | API サーバの内部アドレス |
| `MIKURA_CONSOLE_HOST` | `127.0.0.1` | bind 先 |
| `MIKURA_CONSOLE_PORT` | `8701` | listen ポート |
| `MIKURA_CONSOLE_COOKIE_SECURE` | `false` | TLS の後ろに置くなら `true` |
| `MIKURA_CONSOLE_SESSION_IDLE_MINUTES` | `30` | 無操作でセッション破棄 |
| `MIKURA_CONSOLE_SESSION_MAX_HOURS` | `8` | セッションの絶対寿命 |

招待リンクを発行するには、**API サーバ側**に `MIKURA_PUBLIC_URL`
(クライアントから到達できる URL) を設定してください。未設定の場合はシークレット
のみ表示され、そのまま配れるリンクは作られません (ADR-034)。

### クライアント (Windows)

```bash
cd client
dotnet build
dotnet run --project src/Mikura.App
```

初回はタスクトレイの「プロファイルを追加」から、管理者に発行してもらった
招待リンク (`mikura://enroll?...`) を貼り付けます。クリップボードにリンクが
入っていれば自動で埋まります。マウント先のドライブ文字は空いているものから
選べます。

`mikura://` はクライアント起動時に現在のユーザーへ関連付けられるので、
チャット等で送られたリンクをクリックするだけでも追加できます (管理者権限不要)。
Device ID は `device.json` に永続化されます (実行ファイル隣)。

多数の端末に一括展開する場合は、`inits/` に `*.init.json` を置く従来の経路も
そのまま使えます。

## ドキュメント

- [docs/decisions/](docs/decisions/) — Architecture Decision Records (ADR-021 が現行アーキの根拠、ADR-025 が chunked upload セッション API、ADR-032 が現行 WinFsp .NET binding)
- [CLAUDE.md](CLAUDE.md) — リポジトリのコーディング規約 / AI アシスタント向けガイド
