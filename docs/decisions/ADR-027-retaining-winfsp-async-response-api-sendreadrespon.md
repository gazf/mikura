## ADR-027: Retaining WinFsp async response API (`SendReadResponse` family)

**Decision**: Adoption is **shelved** for now. However, the investigation results are recorded as the next option if a parallelism ceiling remains in the Q32 scenario even after read-ahead is implemented.

### Background

In benchmarks like CDM Q32T1 that "issue many parallel IRPs against the same handle", we encountered the **inversion** that observed throughput is Q32T1 (30 MB/s) versus Q1T1 (160 MB/s). A perf-trace of thread distribution in the `BackendFileSystem.Read` callback confirmed that **only 2 threads effectively dispatch** even when `MountEx(ThreadCount=16, Synchronized=false)` is specified.

After bisection, we concluded the bottleneck is not on the WinFsp side but **a design-level cap of the Windows kernel Cache Manager that serializes buffered I/O to per-handle 2 outstanding**. WinFsp `MaxRead` family tuning knobs are not exposed by the .NET binding (`Fsp.FileSystemHost`), increasing Mount/MountEx `ThreadCount` has no effect, and `Synchronized=false` has no effect either.

With those exhausted, as "the last remaining option", we investigated the **async response pattern** using the `GetOperationRequestHint` / `SendReadResponse` / `SendWriteResponse` / `SendReadDirectoryResponse` and `STATUS_PENDING` that exist in the binding.

### API semantics

WinFsp callbacks return values synchronously by default, but **returning `STATUS_PENDING` within a callback puts the operation on hold as "not yet complete", and later calling `Send*Response(hint, status, bytesTransferred)` can notify completion** (calling the native `FspFileSystemSendResponse` from C#).

```csharp
public override int Read(...) {
    var hint = host.GetOperationRequestHint();   // operation ID
    Task.Run(async () => {
        try {
            var n = await _backend.ReadAsync(...);
            Marshal.Copy(...);   // IntPtr buffer is guaranteed live until SendResponse
            host.SendReadResponse(hint, STATUS_SUCCESS, (uint)n);
        } catch (Exception ex) {
            host.SendReadResponse(hint, MapToNtStatus(ex), 0);
        }
    });
    pBytesTransferred = 0;
    return STATUS_PENDING;       // return immediately, release worker thread
}
```

### Expected effects

| Effect | Confidence |
|---|---|
| WinFsp dispatcher worker thread released immediately without waiting for backend HTTP completion | **Certain** (per API spec) |
| Backend I/O progresses in parallel on ThreadPool | **Certain** |
| Cache Manager might recognize this as "true async FS" and relax the per-handle parallelism cap | **Unverified** (SMB/NFS kernel-mode redirectors run on overlapped I/O premise, so there may be a path where the kernel decides "if async, don't wait", but whether WinFsp's user-mode implementation gets the same privilege is undocumented officially) |

### Cost and risk

- **Buffer lifetime management required**: `IntPtr buffer` is a response region held by WinFsp, guaranteed live until `SendResponse` is called. Need strict implementation discipline to never emit **double response** (API spec violation) or **missing response** (IRP leak → upper app hangs)
- **Completion order may differ from dispatch order**: Upper apps should be using overlapped I/O so it's no issue, but needs explicit documentation as a logical premise
- **Error path coverage**: Must return all of `STATUS_OBJECT_NAME_NOT_FOUND` / `STATUS_NETWORK_UNREACHABLE` / generic IO errors via `SendReadResponse(hint, ...)`, missing one causes hang
- **Change to hold a `FileSystemHost` reference in `BackendFileSystem`** (currently received via `Init(host0)` and discarded)
- Implementation scale: ~30 lines added for Read alone, ~100 lines if Write / ReadDirectory follow the same pattern

### Judgment

Read-ahead (handle-local prefetch buffer) is:

- **Predictable in effect** (deterministic — independent of kernel behavior, 0 round-trip on cache hit)
- **Implementation contained in the backend layer** (doesn't change WinFsp-side contracts)
- **Graceful degradation on failure** (when prefetch misses, behavior equals current)

so the **first candidate is read-ahead**. The async response approach of this ADR is retained as "the next option if read-ahead doesn't yield satisfactory results in the Q32 scenario".

### Related ADRs

- Prerequisite: ADR-021 (accepting user-mode FS constraints in WinFsp migration), ADR-025 (per-IRP HTTP passthrough write path)
- Competing candidate: read-ahead implementation (separate ADR planned)

---
