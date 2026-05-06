# mikura - Cloud API File System

Samba/WebDAV/LDAPに依存しない、モダンなファイル共有システム。
**WinFsp**(Windows File System Proxy) + 独自REST APIサーバーで構成。

> ADR-021 で **CfApi → WinFsp** に移行。CfApi では構造的に達成できなかった
> 「オフライン即時切断」(=Samba 同等のセッション切断 UX)を実現するための転換。

## アーキテクチャ

```
Windows エクスプローラー
  ↓ 標準ファイルシステムAPI
WinFsp (winfsp-x64.sys ファイルシステムドライバ)
  ↓ ユーザーモード コールバック (Fsp.FileSystemBase)
mikura client (C# .NET 10)
  ├─ WinFsp.Interop : MikuraFileSystem(IFileSystemBackend に委譲)
  ├─ Mikura.Core      : MikuraServerBackend(ADR-016 ロック / ADR-020 write-back)
  └─ Mikura.Transport : HTTPS / WSS
  ↓ HTTPS + WSS
mikura server (Deno + TypeScript)
  ├── 認証・認可(Deno KV、JWT/トークン)
  ├── ファイル操作(ローカルFS)
  ├── ファイルロック管理
  └── 監査ログ
```

## 前提条件

クライアント実行機に **WinFsp 2.1+ MSI** をインストールしておく必要があります。
ダウンロード: https://winfsp.dev/rel/

ビルドだけなら WSL からも可能(`/mnt/c/Program Files (x86)/WinFsp/bin/winfsp-msil.dll` を参照)。

## セットアップ

### サーバー (Linux/WSL2)
```bash
cd server
deno task seed   # 初期データ投入
deno task dev    # 開発サーバー起動 (port 8700)
```

### クライアント (Windows)
```bash
cd client
dotnet build
dotnet run --project src/Mikura.App
```

設定で `Sync Root` にドライブ文字(例 `Z:`)を入れると、その文字でマウントされます。

## ドキュメント

- [docs/decisions.md](docs/decisions.md) — Architecture Decision Records (ADR-021 が現行アーキの根拠)
