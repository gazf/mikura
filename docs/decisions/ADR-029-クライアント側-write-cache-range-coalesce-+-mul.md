## ADR-029: クライアント側 write cache — range-coalesce + multipart/byteranges + path 単位 session 共有

**決定**: ADR-025 の per-IRP PATCH 直流方式を、3 層構造の write cache に置き換える:

1. **WriteCoalescer**: kernel `Write` IRP を 4MB バッファに range pack して 1 PATCH に集約
2. **multipart/byteranges PATCH**: 非連続な複数 range を 1 リクエストで送る独自拡張
3. **per-path SessionSlot**: 同一 path への複数 handle で upload session を共有 (refcount + TCS pattern)

### 背景

ADR-025 で「kernel `Write` IRP をその場で PATCH に直流」を採用したが、実運用負荷で 3 つの問題が顕在化した:

1. **per-IRP PATCH の HTTP round-trip オーバーヘッド**: WinFsp は典型 64KB-1MB の IRP を多数発行する。CDM SEQ 1M Q=8 Write でも数千 PATCH が直列に近い形で並ぶ
2. **小さい random write の集約不足**: Excel / SQLite / CDM RND 4K のような散発書き込みが 1 IRP = 1 PATCH = 1 round-trip を踏み、何百という小 PATCH を生む
3. **複数 handle 同 path の session 重複**: CDM RND 4K Q=32 T=**16** が 16 file handle を開くと、各 ServerHandle が独立に `StartUploadAsync(baseFromExisting=true)` を呼び、**16 × 1GB の base copy** で server disk が飽和 (実機 ~300 MB/s × 53 秒) して測定窓を食い尽くす

(3) が最も影響が大きく、CDM RND 4K Q=32 T=16 Write が **0.007 MB/s** という壊滅的な数字を出していた根本原因。

### 設計

#### Layer 1: WriteCoalescer (range-list buffer)

ServerHandle 単位ではなく **SessionSlot 単位 (= path 単位)** に 1 つ。kernel IRP が来ると:

```
buf: byte[4MB]                          // ArrayPool 共有
ranges: List<(FileOffset, BufOffset, Length)>
```

- IRP のペイロードを `buf` の末尾に `_bufFilled` 位置から copy
- 直前 range と file offset 上で連続 (`last.FileOffset + last.Length == fileOffset`) なら range を末尾延長 (merge)、非連続なら新規 range を append
- バッファ満杯 (4MB) / `MaxRanges` (4096) / idle timeout (50ms) で flush

flush 時:

- ranges 1 本だけ → single-range PATCH (`UploadChunkAsync`, multipart overhead を払わない)
- ranges N 本 → multipart/byteranges PATCH (`UploadChunksMultipartAsync`)

target サイズ超 (≥4MB) の 1 IRP は coalesce せず単 range PATCH に直送。

**N-deep pipeline (N=4)**: flush 時に `SemaphoreSlim(4, 4)` から slot を 1 つ取り、background `Task` で send。slot は send 完了時に release。同時に最大 4 PATCH が in-flight になる。Read 経路が HttpClient の `MaxConnectionsPerServer=8` 並列を使い切って 342 MB/s を出していたのに対し、Write を serial PATCH で運用すると 80 MB/s 頭打ちで非対称になっていたのを解消する。

順序保証: 同一 buffer 内は range list 順、buffer 間は flush 順で submit するが server 到着順は保証しない。HTTP/1.1 multi-connection で 4 リクエストが別 TCP 接続に乗るため completion order はネットワーク次第。実 server は seek+write が fd 独立なので **非重複 range なら問題なし**、重複は **last write wins** = ADR-025 旧 ChunkedUploader 並列 worker と同じ semantics。

#### Layer 2: multipart/mixed を request body として採用

複数 range を 1 PATCH で送るために、RFC 2046 §5.1.3 の `multipart/mixed` (汎用 multipart container) を request body として使う。各 part が `Content-Range` header を持ち、対応する file offset への書込みを表す。

