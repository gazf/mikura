## ADR-031: Per-handle read-ahead prefetch cache for the read path (Samba-style next-sequential)

**Decision**: Introduce a **per-handle 1-entry speculative prefetch cache** in `ServerBackend.ReadAsync`. For each IRP, fetch 2x the requested byte count from the server (capped at 256KB), return the IRP-requested portion, and retain the surplus as 1 entry per handle. If the next IRP starts at the head of the cache (= sequential continue), return with zero round-trip. Combined with **sequential pattern detection (armed after 3 consecutive reads)**, the design avoids issuing prefetch for RND workloads.

### Background

Due to the **Windows Cache Manager's per-handle 2-outstanding constraint** documented in ADR-027, `CDM RND 4K Q=32 T=16 Read` structurally hits a parallelism ceiling, and HTTP/2 migration considered in ADR-028 was already shelved due to implementation cost. Meanwhile, medium-grain SEQ workloads like **SEQ 128K Q=32 Read** are bottlenecked by per-IRP HTTP RTT as the dominant rate-limiter, and there's room for improvement by reducing IRP count itself.

Breakdown of `bench:diag-rtt` (7) (`GET /content` 4K Range cache hit) ~860 µs/req:

- Pure HTTP route + auth: ~530 µs (50%)
- Server file ops (open+stat+seek+read+close): ~330 µs (30%)
- Network path (WSL2 ↔ Windows): several hundred µs

Server-side file handle pool (considered in passing, not documented in ADR, reverted) carries the risk of stale read on external mutation, and was shelved. **The remaining option is a client-side approach to "reduce per-IRP HTTP count"**.

### The Samba-style idea

Same structure as SMB1/2 opportunistic prefetch (Samba `read raw` / OpLock-driven readahead):

1. IRP Read arrives
2. **Request 2x the requested size from the server** (Range header)
3. Use the first half of the response for IRP return
4. Store the second half in per-handle cache (with range info)
5. If the next IRP starts at the head of the cache, return cache immediately + delete cache (single-use)

### Design

#### Per-handle storage

```csharp
private byte[]? _prefetchBuffer;   // ArrayPool.Shared.Rent
private int _prefetchStart;        // offset within buffer
private long _prefetchOffset;      // logical file offset (= matches next if sequential)
private int _prefetchLength;       // valid byte count
private readonly object _prefetchGate = new();
```

Held as fields of `ServerHandle` (sealed class within `ServerBackend`). Only 1 entry (multi-entry is excessive complexity for thin gain, Samba 1-entry as precedent).

#### Single-use semantics

- **hit**: copy cache to dest → `ArrayPool.Return` → nullify
- **miss**: if existing cache exists, Return before new storage
- **write**: `InvalidatePrefetch` (= Return + null + streak reset)
- **dispose**: same as above

Even on partial hit (when cache can only return less than `requested`, e.g., contains EOF), the rest is discarded. The caller (kernel) requests the deficit on the next IRP, so integrity is preserved.

#### Sequential pattern detection (option B)

"Always 2x prefetch" is pure bandwidth waste on RND workloads (measured -10 to -15% throughput regression on RND 4K). To avoid this:

```csharp
private long _lastReadEnd = -1;
private int _seqStreak;
private const int SeqStreakThreshold = 3;

// called at the entrance of each ReadAsync
sequential = (_lastReadEnd >= 0 && _lastReadEnd == offset);
_seqStreak = sequential ? _seqStreak + 1 : 1;
_lastReadEnd = offset + length;
armed = _seqStreak >= SeqStreakThreshold;
```

When `armed=false`, fall back to the legacy zero-copy direct fetch path and issue no prefetch at all. **Confirmed armed=0% / prefetch issued=0 during RND phase on actual hardware** (aggregated every 1024 IRPs via diag instrumentation, later removed).

