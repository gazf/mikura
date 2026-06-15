## ADR-023: Design and ceiling of the in-memory staging buffer

**Decision**: Data of in-progress edits is **staged in-memory in a per-handle `byte[]` buffer**. The buffer is rented from `ArrayPool<byte>` and grown by capacity-doubling. Accept the **per-file <= 2GB constraint** (`int.MaxValue` limit). Anything beyond will be handled by ADR-024.

**Design**:

```
ServerHandle
├─ byte[] _buffer       (ArrayPool rental, capacity)
├─ long _length         (logical content length <= buffer.Length)
├─ bool _bufferRented   (whether to return)
├─ EnsureCapacity(N)    (doubling growth, Rent -> BlockCopy -> Return old)
├─ EnsureHydratedAsync  (single-alloc fetch from server)
└─ DropBuffer           (Return at Cleanup)

ArrayPool<byte>.Create(maxArrayLength: 32MB, maxArraysPerBucket: 8)
   ^ shared across all ServerHandles; reuse suppresses LOH garbage accumulation
```

**Memory profile** (measured trajectory on a 10MB file copy):

| Stage | resident memory |
|---|---|
| Initial (`new byte[newLength]` per Write, O(N^2) alloc) | ~120 MB |
| Capacity-doubling introduced | ~96 MB |
| Hydrate changed from MemoryStream+ToArray to single alloc | ~59 MB |
| ArrayPool rental | ~30 MB (bounded to ~84 MB with 8 parallel file copies) |

**Key implementation points**:

1. **Leverage SetFileSize(allocationHint=true) to preallocate**
   The shell's CopyFileEx calls `SetEndOfFile(N)` before writes. Wiring this directly to `EnsureCapacity(N)` avoids the intermediate byte[] garbage (~16MB worth) from staged doubling-resize, and secures the final size in one go.

2. **Zero-fill the gap in WriteAsync**
   ArrayPool-rented byte[] is **not zero-cleared** (the prior renter's data remains). When the kernel issues a non-sequential write and a gap forms at `[existingLen..writeOffset)`, failing to explicitly zero it with `Array.Clear` causes confidential data from another handle to be uploaded as-is (security / consistency issue).

3. **Pool the per-IRP marshal buffer in WinFsp callbacks with `ArrayPool<byte>.Shared`**
   The intermediate buffer for `IntPtr <-> byte[]` (typically 4-64 KB) in `MikuraFileSystem.Read` / `Write` was `new byte[length]` every time; switched to ArrayPool rental to eliminate per-IRP allocation.

**Ceiling and trade-offs**:

- **2GB per file** (`OverflowException` at `int.MaxValue`)
- **One file's size ~ client memory** (between handle open and close)
- Concurrent ops x file size is the order of memory footprint
- Sufficient for LAN office usage (files of a few MB to tens of MB)
- Large files (GB class) will be addressed separately in ADR-024

**Known limitations (to disclose before operation)**:

- Files over 2GB cannot currently be uploaded
- Sending a 1GB file requires process memory ~= 1GB
- One file = one PUT request; on disconnect, resends from the start
- Progress display, resume, parallel chunked upload all unsupported

**Implementation location**:

- `ServerHandle` class, `EnsureCapacity` / `EnsureHydratedAsync` / `WriteAsync` / `DropBuffer` in `client/src/Mikura.Core/Sync/MikuraServerBackend.cs`
- ArrayPool-ization of `Read` / `Write` callbacks in `client/src/WinFsp.Interop/MikuraFileSystem.cs`

**Related ADRs**:

- Premise: ADR-021 (WinFsp migration; no kernel cache, staging in user-mode buffers)
- Extension: ADR-024 (chunked / resumable upload for GB-class files)

---
