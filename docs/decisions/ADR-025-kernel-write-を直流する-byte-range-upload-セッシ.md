## ADR-025: kernel write を直流する byte-range upload セッション

**決定**: WinFsp の `Write` callback で kernel から渡される `(offset, size, data)` を、**handle 単位の in-memory バッファに溜めず、サーバ側 upload session に逐次 PATCH で流す** pass-through 構造に切替える。Samba 代替として GB 級ファイルを扱う以上、ADR-023 の「ファイルサイズ ≒ クライアントメモリ」制約は実用上許容できないため、本 ADR で構造的に解消する。

**スタンス変更**: 当初 ADR は「将来検討」「実装しない」だったが、mikura のターゲット要件(Samba 代替、ファイルサーバ汎用用途)では大容量ファイルが第一級ユースケースであり、現行の in-memory staging 方式では成立しないと判断。**次フェーズで実装する** 位置付けに格上げ。

**動機(ADR-023 から引き継ぐ Known limitation)**:

- メモリ占有 ≒ ファイルサイズ(GB 級で破綻)
- 2GB 超で `OverflowException`
- 途中切断で先頭から再送
- 進捗表示不可
- HttpClient の 100 秒タイムアウトに低速回線で抵触

根本原因: 現行 `UploadFileAsync` が「ファイル全体を MemoryStream で渡す単一 PUT」のため、 **kernel の random write を sequential body に並べ直すために全 buffer を抱える必要がある**。byte-range PATCH 系のプロトコルなら、WinFsp `Write(offset, data)` をそのまま `PATCH /uploads/:id/:offset` に転送できる。

### コア設計判断 — pass-through 構造

WinFsp の `Write` callback が来たら、handle に紐付いた upload session に対して `PATCH` を発行して即返す。**handle 側に溜め込まない**。これにより:

- handle のメモリ占有はファイルサイズに比例しなくなる(in-flight chunk ぶんのみ)
- 2GB 制約が消える(int.MaxValue は in-memory buffer の制約だった)
- random write の順序保存は server temp file の `seek + write` が担当(自然)

ADR-023 の in-memory staging は **read 経路だけ残す**(Read 時の whole-file hydrate)。Write 経路は本 ADR で完全に書き換える。

### プロトコル

| Endpoint | 役割 |
|---|---|
| `POST /uploads` body: `{ path }` | upload session 作成、`{ uploadId }` 返却。`(deviceId, path)` で一意。lock holder と一致しなければ 403 |
| `PATCH /uploads/:uploadId` Header: `Content-Range: bytes <off>-<end>/<*>` body: bytes | 任意 offset への chunk 書き込み。サーバ側 temp file に `seek + write` |
| `POST /uploads/:uploadId/finalize` body: `{ size }` | `ftruncate(size)` → temp → 実 path に原子 rename → `/tree` 更新 → `UploadResult` 返却 |
| `DELETE /uploads/:uploadId` | 破棄(cancel / Cleanup without Modified)|
| `HEAD /uploads/:uploadId` | 再開用に現状の最大 written offset を返す(将来) |

KV スキーマ:

```typescript
["uploads", uploadId] → {
    uploadId: string,        // UUID v4
    deviceId: string,        // ADR-018: lock holder の deviceId
    userId: number,
    path: string,
    tempPath: string,        // <STAGING_ROOT>/<uploadId> (storage の外側、後述)
    createdAt: string,
    expiresAt: string,       // lock TTL と同期
}
```

### TBD 解決(本改訂で確定する)

**1. temp file の TTL 管理**

- upload session の TTL は **ADR-018 の Liveness lock TTL(30 秒)と一致** させ、WSS heartbeat で同期延長する
- lock が失効したら、その deviceId が持つ全 upload session を自動 abort(temp file 削除)
- 専用の TTL を持たないことで「lock 生存中はセッションも生存」「lock 失効=セッション失効」が SSOT になり、孤児 upload が原理的に発生しない

**2. finalize の原子性 と temp の配置**

