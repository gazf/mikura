## ADR-015: oplock handle open/close strategy

**Decision**: Open and close `OplockFileHandle` each time `SetInSyncState` / `UpdatePlaceholder` is called. Do not hold the handle.

**Background (how we got stuck on the real machine)**:

When attempting "open + state change + read + upload + state change + close" in the write-back flow, the following issues cascaded:

1. The handle from `CfOpenFileWithOplock` is opened as overlapped
2. Trying to read with `FileStream`:
   - `isAsync: true` → "BindHandle for ThreadPool failed" (CfApi has already bound it to a completion port internally; re-bind not possible)
   - `isAsync: false` → "Handle does not support synchronous operations"
3. While the handle is held, even `File.OpenRead` hits a share violation

**Solution**: open/close on every state change

```csharp
using (var handle = OplockFileHandle.Open(localPath, OplockOpenFlags.WriteAccess))
    handle.SetInSyncState(false);

await using var stream = File.OpenRead(localPath);
await UploadAsync(stream);

using (var handle = OplockFileHandle.Open(localPath, OplockOpenFlags.WriteAccess))
{
    handle.UpdatePlaceholder(...);
    handle.SetInSyncState(true);
}
```

**Remaining race**: there is a theoretical possibility that the OS dehydrates in the gap between `SetInSyncState(false)` and `File.OpenRead`. However, since `SetInSyncState(false)` suppresses the OS's automatic dehydrate, **there is no practical impact**.

**Related ADRs**:

- ADR-005: conflict resolution (three-layer exclusion control)

---
