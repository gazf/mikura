## ADR-031: Read 経路の per-handle read-ahead prefetch cache (Samba 流 next-sequential)

**決定**: `ServerBackend.ReadAsync` に **per-handle 1-entry の speculative prefetch cache** を導入する。1 IRP につき要求 byte 数の 2x (cap 256KB) をサーバから取得し、IRP 要求分を返した後の余剰を per-handle に 1 entry だけ保持する。次 IRP が cache 先頭から始まる (= sequential continue) ならゼロラウンドトリップで返す。**sequential pattern detection (連続 3 read で armed)** を併用して RND workload で prefetch を発行しない設計とした。

### 背景

ADR-027 で記録した **Windows Cache Manager の per-handle 2-outstanding 制約**により、`CDM RND 4K Q=32 T=16 Read` は構造的に並列度が頭打ちで、ADR-028 で検討した HTTP/2 化も実装コスト対比で見送り済み。一方 **SEQ 128K Q=32 Read** などの中粒度 SEQ ワークロードは、per-IRP の HTTP RTT が支配的な律速になっており、IRP 数自体を減らせれば改善の余地がある。

`bench:diag-rtt` の (7) (`GET /content` 4K Range cache hit) ~860 µs/req の内訳:

- pure HTTP route + auth: ~530 µs (50%)
- server file ops (open+stat+seek+read+close): ~330 µs (30%)
- ネットワーク経路 (WSL2 ↔ Windows): 数百 µs

server 側 file handle pool (途中検討、ADR 不記載で revert) は外部 mutation で stale read を返すリスクがあり採用見送り。**client 側で「per-IRP の HTTP 回数を減らす」アプローチが残された選択肢**。

### Samba 流の発想

SMB1/2 の opportunistic prefetch (Samba `read raw` / OpLock-driven readahead) と同じ構造:

1. IRP Read 到着
2. **要求サイズの 2x をサーバに request** (Range header)
3. response の前半を IRP 返却に使う
4. 後半を per-handle cache に格納 (range 情報付き)
5. 次 IRP が cache の先頭から始まれば即 cache 返却 + cache 削除 (single-use)

### 設計

#### per-handle storage

```csharp
private byte[]? _prefetchBuffer;   // ArrayPool.Shared.Rent
private int _prefetchStart;        // buffer 内 offset
private long _prefetchOffset;      // 論理 file offset (= 次に sequential なら一致)
private int _prefetchLength;       // 有効 byte 数
private readonly object _prefetchGate = new();
```

`ServerHandle` (`ServerBackend` 内 sealed class) のフィールドとして保持。1 entry のみ (multi-entry 化は単複雑度割に効果薄、Samba 1-entry が範例)。

#### Single-use semantics

- **hit**: cache を dest にコピー → `ArrayPool.Return` → null 化
- **miss**: 既存 cache があれば Return してから新規格納
- **write**: `InvalidatePrefetch` (= Return + null + streak リセット)
- **dispose**: 同上

partial hit (cache に EOF を含む等で `requested` 未満しか返せない場合) でも残りは捨てる。caller (kernel) は不足分を次 IRP で求めてくるので integrity は保たれる。

#### Sequential pattern detection (option B)

「常時 2x prefetch」は RND workload で純粋に bandwidth 浪費 (実測 RND 4K で -10〜-15% throughput regression)。これを回避するため:

```csharp
private long _lastReadEnd = -1;
private int _seqStreak;
private const int SeqStreakThreshold = 3;

// 各 ReadAsync 入口で呼ぶ
sequential = (_lastReadEnd >= 0 && _lastReadEnd == offset);
_seqStreak = sequential ? _seqStreak + 1 : 1;
_lastReadEnd = offset + length;
armed = _seqStreak >= SeqStreakThreshold;
```

`armed=false` のときは旧来の zero-copy 直接 fetch 経路に落ち、prefetch を一切発行しない。**実機計測で RND phase 中 armed=0%、prefetch 発行数=0** を確認 (diag instrumentation で 1024 IRP ごとに集計、後に削除)。