**形式**:
```
PATCH /uploads/:uploadId
Content-Type: multipart/mixed; boundary=mikura-<guid>

\r\n--BOUNDARY\r\n
Content-Type: application/octet-stream\r\n
Content-Range: bytes 0-499/*\r\n
\r\n
<500 bytes>\r\n--BOUNDARY\r\n
Content-Type: application/octet-stream\r\n
Content-Range: bytes 1000-1499/*\r\n
\r\n
<500 bytes>\r\n--BOUNDARY--\r\n
```

- **server side**: `server/src/util/multipartRanges.ts` に streaming parser (media type 非依存)。各 part の `Content-Range` から `(offset, length)` を抜き、body 本体は逐次 sink (Deno.write per chunk) へ流して RAM 展開しない
- **client side**: `System.Net.Http.MultipartContent("mixed", boundary)` がそのまま使える。`ReadOnlyMemoryContent` で coalescer の 4MB バッファをスライスして part を作るので zero-copy

**part 1 つあたりのオーバーヘッド**: ~110B (boundary + Content-Type + Content-Range + 2× CRLF)。実用ケースの比率:

| ワークロード | range 数 | payload | overhead |
|---|---|---|---|
| SEQ 1M (contig merge 後) | 1 | 4MB | 0% (single-range 経路) |
| CDM RND 4K Q=32 batched | 64 | 256KB | 2.7% |
| Excel sparse save batched | 16 | 200KB | 0.9% |

**媒体型の選択経緯**: HTTP 標準は request body の複数 range 書込みを規定していないため、以下 3 案を検討した:

1. **独自 Content-Range 多 range 値** (`Content-Range: bytes 0-30,45-50/*`): wire 形式は最小だが HTTP 仕様外。L7 WAF が malformed と判断するリスクあり (Cloudflare backend 等で実例)。**却下**
2. **`multipart/byteranges`** (RFC 7233 §A) **を request body に流用**: 当初の設計案。Content-Range per part の semantics が RFC 7233 §A で明示されている強みがあるが、**IANA registry の登録に "This media type is not generally useful outside the context of HTTP messages with the response status code 206" と明記**されており、本来の用途 (206 response) から逸脱する。実装は両端 mikura なので動くが、registry 記述に反する設計を残すのは将来 reverse proxy 経由運用や外部 audit で説明負債になる。**却下**
3. **`multipart/mixed`** (RFC 2046 §5.1.3): 汎用 multipart container として "the body parts are independent and need to be bundled in a particular order" を定義しているのみで、方向制限・用途制限なし。Content-Range per part は本媒体型では ad-hoc な application-level 拡張になるが、これは PATCH 標準が複数 range の概念を持たない以上どの案でも避けられない。**採用**

選択は (3)。媒体型自体に方向制限を持たないので IANA registry に抵触せず、汎用 multipart の意味として正しい。Content-Type が `multipart/` で始まる点は (2) と変わらないため WAF/proxy 通過性のメリットも同じ。

#### Layer 3: per-path SessionSlot (refcount + TCS)

ADR-016/022 の `LockSlot` と同じパターン:

```csharp
class SessionSlot {
    int Refcount
    string UploadId         // 最初の caller が StartUpload して埋める
    WriteCoalescer Coalescer
    TaskCompletionSource<bool> StartResult   // 2 番目以降の Acquire はこれを await
    long MaxFinalSize        // 全 handle の h.Length の max
    bool AnyModified
}

Dictionary<string, SessionSlot> _activeSessions   // path keyed
```

- `AcquireSessionSlotAsync(path, baseFromExisting)`: 最初の caller のみ `StartUploadAsync` を実走。後続は `StartResult.Task` を await して同じ slot を共有
- `EnqueueChunkAsync`: `slot.Coalescer.AppendAsync` を呼ぶ (全 handle で共有された 1 つのバッファに append)
- `ReleaseSessionSlotForFinalizeAsync`: refcount-- → 0 になった (= 最後の handle) ケースだけ実 `Flush` + `FinalizeUploadAsync` を実走。それ以外は `null` を返し、caller (`CleanupAsync`) は `_tree` 更新をスキップ
- `ReleaseSessionSlotForAbortAsync`: 同様に refcount-- → 0 のときだけ実 abort

**Mixed baseFromExisting** (1 handle が `CreateAsync`、別 handle が `OpenAsync` で write) は **最初の caller の判定を採用**。実用上は 16 個同時 open がすべて同じ intent なので影響なし。万一 mixed の場合は最初の caller の `baseFromExisting=true` が採用されて 1GB copy が 1 回だけ走る。

