## ADR-032: Replacing the WinFsp .NET binding with an in-house modern P/Invoke binding

**Decision**: Remove the dependency on the official `winfsp-msil.dll` (delegate-based .NET binding) and implement an in-house binding (`WinFsp.Native` project) composed of `LibraryImport` (source-generator P/Invoke) + `delegate* unmanaged[Cdecl]` function pointers + `[UnmanagedCallersOnly]` static trampolines, establishing it as the sole path for `BackendFileSystem` / `BackendFileSystemHost`. Always set the `UmFileContextIsUserContext2` flag, and manage FileContext with monotonic ID + `ConcurrentDictionary` (`GCHandle` not adopted). AOT-ready (analyzer warnings 0).

### Background

After migrating from CfApi to WinFsp in ADR-021, the binding went through `winfsp-msil.dll`. The constraints and pains that surfaced:

- **Per-IRP overhead**: delegate marshaling + runtime reflection callback registration always running on hot path
- **Black-box Synchronized=true dependency**: The legacy `Fsp.FileSystemHost` internally serializes callbacks, and mikura's path-keyed lock / session refcount code rode on that implicit ordering. During CPU 100% bisection, there was no way to verify "do parallel callbacks race or stay serial", and the investigation stalled
- **AOT impossible**: Reflection / delegate marshaling dependency couldn't pass the `<IsAotCompatible>true</IsAotCompatible>` analyzer (= shackle for future reflection-free migration)
- **Cannot change upstream behavior**: Cannot own bugs, wording, default flags (= the `UmFileContextIsUserContext2` discussed below)

For reference, checked hooyao/winfsp-native (MIT) API design, but took the **in-house implementation policy** without increasing external dependencies and partly for learning (details in "Rejected alternatives" below).

### Design

#### Structure

- `WinFsp.Native` project: `IFileSystem` (sync NTSTATUS callback) + optionally implementable `IAsyncFileIo` (`ValueTask<ReadResult>` / `ValueTask<WriteResult>`), `FileSystemHost` orchestrator, `NativeApi` (LibraryImport), blittable structs (`VolumeParams` / `TransactRsp` / `NativeFileInfo` etc.)
- `WinFsp.Interop` project: mikura's `IFileSystemBackend` ↔ `IFileSystem` adapter (`BackendFileSystem`), `FileSystemHost` lifecycle wrapper (`BackendFileSystemHost`)
- `Mikura.Core`-side API (`IFileSystemBackend` / `FileSystemBackend`) is unchanged, transparently working with the binding swap

#### Core choices

- **`LibraryImport` (source-gen P/Invoke)**: Compile-time marshaling stub generation, zero runtime reflection
- **`delegate* unmanaged[Cdecl]<...>` + `[UnmanagedCallersOnly]`**: Populate callback table directly per ABI, eliminating delegate alloc / marshaling
- **`VolumeParams` is fully blittable struct**: `fixed char[]` for inline arrays, structured to pass to native with `fixed (VolumeParams* p = &vp)` (avoids the trap where `string` + `MarshalAs ByValTStr` causes in-memory and marshaled layouts to diverge, breaking `*` passing)
- **Sync `IFileSystem` + optional `IAsyncFileIo`**: hooyao-style "all methods `ValueTask` mandatory" forces `ValueTask` overhead even on in-memory FS, so adopted a separation design where sync path is default and an HTTP-backed implementation also implements `IAsyncFileIo`
- **`AsyncCompletion`**: STATUS_PENDING + `FspFileSystemSendResponse` async response path. `TransactRsp` (fixed 128B blittable) allocated via `stackalloc` and passed directly as `&rsp`, zero per-IRP native heap alloc
- **FileContext lifecycle**: Instead of using `GCHandle.Alloc` + `ToIntPtr`, manage `long` IDs issued via in-house `Interlocked.Increment` in a `ConcurrentDictionary<long, object>`. Structurally impossible to reissue an ID after `Free` → eliminates use-after-free (details in Bug 3 lessons below)
- **AOT-ready**: Fix `<IsAotCompatible>true</IsAotCompatible>` on both `WinFsp.Native` / `WinFsp.Interop` csproj. Regression net that rejects reflection contamination as build-time warnings

### Existing bugs surfaced during the process and lessons

The binding swap itself was a feature-equivalent migration, but I document the common lessons from the 5 bugs surfaced during migration verification.

#### 1. Race that `winfsp-msil`'s `Synchronized=true` was hiding

