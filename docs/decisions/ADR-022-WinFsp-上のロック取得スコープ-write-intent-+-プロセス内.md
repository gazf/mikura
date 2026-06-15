## ADR-022: WinFsp 上のロック取得スコープ — write-intent + プロセス内 refcount

**決定**: ADR-016 の「open 時ロック」を WinFsp の callback 数の現実に合わせて再定義する:

1. **write-intent open のみ**(read-only open はロック取得しない)
2. **同一プロセス内の同一パスへの複数 open は refcount で集約**(POST/DELETE は最初の open と最後の close でだけ発生)
3. **ロック衝突時は `STATUS_ACCESS_DENIED`**(404 ではなく)で即時応答

**背景 — CfApi 時代との差分**:

CfApi の `NOTIFY_OPEN_COMPLETION` は「実際にユーザが意図したファイル open」だけに反応するフックだったが、WinFsp は **kernel から来るすべての `CreateFile` IRP** を user-mode の `Open` callback に転送する。1 ユーザ操作 = 数十 CreateFile が普通:

- shell preview / icon overlay / プロパティダイアログ / Defender / 検索インデクサ /
  safe-save の rename(DELETE 権限要求)/ notepad の autosave サイクル

ナイーブに「すべての open でロック取得」を実装すると、1 編集で `POST /locks` が **20〜30 回連発**する状態が観測された。

**設計判断 1: write-intent のみロック**

read-intent open(content viewing, scanning, preview)は ADR-020 の「サーバが単一真実」原則からして並行可。Excel/Word/Notepad の **「他者編集中でも read-only で開ける」UX** を維持するため、read open ではロック取得しない。

read 専用ハンドルから誤って write が来る経路は kernel 側で原則拒否されるが、防衛として `MikuraServerBackend.WriteAsync` で `!h.HasLock && !h.FreshlyCreated` の場合 `UnauthorizedAccessException` を投げる二重チェックを入れる。

**設計判断 2: プロセス内 refcount による server lock 共有**

write-intent でも、上述の通り 1 編集で複数の write-intent open が連発する。これらをすべて独立に AcquireLock すると:

- サーバへの POST 連発
- 兄弟ハンドルの最初の Cleanup が server lock を release → 残りのハンドルが「ロック持ってる」と思ったまま upload する race condition

修正:`MikuraServerBackend` に `LockSlot` 構造を導入。同一プロセス・同一パスへの open は `_activeLocks` dictionary 経由で refcount を bump するだけ。`POST /locks` は最初の open でのみ HTTP 発火、`DELETE /locks` は最後の close でのみ発火。並行 open のための `TaskCompletionSource` で 2 番目以降の open は最初の HTTP 結果を待ってから inherit。

**設計判断 3: 衝突時の NTSTATUS マッピング**

ロック取得失敗時、`MikuraFileSystem.Open` の汎用 catch がすべての例外を `null` にして `STATUS_OBJECT_NAME_NOT_FOUND` を返すバグがあった。これだとユーザは「ファイルが見つかりません」と表示され、本当の理由(他者編集中)が伝わらない。

修正:`UnauthorizedAccessException` を専用 catch して `STATUS_ACCESS_DENIED` を返す。Excel が「他のユーザが使用中です。読み取り専用で開きますか?」のダイアログを正しく表示できるようになる。

**残課題:lost update**

read-only 期間中は server-side lock 不在のため、以下のシーケンスが lost update を起こす:

```
A: read open → 内容 "x" を fetch
B: read open → 内容 "x" を fetch
A: 編集して save (write open → AcquireLock → upload "y" → release)
B: 編集して save (write open → AcquireLock 成功(A 既に release)→ upload "B's x→x'")
   ← B は A の "y" を見ずに自分の "x'" でサーバ上書き = A の編集消失
```

これは ADR-026 の ETag/If-Match 楽観的並行制御で対応する想定(本 ADR では扱わない)。

**実装場所**:

- `client/src/Mikura.Core/Sync/MikuraServerBackend.cs` の `OpenAsync` / `AcquireSharedAsync` / `ReleaseSharedAsync` / `LockSlot`
- `client/src/WinFsp.Interop/MikuraFileSystem.cs` の `Open` callback と `HasWriteAccess` ヘルパ

**関連 ADR**:

- supersede: ADR-016 の "open 時ロック" 部分(タイミングは維持、スコープを write-intent に限定)
- 維持: ADR-018(Device ID + heartbeat の Liveness)
- 派生: ADR-026(ETag による lost update 防止、未着手)

---