- `temp → 実 path` は同一ファイルシステム内 `Deno.rename` で原子的(POSIX `rename(2)` 準拠)
- temp 領域は **`DATA_ROOT` の sibling** として `STAGING_ROOT`(デフォルト `cwd/staging`、`MIKURA_STAGING_ROOT` で override 可)に置く。**`DATA_ROOT` の中に置かない**:
  - 中に置くと `/tree` / `listDirectory` / `Deno.watchFs` の全 surface で「内部 path を毎回フィルタする」責務が漏れ出し、後から API を増やすたびに同じ filter を足す保守債務になる
  - Docker / k8s 化したとき、data(永続)と staging(再起動で消えていい、tmpfs にしてもいい)で**ボリューム永続化粒度を分けたい**。同一ディレクトリ配下だと選べない
  - 命名は「commit 前に積まれる場所」という DB / データパイプライン由来の語感を踏襲。`tmp` / `cache` は disposability(消していい)を誤って示唆するため避ける
- 同一 FS 制約: 両 root を `cwd` 直下に置く既定なら同 FS。env で別マウントに分離した場合は `Deno.rename` が `EXDEV` になり得るので、起動時 or finalize 時に検出して fallback(コピー+ unlink、原子性は失われるが finalize 1 回だけ)を入れる余地はある(現時点では未実装、要件が出た時に対応)
- クロスデバイス対応は将来要件として留保(Linux のクラスタ FS で運用する事案は現状想定しない)

**3. 権限チェック**

- **`POST /uploads`(start)で 1 回だけ** checkPermission + lock holder 一致確認
- session に紐付いた `(uploadId, deviceId)` を以後の PATCH/finalize で照合(認証はする、認可は再評価しない)
- 権限が mid-upload で剥奪された場合のレースは「次回 open / lock acquire 時に弾く」で割り切る(SMB も同様の挙動)

**4. client の async pipelining**

WinFsp の `Write` callback は IRP 単位で同期。各 callback で PATCH 完了まで待つと LAN でも RTT が積み上がる。

採用設計:

- handle ごとに **最大 N=8 in-flight chunk** の queue を持つ
- WinFsp `Write` 到着 → queue に enqueue + 即座に return(`Write` の戻り値 = 受領 byte 数)
- 背景タスクが queue から取り出して PATCH を順次発行(**同時 N 並列**)
- queue 満杯時のみ kernel `Write` をブロック(natural backpressure)
- `Cleanup(Modified)` で「queue drain 待ち → finalize」、`Cleanup(without Modified)` で「queue cancel → DELETE」
- いずれかの PATCH が失敗したら以降の Write は失敗を即返す(handle を壊れた状態にして上位に通知)
- 同一 offset への上書きはサーバ側 `seek+write` の単純後勝ちで OK(WinFsp が同 offset を並列に送ってくることは設計上ない)

**5. threshold の有無**

- **threshold を撤廃**、すべてのファイルを upload session 経由で送る
- 撤廃理由: 二経路保守のコストが「小ファイル 2 RTT 削減」のメリットに見合わない、かつ small write を coalesce すれば実用上の遅延差は小さい
- 0 byte ファイル(touch)は `POST /uploads` → `POST /uploads/:id/finalize { size: 0 }` の 2 回で完結
- ベンチマーク後に「単一 PUT fast path」を fallback として復活させる余地は残す

### 期待効果

| 観点 | 現状(単一 PUT)| 改訂(range PATCH 直流)|
|---|---|---|
| クライアントメモリ(1GB ファイル送信時)| ~1GB | **~N × chunk size**(数 MB〜数十 MB)|
| 上限ファイルサイズ | ~2GB | **無制限**(int64 offset)|
| 進捗表示 | 不可 | 可能(各 PATCH が progress)|
| 再開 | 不可 | 可能(`HEAD /uploads/:id` で確認 → 続きから)|
| WinFsp `Write` レイテンシ | 同上 | queue 受領時のみ実 IO 待ち |
| 業界類例 | — | tus.io / S3 multipart / Azure Block Blob |

### chunk size

WinFsp の `Write` callback の長さは典型 64 KB〜1 MB(IRP 由来、kernel が決める)。これをサーバ送信単位とそのまま一致させる(client 側で coalesce しない)。

