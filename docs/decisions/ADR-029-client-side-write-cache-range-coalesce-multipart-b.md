## ADR-029: Client-side write cache — range-coalesce + multipart/byteranges + per-path session sharing

**Decision**: Replace ADR-025's per-IRP PATCH passthrough scheme with a 3-layer write cache:

1. **WriteCoalescer**: range-pack kernel `Write` IRPs into a 4MB buffer to aggregate into 1 PATCH
2. **multipart/byteranges PATCH**: proprietary extension to send multiple non-contiguous ranges in 1 request
3. **per-path SessionSlot**: share upload sessions across multiple handles to the same path (refcount + TCS pattern)

### Background

ADR-025 adopted "directly stream kernel `Write` IRPs as PATCH in place", but under actual operational load, 3 problems surfaced:

1. **Per-IRP PATCH HTTP round-trip overhead**: WinFsp issues many IRPs typically 64KB-1MB. Even CDM SEQ 1M Q=8 Write lines up thousands of PATCHes in a near-serial fashion
2. **Insufficient aggregation of small random writes**: Sporadic writes from Excel / SQLite / CDM RND 4K hit 1 IRP = 1 PATCH = 1 round-trip, generating hundreds of small PATCHes
3. **Session duplication across handles to the same path**: When CDM RND 4K Q=32 T=**16** opens 16 file handles, each ServerHandle independently calls `StartUploadAsync(baseFromExisting=true)`, saturating server disk with **16 × 1GB base copies** (measured ~300 MB/s × 53 seconds) and eating up the measurement window

(3) has the largest impact and is the root cause of CDM RND 4K Q=32 T=16 Write producing the catastrophic number **0.007 MB/s**.

### Design

#### Layer 1: WriteCoalescer (range-list buffer)

One per SessionSlot (= per path), not per ServerHandle. When kernel IRP arrives:

```
buf: byte[4MB]                          // ArrayPool shared
ranges: List<(FileOffset, BufOffset, Length)>
```

- Copy IRP payload to the end of `buf` from `_bufFilled` position
- If contiguous with the previous range on file offset (`last.FileOffset + last.Length == fileOffset`), extend the range (merge); otherwise append a new range
- Flush on buffer full (4MB) / `MaxRanges` (4096) / idle timeout (50ms)

On flush:

- 1 range only → single-range PATCH (`UploadChunkAsync`, avoids multipart overhead)
- N ranges → multipart/byteranges PATCH (`UploadChunksMultipartAsync`)

A single IRP that exceeds the target size (≥4MB) is forwarded as a single-range PATCH without coalescing.

**N-deep pipeline (N=4)**: At flush, take a slot from `SemaphoreSlim(4, 4)` and send in a background `Task`. The slot is released on send completion. Up to 4 PATCHes can be in-flight simultaneously. Resolves the asymmetry where the read path was using HttpClient's `MaxConnectionsPerServer=8` parallelism to reach 342 MB/s while serial-PATCH Write hit a 80 MB/s ceiling.

Ordering guarantee: within a buffer, by range list order; across buffers, submitted in flush order, but server arrival order is not guaranteed. Since HTTP/1.1 multi-connection puts 4 requests on different TCP connections, completion order depends on network. Real server's seek+write is fd-independent, so **non-overlapping ranges are fine**, overlaps follow **last write wins** = same semantics as ADR-025's old ChunkedUploader parallel workers.

#### Layer 2: Adopting multipart/mixed as request body

To send multiple ranges in 1 PATCH, use RFC 2046 §5.1.3's `multipart/mixed` (generic multipart container) as the request body. Each part has a `Content-Range` header representing a write to the corresponding file offset.

**Format**:
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

- **Server side**: streaming parser in `server/src/util/multipartRanges.ts` (media-type agnostic). Extract `(offset, length)` from each part's `Content-Range`, stream body itself to sink (Deno.write per chunk) without RAM expansion
- **Client side**: `System.Net.Http.MultipartContent("mixed", boundary)` works as-is. Slice the coalescer's 4MB buffer with `ReadOnlyMemoryContent` to create parts — zero-copy

**Per-part overhead**: ~110B (boundary + Content-Type + Content-Range + 2× CRLF). Ratios in practical cases:

| Workload | Range count | Payload | Overhead |
|---|---|---|---|
| SEQ 1M (after contig merge) | 1 | 4MB | 0% (single-range path) |
| CDM RND 4K Q=32 batched | 64 | 256KB | 2.7% |
| Excel sparse save batched | 16 | 200KB | 0.9% |

**Selection process for media type**: HTTP standard does not specify multi-range writes in request body, so 3 options were considered:

1. **Proprietary multi-range Content-Range value** (`Content-Range: bytes 0-30,45-50/*`): Minimal wire format, but outside HTTP spec. L7 WAFs may judge as malformed (real examples on Cloudflare backend etc.). **Rejected**
2. **Reusing `multipart/byteranges`** (RFC 7233 §A) **as request body**: Initial design proposal. Content-Range per part semantics are clearly specified in RFC 7233 §A as a strength, but **the IANA registry entry explicitly states "This media type is not generally useful outside the context of HTTP messages with the response status code 206"**, deviating from the intended use (206 response). Both ends are mikura so it works, but leaving a design that contradicts the registry description becomes explanation debt for future reverse proxy operation or external audit. **Rejected**
3. **`multipart/mixed`** (RFC 2046 §5.1.3): Just defines as a generic multipart container that "the body parts are independent and need to be bundled in a particular order", with no direction or use restriction. Content-Range per part is an ad-hoc application-level extension for this media type, but since PATCH standard does not have a concept of multiple ranges, this is unavoidable in any option. **Adopted**

