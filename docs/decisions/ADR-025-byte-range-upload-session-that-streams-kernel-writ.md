## ADR-025: Byte-range upload session that streams kernel writes through directly

**Decision**: Switch the WinFsp `Write` callback path to a pass-through structure that **does not accumulate `(offset, size, data)` from the kernel into a per-handle in-memory buffer, but instead streams it to the server-side upload session as successive PATCHes**. Since mikura targets handling GB-class files as a Samba replacement, the ADR-023 constraint of "file size ≒ client memory" is not practically acceptable, and this ADR resolves it structurally.

**Stance change**: The original ADR was "consider later" / "not implemented", but for mikura's target requirements (Samba replacement, general-purpose file server), large files are a first-class use case and the current in-memory staging approach is judged unworkable. Promoted to **implement in the next phase**.

**Motivation (Known limitations carried over from ADR-023)**:

- Memory footprint ≒ file size (breaks at GB class)
- `OverflowException` past 2GB
- Resend from the head on mid-transfer disconnect
- No progress display
- Hits HttpClient's 100-second timeout on slow links

Root cause: the current `UploadFileAsync` is "a single PUT that passes the entire file as a MemoryStream", so **to serialize the kernel's random writes into a sequential body, the whole buffer must be held**. With a byte-range PATCH-style protocol, WinFsp `Write(offset, data)` can be forwarded as-is to `PATCH /uploads/:id/:offset`.

### Core design decision — pass-through structure

When a WinFsp `Write` callback arrives, issue a `PATCH` to the upload session bound to the handle and return immediately. **Do not accumulate on the handle side**. As a result:

- The handle's memory footprint no longer scales with the file size (only the in-flight chunk)
- The 2GB constraint disappears (int.MaxValue was a constraint of the in-memory buffer)
- Ordering preservation for random writes is handled by the server temp file's `seek + write` (naturally)

The ADR-023 in-memory staging is **kept only for the read path** (whole-file hydrate on Read). The write path is entirely rewritten by this ADR.

### Protocol

| Endpoint | Role |
|---|---|
| `POST /uploads` body: `{ path }` | Create upload session, return `{ uploadId }`. Unique by `(deviceId, path)`. 403 if it doesn't match the lock holder |
| `PATCH /uploads/:uploadId` Header: `Content-Range: bytes <off>-<end>/<*>` body: bytes | Chunk write to arbitrary offset. Server-side `seek + write` to temp file |
| `POST /uploads/:uploadId/finalize` body: `{ size }` | `ftruncate(size)` → atomic rename of temp into real path → `/tree` update → return `UploadResult` |
| `DELETE /uploads/:uploadId` | Discard (cancel / Cleanup without Modified) |
| `HEAD /uploads/:uploadId` | Return current max written offset for resume (future) |

KV schema:

```typescript
["uploads", uploadId] → {
    uploadId: string,        // UUID v4
    deviceId: string,        // ADR-018: lock holder's deviceId
    userId: number,
    path: string,
    tempPath: string,        // <STAGING_ROOT>/<uploadId> (outside storage, see below)
    createdAt: string,
    expiresAt: string,       // synchronized with lock TTL
}
```

### TBD resolutions (settled in this revision)

**1. TTL management of temp file**

- Align the upload session TTL with **the ADR-018 Liveness lock TTL (30 seconds)** and extend it via WSS heartbeat
- When a lock expires, automatically abort all upload sessions held by that deviceId (delete temp file)
- By not having a dedicated TTL, "session is alive while lock is alive" and "lock expiry = session expiry" become the SSOT, and orphan uploads are structurally impossible

**2. Atomicity of finalize and placement of temp**

- `temp → real path` is atomic within the same filesystem via `Deno.rename` (POSIX `rename(2)` compliant)
- Place the temp area in `STAGING_ROOT` (default `cwd/staging`, overridable via `MIKURA_STAGING_ROOT`) as a **sibling of `DATA_ROOT`**. **Do not place it inside `DATA_ROOT`**:
  - Placing it inside leaks the "filter the internal path every time" responsibility across all surfaces — `/tree`, `listDirectory`, `Deno.watchFs` — and becomes maintenance debt that requires the same filter every time an API is added later
  - When containerized (Docker / k8s), we want to **separate volume persistence granularity** between data (persistent) and staging (fine to lose on restart, fine to use tmpfs). Can't choose if they share a directory
  - Naming follows the connotation from DB / data pipelines as "the place where things are staged before commit". `tmp` / `cache` are avoided because they incorrectly imply disposability (fine to delete)
- Same-FS constraint: with the default that places both roots directly under `cwd`, they're on the same FS. If env separates them to different mounts, `Deno.rename` may return `EXDEV`, leaving room to detect at startup or finalize and fall back (copy + unlink, atomicity is lost but only at finalize once). Not implemented at this point, to be addressed when the requirement arises
- Cross-device support is deferred as a future requirement (operating on Linux cluster FS is not currently anticipated)

**3. Permission check**