In parallel callback dispatch, the responsibility of preserving the ordering of `path-keyed lock` / `session refcount` rested on mikura's backend side, which was invisible in the legacy era. Only surfaced with the new binding (= parallel dispatch by default), and by reorganizing to `shouldUpload = h.HasLock && (...)` form, the abnormal pattern of "kernel posts Cleanup twice for the same Create handle" can be absorbed structurally with HasLock=false.

Lesson: **Responsibility partitioning that depends on implicit serialization surfaces the moment the binding is swapped**. Don't push ordering onto the binding side; defend it with invariants on the backend side.

#### 2. Unobserved exception of faulted `TaskCompletionSource`

When the first caller of `AcquireSessionSlotAsync` hit 403 in StartUpload, the TCS was faulted via `TrySetException`. If there's no second caller, `Task.Exception` is read by no one, and via GC finalizer, fires as `TaskScheduler.UnobservedTaskException` **30 seconds late** — a trap.

Lesson: **When TCS is faulted, observe it synchronously with `_ = TCS.Task.Exception`** (subsequent awaits just re-throw, reading the same `AggregateException` has no side effect).

#### 3. `GCHandle` slot reuse = use-after-free

The textbook implementation of `GCHandle.Alloc` + `ToIntPtr` as fileContext passed to WinFsp, on slot reuse after `Free`, generated a race where unrelated callbacks reference a different managed object (observed in the field: `System.Threading.Thread` landed in the same slot). `InvalidCastException` via `UnmanagedCallersOnly` callback led to process termination (`[FATAL] AppDomain.UnhandledException terminating=True`).

Lesson: **`GCHandle.ToIntPtr` is textbook but breaks under production churn**. In-house monotonic ID + dict is safer (per-IRP lookup cost ~30ns, negligible). Not a GC root, but long-lived references are pinned in backend-side collections so no leak.

#### 4. Without setting `UmFileContextIsUserContext2`, FileContext is shared per-path

WinFsp by default treats FileContext as **FileNode's `UserContext`** (= shared across all Opens to the same path). Even if we return a new ID per Open, subsequent IRPs' fileContext is overwritten by the Create handle's ID, and Read open's Read IRP falls into the **`ReadAsync` zero-fill early return** via the Create handle (`FreshlyCreated=true`). On actual hardware, reproduced the symptom of **returning all-zero bytes that don't match the 64MiB written**.

Lesson: **WinFsp's default is FileNode shared**. If you expect per-Create independence, **always set `UmFileContextIsUserContext2`**. Light on mention in WinFsp reference implementations (including hooyao); a kind of trap you don't notice until you step on it. Tests fix the bit number and raw value (`0x10000`) in `VolumeParamsFlagsTests.UmFileContextIsUserContext2_BitSet_HasExpectedRawValue`.

#### 5. `PrefetchCache` partial hit was zero-filling (existing bug unrelated to binding)

A Mikura.Core-side bug latent since the ADR-031 prefetch implementation. After 3 consecutive sequential reads, prefetch becomes armed, fetches 2x the requested byte count from the server, and **stores the surplus in per-handle cache**. In cases where the subsequent read matches the cache offset but the requested size > cache holding (e.g., 64KB IRP followed by 1MB IRP in mixed IRP size workload), the old code returned the cache portion and then **zero-filled** the remaining bytes with `Span.Clear()`. As a result, the caller (kernel → application) receives "real bytes at the head, zeros at the tail" mixed data, and **ZIP CRC verification and XML parsers detect corruption** ("file-level validation and repair" when opening Excel / Word etc. zip containers). The fix is to detect partial hit and **fall through** the remaining bytes to the server fetch path via `offset += cachedBytes`.

Lesson: **Comments saying "doesn't normally come here (safety net)" are usually wrong**. Mixed IRP size workloads exist normally. When writing `Span.Clear()` as a safety net, properly think through **the side effects (corrupt data) and the scenarios in which it can happen**. The bug would have been stepped on without the binding migration too, but only manifested during new binding adoption verification by trying xlsm files.

### Trade-offs