Chose (3). The media type itself has no direction restriction, so it doesn't conflict with the IANA registry and is correct as the generic multipart semantics. The Content-Type starting with `multipart/` is unchanged from (2), so WAF/proxy traversability benefits are the same.

#### Layer 3: per-path SessionSlot (refcount + TCS)

Same pattern as ADR-016/022's `LockSlot`:

```csharp
class SessionSlot {
    int Refcount
    string UploadId         // filled by first caller via StartUpload
    WriteCoalescer Coalescer
    TaskCompletionSource<bool> StartResult   // 2nd and later Acquire awaits this
    long MaxFinalSize        // max of all handles' h.Length
    bool AnyModified
}

Dictionary<string, SessionSlot> _activeSessions   // path keyed
```

- `AcquireSessionSlotAsync(path, baseFromExisting)`: Only the first caller actually runs `StartUploadAsync`. Subsequent callers await `StartResult.Task` and share the same slot
- `EnqueueChunkAsync`: Calls `slot.Coalescer.AppendAsync` (appends to 1 buffer shared by all handles)
- `ReleaseSessionSlotForFinalizeAsync`: refcount-- → only when reaching 0 (= last handle), actually runs `Flush` + `FinalizeUploadAsync`. Otherwise returns `null`, and the caller (`CleanupAsync`) skips `_tree` update
- `ReleaseSessionSlotForAbortAsync`: similarly, actual abort only when refcount-- → 0

**Mixed baseFromExisting** (1 handle does `CreateAsync`, another does `OpenAsync` for write) **adopts the first caller's judgment**. Practically, all 16 simultaneous opens have the same intent so there's no impact. In the unlikely mixed case, the first caller's `baseFromExisting=true` is adopted and the 1GB copy runs only once.

### Measurements (CDM 9.0.2, 1 GiB×3, WSL2 LAN, Release build)

|  | ADR-025 baseline | ADR-029 1-deep | ADR-029 4-deep (adopted) |
|---|---|---|---|
| SEQ 1M Q=8 Write | 80 MB/s | 81 MB/s | **120 MB/s** |
| SEQ 128K Q=32 Write | 54 MB/s | 76 MB/s | **108 MB/s** |
| **RND 4K Q=32 T=16 Write** | **0.007 MB/s** | 22.6 MB/s | **51 MB/s** |
| RND 4K Q=1 T=1 Write | 16.7 MB/s | 21.8 MB/s | **50 MB/s** |
| SEQ 1M Q=8 Read | 326 MB/s | 342 MB/s | 301 MB/s |
| RND 4K Q=32 T=16 Read | 2.33 MB/s | 2.57 MB/s | 2.51 MB/s |

Client process resident memory (during RND Q=32 Write):
- baseline: ~300 MB
- 1-deep (session-sharing only): ~50 MB
- 4-deep pipeline: ~114 MB (+64 MB)

The +64 MB memory increase is the sum of 4 in-flight buffers (~16 MB) + MultipartContent serialize intermediate + HttpClient per-connection send buffer. **Reasonable as a trade against 2.2x throughput improvement for RND / 1.4x for SEQ 128K**.

### Dominant factors per stage (important)

Isolating the contribution of each layer:

1. **Per-path session sharing** is **the ~3000x dominant factor for RND Q=32** (0.007 → 22.6). Without it, the measurement window is filled with baseFromExisting copy, and other optimizations can't even be observed
2. **range-coalesce + multipart** alone gives only about +40% on SEQ 128K. Only effective when combined with session sharing
3. **N-deep (1→4) pipeline** adds another **2.2x**. With 1-deep, WriteCoalescer used only 1 of MaxConnectionsPerServer=8, and the asymmetry with the read path (8 parallel GET = 342 MB/s) was an invisible ceiling on SEQ Write

### Residual ceiling (~120 MB/s)

Even at 4-deep, SEQ 1M Write hits a ceiling at ~120 MB/s. Server-side disk produces ~300 MB/s on actual hardware, so remaining candidates are:

- **WSL2 networking write-direction bandwidth** (Read 342 MB/s vs Write 120 MB/s asymmetry)
- **Deno.serve async I/O thread pool cap** (file.write serialized through pool)
- **Reviving HTTP/2 stream multiplex** (re-evaluation of ADR-028. The "-80%" verified in the 1-deep era was **premised on per-IRP PATCH structure**, so worth re-measuring under 4MB chunk + N-deep pipeline regime)

Priority is decided by the resumption conditions of ADR-028 and re-running this ADR's measurements.

### Rejected alternatives

- **Proprietary multi-range Content-Range value** (`Content-Range: bytes 0-30,45-50/*`): Minimal wire format, but outside HTTP spec, with unclear WAF/proxy traversability
- **Reusing `multipart/byteranges` as request body**: Shelved due to conflict with IANA registry usage restriction (not generally useful outside 206 response). See the "Selection process for media type" section for details
- **Per-thread / global cache**: Holding SessionSlot per thread / process global instead of per-path. Session lifecycle (start/finalize/abort) synchronization becomes complex, and in cases where Cleanup order and finalize order differ, _tree consistency cannot be maintained. per-path is sufficient
- **Deeper pipeline with MaxInFlight=8 or more**: Memory consumption increases proportionally, but if the SEQ 1M 120 MB/s ceiling is on the server / WSL2 side, the effect is thin. HTTP/2 verification takes precedence

### Related ADRs

- Prerequisite: ADR-025 (the chunked upload session wire protocol itself is reused)
- Prerequisite: ADR-016/022 (LockSlot pattern reused for SessionSlot)
- Related: ADR-028 (if HTTP/2 is unlocked, SEQ Write ceiling may be raised)
