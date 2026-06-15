## ADR-024: フォルダ作成 + rename サポート(サーバ endpoint 拡張)

**決定**: サーバに **`POST /folders/*path`**(非再帰 mkdir)と **`PATCH /files/*path`**(rename / move)を追加する。クライアントは `IMikuraServer.CreateFolderAsync` / `RenameAsync` 経由でこれを呼び、`MikuraServerBackend.CreateAsync(isDirectory)` / `RenameAsync` で WinFsp の対応 callback と接続する。

**背景**:

WinFsp 移行直後の `MikuraServerBackend` は spike から派生していたため:

- `CreateAsync(isDirectory: true)` が常に `null` 返却 → エクスプローラ「新規 > フォルダー」が機能不全
- `RenameAsync` が `NotSupportedException` → エクスプローラの「新規ファイル作成 → 名前編集」が失敗

ユーザ目線では「新規ファイルが作れない」と見える(実態は Create は通っているが直後の Rename で失敗していた)。

**サーバ側 API**:

| Endpoint | 仕様 |
|---|---|
| `POST /folders/*path` | 非再帰 mkdir。親が無ければ 404、既に同名があれば 409。201 で `{ path }` 返却 |
| `PATCH /files/*path` body: `{ newPath }` | 旧→新へ移動。衝突時 409、対象不在時 404、源/先両方に write 権限要求 |
| `DELETE /files/*path` (既存) | ファイル/ディレクトリ削除。`MikuraServerBackend.CleanupAsync(Delete)` から呼ばれる |

サーバ実装は `Deno.mkdir({ recursive: false })` と `Deno.rename`。衝突検知は `Deno.stat` の前置き。

**クライアント実装**:

- `Mikura.Transport.HttpMikuraServer` に `CreateFolderAsync`(POST、409 は冪等扱い)と `RenameAsync`(PATCH JSON body)を追加
- `MikuraServerBackend.CreateAsync(isDirectory: true)` で `_server.CreateFolderAsync(path)` を呼んで `_tree` に登録、ハンドルを返す
- `MikuraServerBackend.RenameAsync` で `_server.RenameAsync(src, dst)` を呼び、`_tree` を `src` 削除 / `dst` 追加で更新。`replaceIfExists=true` の場合はクライアント側が先に `DeleteFileAsync(dst)` してから rename
- `MikuraServerBackend.CanDeleteAsync` をディレクトリにも許可するよう変更(以前はファイルのみ)

**Phase ロードマップ上の位置**:

ADR-021 の Phase B/C/D で WinFsp 統合が完了し、CfApi 時代の `feature/explorer-create-rename` ブランチに溜まっていたサーバ側作業を移植する形で本 ADR の機能を追加した。stash されていた `client/src/Mikura.Transport/HttpMikuraServer.cs` の API 拡張部分を WinFsp pivot 後の構造に取り込んだもの。

**未対応(Known limitation)**:

- ディレクトリ作成は **1 段だけ**(`recursive: false`)。Windows シェルが親→子の順に CreateFile を発行するため通常問題ないが、自動化スクリプトで深いツリーをまとめて作成するときは個別に POST する必要がある。
- 非空ディレクトリの削除挙動はサーバ `deleteFile` 実装依存。テストツリーで深いネストを削除する前に挙動確認が必要。

**実装場所**:

- `server/src/routes/files.ts`(POST `/folders/*` と PATCH `/files/*` のハンドラ)
- `server/src/services/file.service.ts`(`createFolder` / `renameEntry` 関数)
- `client/src/Mikura.Core/Abstractions/IMikuraServer.cs`(API 定義)
- `client/src/Mikura.Transport/HttpMikuraServer.cs`(HTTP 呼び出し)
- `client/src/Mikura.Core/Sync/MikuraServerBackend.cs`(WinFsp と接続)

**関連 ADR**:

- 前提: ADR-021(WinFsp 移行)
- 補完: ADR-022(rename 時のロックは write intent open に同等扱い)

---