| Aspect | Evaluation |
|---|---|
| Per-IRP overhead | Delegate marshaling eliminated + stackalloc-ized → **zero per-IRP native heap alloc**, managed alloc only `UnmanagedMemoryManager` class (~24B) + `async Task` state machine box |
| Performance (CDM) | SEQ R/W several hundred MB/s, RND4K Q=1 W +18% vs legacy (effect of removing per-IRP `Trace.WriteLine` added). RND4K's CPU 100% is a structural issue with WinFsp CSQ spinlock, unreachable at binding layer (= equivalent to legacy) |
| AOT-readiness | Fixed `<IsAotCompatible>true</IsAotCompatible>` analyzer-green, established regression net against reflection contamination. Actual AOT publish is blocked by `Mikura.App` (WinForms), unsupported, but possible for the binding alone |
| Concurrency control sense | Dispatcher thread count externally controllable via `MIKURA_NATIVE_THREADCOUNT` (debug escape hatch, 1=serialized for legacy equivalent), per-IRP observation also possible via `MIKURA_NATIVE_TRACE` |
| ABI risk | Take on the risk of breakage from WinFsp upstream struct layout changes (constantly assert fixed values `VolumeParams` 504B / `TransactRsp` 128B / `NativeFileInfo` 72B etc. in `WinFsp.Native.Tests`). Actual driver-side compatibility is end-to-end checked in `WinFsp.Native.IntegrationTests` (Windows + WinFsp actual mount) |
| Learning cost | Take on the burden of understanding WinFsp spec (callback table / NTSTATUS / VolumeParams flags / `FspFileSystemSendResponse` etc.) yourself. In return, resolve the state of "can't debug 5 bugs without understanding binding behavior" |

### Rejected alternatives

- **Continue using `winfsp-msil`**: Accept per-IRP marshaling overhead, continued inability to bisect CPU 100%, no AOT, no recourse for un-debuggable binding bugs. Becomes defer of defer
- **Depend on hooyao/winfsp-native**: MIT, 3 stars, API design is close. However (a) FileContext is `GCHandle.Alloc`-based (= risk of stepping on Bug 3 above), (b) all FileSystem methods require `ValueTask`, forcing overhead on sync-only backends, (c) async response's `FspTransactRsp` is captured as closure local (= heap promoted), far from stackalloc-ization, (d) no mention of the significance of `UmFileContextIsUserContext2`. To bring it to production grade, we end up forking and fixing, so went in-house from the start
- **PR upstream WinFsp**: Spec changes (defaulting `UmFileContextIsUserContext2` ON etc.) are hard to accept as upstream breaking changes, and wait time is unpredictable. In-house binding lets us own it
- **Different FS like drvfs / NFS**: mikura already chose CfApi → WinFsp in ADR-021, out of scope for this ADR

### Related ADRs / code

- Prerequisite: ADR-021 (WinFsp migration), ADR-022 (lock scope), ADR-025 (chunked upload), ADR-027 (per-handle 2-outstanding constraint), ADR-031 (prefetch)
- Related: ADR-031 (this ADR's Bug 5 fix changes behavior, but preserves design intent)
- Implementation:
  - [`WinFsp.Native/FileSystemHost.cs`](../client/src/WinFsp.Native/FileSystemHost.cs): `FspFileSystemInterface` populate + callback trampoline + FileContext lifecycle (monotonic ID + dict)
  - [`WinFsp.Native/AsyncCompletion.cs`](../client/src/WinFsp.Native/AsyncCompletion.cs): STATUS_PENDING + stackalloc `TransactRsp` + `FspFileSystemSendResponse`
  - [`WinFsp.Native/Native/VolumeParams.cs`](../client/src/WinFsp.Native/Native/VolumeParams.cs) / [`NativeApi.cs`](../client/src/WinFsp.Native/Native/NativeApi.cs): blittable struct + LibraryImport
  - [`WinFsp.Interop/BackendFileSystem.cs`](../client/src/WinFsp.Interop/BackendFileSystem.cs) / [`BackendFileSystemHost.cs`](../client/src/WinFsp.Interop/BackendFileSystemHost.cs): mikura `IFileSystemBackend` adapter
- Verification:
  - [`WinFsp.Interop.Tests/BackendFileSystemTests.cs`](../client/tests/WinFsp.Interop.Tests/BackendFileSystemTests.cs): Pins responsibilities such as intent classification / NTSTATUS conversion / Cleanup flag mapping
  - [`WinFsp.Native.Tests/VolumeParamsTests.cs`](../client/tests/WinFsp.Native.Tests/VolumeParamsTests.cs): Pins struct layout + bit number (in particular `UmFileContextIsUserContext2`=bit 16)
  - [`WinFsp.Native.IntegrationTests/MountRoundtripTests.cs`](../client/tests/WinFsp.Native.IntegrationTests/MountRoundtripTests.cs): Actual WinFsp driver mount + R/W roundtrip + Bug 4 regression, auto-skipped via `[SkippableFact]` on environments where WinFsp is not installed
  - `Cleanup_AfterLockAlreadyReleased_DoesNotReAttemptUpload` / `Read_PartialPrefetchHit_FallsThroughToServerInsteadOfZeroFill` in [`Mikura.Core.Tests/FileSystem/FileSystemBackendTests.cs`](../client/tests/Mikura.Core.Tests/FileSystem/FileSystemBackendTests.cs) (inversely verified that both fail reliably when reverted to old conditions)
