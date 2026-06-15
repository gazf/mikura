## ADR-030: WriteCoalescer ArrayPool selection — adopting bounded `maxArraysPerBucket=16`

**Decision**: The 4MB buffer pool of `WriteCoalescer` uses `ArrayPool<byte>.Create(maxArrayLength: 4MB, maxArraysPerBucket: 16)`. `ArrayPool<byte>.Shared` is not adopted.

### History

Went through 3 stages of trials:

1. **First generation**: `ArrayPool<byte>.Create(4MB, maxArraysPerBucket: 4)`
   - Intent to cap memory at 16 MB
   - **Problem**: In a 16-concurrent session environment like CDM RND 4K T=16, 4 slots are insufficient and 12 sessions fall back to fresh alloc each cycle. In bench:CoalescerBench, RND 4K Q=32 T=16's alloc/op ballooned to 1251 B/op
2. **Second generation (d4b065d → reverted)**: `ArrayPool<byte>.Shared`
   - Initial bench (alloc/op 1251 → 498, -60%) looked like a major improvement
   - **Problem**: .NET 6+ Shared implementation (`TLSCachedArrayPool`) has per-thread cache, and every time the ThreadPool expands, new threads secure their own slots. After 10+ CDM iterations, every thread in the ThreadPool has rented a 4MB buf at least once, and each thread's slot is hard to release even under Gen2 GC trim, so process Working Set grows monotonically with iteration count and doesn't level off (confirmed in user environment: 1 iteration ~150 MB → 10 iterations ~200 MB)
3. **Current (ed6607a)**: `ArrayPool<byte>.Create(4MB, maxArraysPerBucket: 16)`
   - Expand bucket cap to 16, no fallback even with 16 concurrent sessions
   - No per-thread cache, so retain doesn't increase with thread count
   - bucket cap 16 × 4MB = **hard cap at 64 MB**, independent of CDM iteration count

### Measurement results (user environment CDM, stable state after 10 iterations)

| Item | Gen 1 (Create 4-slot) | Gen 2 (Shared) | Current (Create 16-slot) |
|---|---:|---:|---:|
| **Memory Working Set after iterations** | ~150 MB level | **Monotonic growth, no leveling off at 200 MB+** | **Stable at 66 MB (independent of iteration count)** |
| SEQ 1M Write | ~134 MB/s | ~134 MB/s | **~155 MB/s (+16%)** |
| SEQ 128K Write | ~102 MB/s | ~102 MB/s | **~124 MB/s (+22%)** |
| RND 4K Q=32 T=16 Write | ~0.007 MB/s (catastrophic) | ~58 MB/s | ~58 MB/s (equivalent) |
| bench:CoalescerBench RND 4K T=16 alloc/op | 1251 B/op | 498 B/op | 513 B/op |

The SEQ Write improvement is presumed to be the effect of removing overhead from `TLSCachedArrayPool`'s per-thread cache management / `Gen2GcCallback`-mediated trim processing, which was prominent in SEQ 1M's high-frequency rent of 4MB buf (bounded pool is simple Monitor.Enter and predictable).

### Why ArrayPool.Shared is unsuited for long-running workloads

`TLSCachedArrayPool<T>` structure (.NET 6+):
- Per-thread slot: 1 buf cache per thread. Gen2 GC only trims slots whose "recently used flag" is not set
- Shared partition: per-CPU bucket × several slots

In CDM-like patterns of "many threads on the ThreadPool frequently rent/return 4MB buf", every thread's per-thread slot keeps its "recently used flag" set and never becomes a Gen2 GC trim target. Consequently **retain grows in proportion to ThreadPool expansion**.

Bounded `ArrayPool<byte>.Create()` is a `ConfigurableArrayPool<T>` implementation without per-thread cache, exclusively controlling the global bucket with `Monitor.Enter`. Lock contention occurs on concurrent rent, but retain is strictly capped by `bucket count × maxArraysPerBucket × bucket size`. May be slower than Shared in short-burst workloads, but **long-running memory stability is overwhelmingly important**.

### Related fix

- **Coalescer dispose miss in ServerBackend.ReleaseSessionSlotForFinalizeAsync** (17e9208): When FlushAsync threw in the try block, DisposeAsync was skipped, leaving the Coalescer's Timer grounded in the TimerQueue and leaking Coalescer + buf + _inFlightSends Tasks. Fixed to always call DisposeAsync in finally. Not triggered on normal CDM (no HTTP error), but kept as a defensive measure since it can rarely hit on transient HTTP failure / cancel etc.

### Lessons

- **bench:CoalescerBench was a short-lived experiment** that couldn't catch the accumulation of per-thread cache. Only surfaced in long-running patterns (= real CDM)
- When the bench harness is short-lived, bugs in long-lived pool / cache behavior escape. When designing benches, add a scenario that watches "whether retain grows over repeated executions on the same ThreadPool"
- .NET's `ArrayPool.Shared` is convenient for "fire-and-forget casual use", but **retention characteristics become a problem in long-running daemon processes**. Choosing an explicit bounded pool is more predictable

### Related ADRs

- Prerequisite: ADR-029 (WriteCoalescer main design)
- Related: Q/T orthogonal decomposition of `bench:CoalescerBench` (`scenario=rnd4k-scaling`) was useful for discovering pool-related alloc problems

---