Threshold = 3 is the balance between "minimum value to suppress coincidental 3-consecutive-sequential probability in RND" and "suppressing warm-up cost on SEQ workloads".

#### MaxPrefetchSize = 256KB

- Due to **single-use semantics**, cache is only used for "next 1 IRP" hit
- Raising cap beyond IRP × 2 is meaningless since surplus bytes are discarded (measured: 256KB → 512KB gives only +2% on SEQ 128K Q=32)
- For cases where **IRP exceeds cap** like SEQ 1M Q=8, falls into the `prefetchLen <= fetchLen` zero-copy branch and skips prefetch path (judging that 2MB waste from 1MB IRP × 2 is not worth it)
- Memory footprint: 16 handles × 256KB = max 4MB (acceptable range, from `ArrayPool.Shared`)

#### Stampede (v1 accepted)

Parallel IRPs (arriving simultaneously within the Cache Manager 2-outstanding window) both miss → both prefetch → the latter wins the cache, the former's prefetch is discarded. Measured hit rate ~37% in SEQ phase (vs theoretical 50%, ~13pt stampede loss). Improvable with in-flight prefetch tracker, but not implemented in v1.

### Measurements (actual CDM Read-only, Windows 11 + WSL2 server)

| Read pattern | baseline | after adoption | delta |
|---|---|---|---|
| SEQ 128K Q=32 | ~115 MB/s | ~158 MB/s | **+35 to 40%** |
| SEQ 1M Q=8 | ~352 MB/s | ~350 MB/s | ~0% (IRP > cap, prefetch skip) |
| RND 4K Q=32 T=16 | ~2.5 MB/s | ~2.3 MB/s | -8% (noise band) |
| RND 4K Q=1 T=1 | ~4.5 MB/s | ~3.9 MB/s | -13% (noise band) |

**Directly confirmed "armed=0% during RND phase / zero prefetch firing" via diag log**. RND's several-% variation is within CDM variance band (17% spread observed in repeats of the same setup).

### Trade-offs

| Aspect | Evaluation |
|---|---|
| SEQ 128K Q=32 (main goal) | +35 to 40%. Halved kernel per-IRP HTTP RTT rate-limit |
| SEQ 1M | No effect (IRP > cap, path skipped) — room to discuss raising cap if needed (trade-off with bandwidth waste) |
| RND | Effectively disabled by sequential detection, no regression (noise band) |
| Parallel IRP stampede | ~13pt hit loss, v1 accepted |
| Same-handle Read+Write consistency | `InvalidatePrefetch()` after Write prevents stale |
| Memory | 16 handles × 256KB = max 4MB, short-lived via `ArrayPool.Shared` |
| External mutation | Client-side cache, so changes outside mikura API don't affect (safe, unlike server-side fd pool) |

### Rejected alternatives

- **Server-side file handle pool**: Risk of stale read on external mutation, with permanent implementation discipline debt to cover all mutation hooks; reverted
- **ReadCoalescer (multi-range GET)**: ADR-027's per-handle 2-outstanding constraint caps batch efficiency at 2x, doesn't justify additional latency cost at QD=1
- **HTTP/2**: ADR-028 already judged limited effect on SEQ Read vs. implementation cost; shelved
- **always-2x (without sequential detection)**: -12 to -15% regression on RND, avoided by option B (this ADR)

### Related ADRs / code

- Prerequisite: ADR-021 (WinFsp migration), ADR-025 (range-based fetch), ADR-027 (per-handle 2-outstanding constraint), ADR-028 (HTTP/2 shelved)
- Related: `bench:diag-rtt` (6)(7)(8) Read path diagnostics (basis for this implementation's decisions)
- Implementation: [`ServerBackend.ReadAsync`](../client/src/Mikura.Core/Sync/ServerBackend.cs) + `ServerHandle`'s `_prefetch*` family + `NoteReadAndCheckArmed` / `TryConsumePrefetch` / `StorePrefetch` / `InvalidatePrefetch`