threshold = 3 は「RND で偶然 3 連続 sequential が立つ確率を抑える最小値」かつ「SEQ workload の warm-up コストを抑える」バランス。

#### MaxPrefetchSize = 256KB

- **single-use semantics** のため cache は「次 1 IRP 分」しか hit に使われない
- cap を IRP × 2 より大きくしても余剰 byte は捨てられるので意味が薄い (実測: 256KB → 512KB で SEQ 128K Q=32 = +2% のみ)
- SEQ 1M Q=8 のように **IRP が cap 超え** だと `prefetchLen <= fetchLen` の zero-copy 分岐に落ち、prefetch path をスキップ (1MB IRP × 2 = 2MB の浪費は割に合わないという判断)
- メモリ占有: 16 handle × 256KB = 最大 4MB (許容範囲、`ArrayPool.Shared` から)

#### Stampede (v1 受容)

並列 IRP (Cache Manager 2-outstanding の枠で同時着弾する) は両方 miss → 両方 prefetch → 後者が cache に勝つ、前者の prefetch は捨てられる。実測 SEQ phase で hit 率 ~37% (理論 50% に対し、stampede ロスが ~13pt)。in-flight prefetch tracker で改善可能だが v1 では未実装。

### 計測 (実機 CDM Read-only, Windows 11 + WSL2 server)

| Read pattern | baseline | 採用後 | 増減 |
|---|---|---|---|
| SEQ 128K Q=32 | ~115 MB/s | ~158 MB/s | **+35〜40%** |
| SEQ 1M Q=8 | ~352 MB/s | ~350 MB/s | ~0% (IRP > cap、prefetch skip) |
| RND 4K Q=32 T=16 | ~2.5 MB/s | ~2.3 MB/s | -8% (noise band) |
| RND 4K Q=1 T=1 | ~4.5 MB/s | ~3.9 MB/s | -13% (noise band) |

**diag log で「RND phase 中 armed=0% / prefetch 発火ゼロ」を直接確認**した。RND の数 % 変動は CDM variance band 内 (同 setup の反復で 17% spread を観測)。

### Trade-off 整理

| 観点 | 評価 |
|---|---|
| SEQ 128K Q=32 (主目的) | +35〜40%。kernel の per-IRP HTTP RTT 律速を半分にできた |
| SEQ 1M | 効果なし (IRP > cap で path skip) — 必要なら cap を上げる議論余地 (帯域浪費との trade-off) |
| RND | sequential detection で実質 disable、regression なし (noise band) |
| 並列 IRP stampede | 約 13pt の hit ロス、v1 受容 |
| 同 handle Read+Write の整合性 | Write 後に `InvalidatePrefetch()` で stale 防止 |
| メモリ | 16 handle × 256KB = 最大 4MB、`ArrayPool.Shared` 経由で短命 |
| 外部 mutation | client 側 cache なので mikura API 外の変更は影響しない (server 側 fd pool と異なり安全) |

### 採用しなかった代案

- **server 側 file handle pool**: 外部 mutation で stale read を返すリスク、mutation hook 全網羅の実装規律負債が永続化するため revert
- **ReadCoalescer (multi-range GET)**: ADR-027 の per-handle 2-outstanding 制約で batch 効率が天井 2x、QD=1 のレイテンシ追加コストに見合わず
- **HTTP/2**: ADR-028 で実装コスト対比 SEQ Read への効果限定的と判断、見送り済み
- **always-2x (sequential detection なし)**: RND で -12〜-15% regression、option B (本 ADR) で回避

### 関連 ADR / コード

- 前提: ADR-021 (WinFsp 移行)、ADR-025 (range-based fetch)、ADR-027 (per-handle 2-outstanding 制約)、ADR-028 (HTTP/2 見送り)
- 関連: `bench:diag-rtt` の (6)(7)(8) Read 経路診断 (本実装の意思決定根拠)
- 実装: [`ServerBackend.ReadAsync`](../client/src/Mikura.Core/Sync/ServerBackend.cs) + `ServerHandle` の `_prefetch*` 系 + `NoteReadAndCheckArmed` / `TryConsumePrefetch` / `StorePrefetch` / `InvalidatePrefetch`