- checkPermission + lock holder match check **only once at `POST /uploads` (start)**
- Subsequent PATCH/finalize match against `(uploadId, deviceId)` bound to the session (authenticate, but don't re-evaluate authorization)
- Race when permission is revoked mid-upload is settled with "reject at next open / lock acquire" (SMB behaves the same)

**4. Client async pipelining**

WinFsp `Write` callbacks are synchronous per IRP. Waiting for PATCH completion in each callback accumulates RTT even on LAN.

Adopted design:

- A queue of **up to N=8 in-flight chunks** per handle
- WinFsp `Write` arrives → enqueue + return immediately (`Write` return value = bytes received)
- A background task pulls from the queue and issues PATCHes sequentially (**N concurrent in parallel**)
- Only when the queue is full does the kernel `Write` block (natural backpressure)
- `Cleanup(Modified)` → "wait for queue drain → finalize", `Cleanup(without Modified)` → "cancel queue → DELETE"
- If any PATCH fails, subsequent Writes return failure immediately (put the handle in a broken state and notify upstream)
- Overwrite to the same offset is fine as simple last-write-wins via the server's `seek+write` (WinFsp is not designed to send the same offset in parallel)

**5. Whether to have a threshold**

- **Remove the threshold**, send all files via the upload session
- Reason for removal: maintaining two paths is not worth "saving 2 RTT for small files", and coalescing small writes makes the practical latency difference small
- 0-byte file (touch) completes in 2 calls: `POST /uploads` → `POST /uploads/:id/finalize { size: 0 }`
- Leave room to revive "single PUT fast path" as a fallback after benchmarking

### Expected effects

| Aspect | Current (single PUT) | Revised (range PATCH passthrough) |
|---|---|---|
| Client memory (sending 1GB file) | ~1GB | **~N × chunk size** (several MB to tens of MB) |
| Maximum file size | ~2GB | **Unlimited** (int64 offset) |
| Progress display | Impossible | Possible (each PATCH is progress) |
| Resume | Impossible | Possible (check via `HEAD /uploads/:id` → continue) |
| WinFsp `Write` latency | Same as above | Actual IO wait only on queue receipt |
| Industry precedent | — | tus.io / S3 multipart / Azure Block Blob |

### Chunk size

WinFsp `Write` callback length is typically 64 KB to 1 MB (from IRP, kernel decides). Match this directly with the server send unit (no client-side coalescing).

Server / 1 PATCH overhead is on the order of ~10ms, so 1 GB / 64 KB chunk = 16,384 req → with in-flight 8 parallel, 16,384 / 8 × 10ms ≒ 20 seconds cumulative. This is within an acceptable range relative to LAN physical bandwidth (1 Gbps for 1GB ≒ 10 seconds).

When tuning in the future, introduce "coalesce consecutive writes within the same chunk" on the client side, but not in the initial implementation.

### Implementation notes — `System.Buffers` / `System.IO.Pipelines` / `System.Threading.Channels`

The write side is "N-parallel send of random-offset chunks, producer-consumer", while the read side is "sequential stream consumption" — different in nature, so use tools that fit each.

**Write path (the focus of this ADR)**:

- The in-flight queue is **`System.Threading.Channels.Channel<UploadChunk>`** (bounded capacity = N=8, `BoundedChannelFullMode.Wait` for natural backpressure). Pipe is sequential and unsuited for a chunk sequence of random offsets; Channel is natural.
- `UploadChunk` payload is **rented from `ArrayPool<byte>.Shared`** (`System.Buffers`). On WinFsp `Write` receipt: rent → copy → enqueue; consumer calls `Return(buffer, clearArray: false)` after PATCH send completes. To avoid sharing the same ArrayPool with the ADR-023 hydrate path, prepare a separate chunked-dedicated `ArrayPool<byte>.Create(maxArrayLength: 4 * 1024 * 1024, maxArraysPerBucket: 16)`.
- Send the PATCH HTTP body as **`ReadOnlyMemoryContent(rentedMemory)`** (`StreamContent(MemoryStream)` adds unnecessary wrapping).

**Read path consideration result (PipeReader migration rejected)**:

At implementation start, considered replacing `EnsureHydratedAsync` with `PipeReader.Create(stream)`, but judged that **the current implementation has lower overhead** (rejected for the following reasons):

- Current implementation rents the final buffer of known size once with `_bufferPool.Rent(expectedSize)` and **writes directly** into `_buffer.AsMemory(off, len)` from the return value of `HttpContent.ReadAsStreamAsync` (zero intermediate buffer)
- Interposing PipeReader introduces an internal segment (from MemoryPool) as a new intermediate layer, causing additional copies from segment → final buffer
- expectedSize is known from `_entry.Size`, so the "dynamically expand buffer" advantage of Pipelines doesn't kick in

PipeReader shines for "incrementally consuming a sequential stream of unknown size", which doesn't fit this feature (Read IRP is random offset, whole-file is required).

Instead, we made a symmetric improvement by **connecting server-side PATCH receive directly to ReadableStream → `Deno.FsFile.write`** (equivalent memory reduction effect for 8MB chunks).

**Change in buffer model per handle**:

Current (ADR-023): `byte[] _buffer` holds the logical full file length.
Revised write: only `Channel<UploadChunk>` (does not hold full file length, only in-flight portion).
Revised read: `Pipe`'s internal buffer holds only the hydrate progress. Released after the completed range is passed upstream.

This switches the memory footprint per handle from "file size dependent" to "IRP throughput dependent".

### Relation to HTTP/2 (decoupled)

The HTTP/2 migration of ADR-010 is a path optimization independent of this ADR. Even with HTTP/1.1, the N=8 parallel PATCH of this ADR holds via `MaxConnectionsPerServer = 8`. When migrating to HTTP/2, it replaces with N stream multiplexing over 1 TCP/TLS connection, but no change to this ADR's design is needed.

### Related ADRs

- Prerequisite: ADR-021 (WinFsp migration), ADR-023 (in-memory staging — only the write path is superseded by this ADR)
- Linked: ADR-018 (Liveness lock TTL reused as upload session TTL)
- Related: ADR-016 (write lock holder = upload session owner), ADR-026 (lost-update detection via ETag/If-Match is placed at the finalize stage)