サーバ /1 PATCH オーバーヘッドは ~10ms オーダなので、1 GB / 64 KB chunk = 16,384 req → in-flight 8 並列で 16,384 / 8 × 10ms ≒ 20 秒の累積。これは LAN の物理帯域(1 Gbps で 1GB ≒ 10 秒)に対して許容できる範囲。

将来チューニングする場合は client 側で「同 chunk 内連続 write は coalesce」を入れるが、初期実装ではしない。

### 実装メモ — `System.Buffers` / `System.IO.Pipelines` / `System.Threading.Channels`

write 側は「random offset の chunk を N 並列で送る producer-consumer」、read 側は「sequential ストリーム消費」と性質が違うので、それぞれに合った道具を使う。

**write 経路(本 ADR の本丸)**:

- in-flight queue は **`System.Threading.Channels.Channel<UploadChunk>`**(bounded capacity = N=8、`BoundedChannelFullMode.Wait` で natural backpressure)。Pipe は sequential なので random-offset の chunk 列を扱うのに向かない、Channel が自然。
- `UploadChunk` の payload は **`ArrayPool<byte>.Shared` から rent**(`System.Buffers`)。WinFsp `Write` 受領時に rent → コピー → enqueue、consumer が PATCH 送信完了後に `Return(buffer, clearArray: false)`。同一 ArrayPool を ADR-023 の hydrate 経路と共有しないため、chunked 専用の `ArrayPool<byte>.Create(maxArrayLength: 4 * 1024 * 1024, maxArraysPerBucket: 16)` を別途用意する。
- PATCH の HTTP body は **`ReadOnlyMemoryContent(rentedMemory)`** で投げる(`StreamContent(MemoryStream)` だと余計な wrap が増える)。

**read 経路の検討結果(PipeReader 化は不採用)**:

実装着手時に `EnsureHydratedAsync` を `PipeReader.Create(stream)` に置き換える方向で検討したが、**現行の実装の方が低オーバヘッド** と判断した(以下の理由により採用見送り):

- 現行は `_bufferPool.Rent(expectedSize)` で確定サイズの最終バッファを一度だけ取り、`HttpContent.ReadAsStreamAsync` の戻り値を `_buffer.AsMemory(off, len)` に**直接書き込む**(中間バッファゼロ)
- PipeReader を挟むと内部 segment(MemoryPool 由来)が新たな中間層になり、segment → 最終バッファへの追加コピーが発生する
- expectedSize は `_entry.Size` から既知なので Pipelines の「動的にバッファ拡張」の利点も効かない

PipeReader が本領を発揮するのは「サイズ不定の sequential ストリームを incremental に消化する」場合で、本機能(Read IRP は random offset、whole-file が必要)とは性質が合わない。

代わりに **server 側 PATCH 受信を ReadableStream → `Deno.FsFile.write` に直結** することで対称な改善を入れた(8MB chunk なら同等のメモリ削減効果)。

**handle にかかる buffer モデルの変化**:

現行(ADR-023): `byte[] _buffer` が論理ファイル全長を保持。
改訂後 write: `Channel<UploadChunk>` のみ(ファイル全長は持たない、in-flight ぶんだけ)。
改訂後 read: `Pipe` の内部 buffer が hydrate 進捗ぶんだけ持つ。read が完了した範囲は上位に渡し終えたら開放。

これにより handle ごとのメモリ占有が「ファイルサイズ依存」から「IRP の流量依存」に切り替わる。

### HTTP/2 との関係(切り離し)

ADR-010 の HTTP/2 化は本 ADR とは独立した経路最適化。HTTP/1.1 でも `MaxConnectionsPerServer = 8` で本 ADR の N=8 並列 PATCH は成立する。HTTP/2 移行時には 1 TCP/TLS 接続上の N stream 多重化に置き換わるが、本 ADR の設計に変更は不要。

### 関連 ADR

- 前提: ADR-021(WinFsp 移行)、ADR-023(in-memory staging — 本 ADR で write 経路だけ supersede)
- 連動: ADR-018(Liveness lock TTL を upload session TTL として流用)
- 関連: ADR-016(write lock holder = upload session 所有者)、ADR-026(ETag/If-Match による lost update 検出は finalize 段階に置く)
