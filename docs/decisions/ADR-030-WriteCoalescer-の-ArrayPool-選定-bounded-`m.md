## ADR-030: WriteCoalescer の ArrayPool 選定 — bounded `maxArraysPerBucket=16` を採用

**決定**: `WriteCoalescer` の 4MB バッファ pool は `ArrayPool<byte>.Create(maxArrayLength: 4MB, maxArraysPerBucket: 16)` を使う。`ArrayPool<byte>.Shared` は採用しない。

### 経緯

3 段階の試行を経た:

1. **初代**: `ArrayPool<byte>.Create(4MB, maxArraysPerBucket: 4)`
   - メモリ上限を 16 MB に切る意図
   - **問題**: CDM RND 4K T=16 のような 16 並行 session 環境で 4 slot 不足、12 session ぶんが毎 cycle fresh alloc に fallback。bench:CoalescerBench で RND 4K Q=32 T=16 の alloc/op が 1251 B/op まで膨らんだ
2. **2 代 (d4b065d → revert)**: `ArrayPool<byte>.Shared`
   - 初動 bench (alloc/op 1251 → 498、-60%) では大幅改善に見えた
   - **問題**: .NET 6+ Shared 実装 (`TLSCachedArrayPool`) は per-thread cache を持ち、ThreadPool が拡張されるたびに新 thread が独自 slot を確保する。CDM を 10 回以上反復すると ThreadPool 内の全 thread が一度は 4MB buf を rent し、各 thread の slot が Gen2 GC trim でも release されにくいため、process Working Set が反復回数に対して monotonic に成長して頭打ちにならない (ユーザ環境で 1 回 ~150 MB → 10 回 ~200 MB と確認)
3. **現在 (ed6607a)**: `ArrayPool<byte>.Create(4MB, maxArraysPerBucket: 16)`
   - bucket 上限を 16 に拡大、16 並行 session でも fallback せず
   - per-thread cache を持たないので thread 数増えても retain は増えない
   - bucket 上限 16 × 4MB = **64 MB に hard cap**、CDM 反復回数に依存しない

### 計測結果 (ユーザ環境 CDM, 10 回反復後の安定状態)

| 項目 | 初代 (Create 4-slot) | 2 代 (Shared) | 現在 (Create 16-slot) |
|---|---:|---:|---:|
| **メモリ Working Set 反復後** | ~150 MB 程度 | **monotonic 成長して 200 MB+ で頭打ちにならない** | **66 MB で安定 (反復回数非依存)** |
| SEQ 1M Write | ~134 MB/s | ~134 MB/s | **~155 MB/s (+16%)** |
| SEQ 128K Write | ~102 MB/s | ~102 MB/s | **~124 MB/s (+22%)** |
| RND 4K Q=32 T=16 Write | ~0.007 MB/s (壊滅) | ~58 MB/s | ~58 MB/s (同等) |
| bench:CoalescerBench RND 4K T=16 alloc/op | 1251 B/op | 498 B/op | 513 B/op |

SEQ Write の改善は `TLSCachedArrayPool` の per-thread cache 管理 / `Gen2GcCallback` 経由の trim 処理のオーバヘッドが SEQ 1M の 4MB buf 高頻度 rent で目立っていた効果と推定される (bounded pool はシンプルな Monitor.Enter で予測可能)。

### なぜ ArrayPool.Shared は long-running workload に向かないか

`TLSCachedArrayPool<T>` の構造 (.NET 6+):
- per-thread slot: thread ごとに 1 buf キャッシュ。Gen2 GC で「最近使われた flag」が立ってない slot のみ trim される
- shared partition: per-CPU bucket × 数 slot

CDM のような「ThreadPool 上の多 thread が 4MB buf を頻繁 rent/return」パターンでは、全 thread の per-thread slot に「最近使われた flag」が立ち続け、Gen2 GC trim 対象にならない。結果として **ThreadPool 拡張に比例して retain が増える**。

bounded `ArrayPool<byte>.Create()` は per-thread cache を持たない `ConfigurableArrayPool<T>` 実装で、`Monitor.Enter` で global bucket を排他制御する。並行 rent 時にロック競合は発生するが、retain は厳密に `bucket 数 × maxArraysPerBucket × bucket size` で上限が決まる。short-burst workload では Shared より遅くなる場合があるが、**long-running の memory 安定性が圧倒的に重要**。

### 関連 fix

- **ServerBackend.ReleaseSessionSlotForFinalizeAsync の Coalescer dispose 漏れ** (17e9208): try block で FlushAsync が throw した場合に DisposeAsync が skip され、Coalescer の Timer が TimerQueue に grounded したまま Coalescer + buf + _inFlightSends Tasks が leak していた。finally で必ず DisposeAsync を呼ぶよう修正。通常 CDM (HTTP error 無し) では発火しない経路だが、transient HTTP 失敗 / cancel 等で稀に踏むため防御策として残す

### 教訓

- **bench:CoalescerBench は short-lived 実験** で per-thread cache の累積を捕まえられなかった。long-running pattern (= 実 CDM) で初めて表面化
- bench harness が短命だと、long-lived pool / cache behavior の bug を逃す。bench 設計時に「同じ ThreadPool で反復実行した時に retain が増えないか」を見るシナリオを追加すべき
- .NET の `ArrayPool.Shared` は「fire-and-forget でとりあえず使う」用途には便利だが、**long-running daemon process では retention 特性が問題化する**。明示的な bounded pool を選んだほうが予測可能

### 関連 ADR

- 前提: ADR-029 (WriteCoalescer 本体設計)
- 関連: `bench:CoalescerBench` (`scenario=rnd4k-scaling`) の Q/T 直交分解が pool 関連 alloc 問題の発見に使えた

---