### 計測 (CDM 9.0.2, 1 GiB×3, WSL2 LAN, Release build)

|  | ADR-025 baseline | ADR-029 1-deep | ADR-029 4-deep (採用) |
|---|---|---|---|
| SEQ 1M Q=8 Write | 80 MB/s | 81 MB/s | **120 MB/s** |
| SEQ 128K Q=32 Write | 54 MB/s | 76 MB/s | **108 MB/s** |
| **RND 4K Q=32 T=16 Write** | **0.007 MB/s** | 22.6 MB/s | **51 MB/s** |
| RND 4K Q=1 T=1 Write | 16.7 MB/s | 21.8 MB/s | **50 MB/s** |
| SEQ 1M Q=8 Read | 326 MB/s | 342 MB/s | 301 MB/s |
| RND 4K Q=32 T=16 Read | 2.33 MB/s | 2.57 MB/s | 2.51 MB/s |

クライアントプロセス常駐メモリ (RND Q=32 Write 中):
- baseline: ~300 MB
- 1-deep (session-sharing のみ): ~50 MB
- 4-deep pipeline: ~114 MB (+64 MB)

メモリ増 +64 MB は in-flight buffer 4 本 (~16 MB) + MultipartContent serialize 中間 + HttpClient per-connection send buffer の合算。**RND の 2.2x / SEQ 128K の 1.4x スループット向上に対する trade として妥当**。

### 段階別の支配的要因 (重要)

各層単独の寄与を分離すると:

1. **per-path session sharing** が RND Q=32 の **~3000x の支配的要因** (0.007 → 22.6)。これがないと測定窓が baseFromExisting copy で埋まり、他の最適化は観測すらできない
2. **range-coalesce + multipart** は単独では SEQ 128K で +40% 程度。session sharing と組み合わせて初めて効く
3. **N-deep (1→4) pipeline** が更に **2.2x** を載せる。1-deep 時の WriteCoalescer は MaxConnectionsPerServer=8 を 1 本しか使わず、Read 経路 (8 並列 GET = 342 MB/s) との非対称が SEQ Write の見えない天井だった

### 残存する天井 (~120 MB/s)

4-deep でも SEQ 1M Write は ~120 MB/s で頭打ち。server-side disk は実機 ~300 MB/s 出ているので、残る候補は:

- **WSL2 networking の write 方向帯域** (Read 342 MB/s vs Write 120 MB/s の非対称)
- **Deno.serve の async I/O thread pool 上限** (file.write が pool 経由で serial 化)
- **HTTP/2 stream multiplex 復活** (ADR-028 の再評価。1-deep 時代に検証した時の "-80%" は **per-IRP PATCH 構造が前提**だったので、4MB chunk + N-deep pipeline 体制では再計測する価値あり)

優先度は ADR-028 の再開条件と本 ADR の measurement リランで決定。

### 却下した代替案

- **独自 Content-Range 多 range 値** (`Content-Range: bytes 0-30,45-50/*`): wire 形式は最小だが HTTP 仕様外で WAF/proxy 通過性が不透明
- **`multipart/byteranges` を request body に流用**: IANA registry の usage restriction (206 response 以外で一般的に有用でない) に抵触するため見送り。詳細は「媒体型の選択経緯」項参照
- **per-thread / global キャッシュ**: SessionSlot を path 単位ではなく thread / process global に持つ案。session lifecycle (start/finalize/abort) の同期が複雑化し、Cleanup 順と finalize 順がずれるケースで _tree 整合が取れなくなる。per-path で十分
- **MaxInFlight=8 以上の更に深い pipeline**: メモリ消費が比例で増える割に、SEQ 1M の 120 MB/s 天井が server / WSL2 側にあるなら効果は薄い。HTTP/2 検証先行

### 関連 ADR

- 前提: ADR-025 (chunked upload session の wire protocol そのものは流用)
- 前提: ADR-016/022 (LockSlot pattern を SessionSlot で再利用)
- 関連: ADR-028 (HTTP/2 が解禁されれば SEQ Write 天井を上げられる可能性)
