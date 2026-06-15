## ADR-015: oplock ハンドル開閉戦略

**決定**: `SetInSyncState` / `UpdatePlaceholder` のたびに `OplockFileHandle` を開閉する。ハンドルを保持し続けない。

**背景(実機で詰まった経緯)**:

書き戻しフローで「open + state 変更 + read + アップロード + state 変更 + close」を試みたところ、以下の問題が連鎖的に発生:

1. `CfOpenFileWithOplock` の handle は overlapped で開かれている
2. `FileStream` で読もうとすると:
   - `isAsync: true` → "BindHandle for ThreadPool failed"(CfApi が内部で完了ポートに bind 済み、再 bind 不可)
   - `isAsync: false` → "Handle does not support synchronous operations"
3. ハンドル保持中は `File.OpenRead` もシェアバイオレーション

**解決**: state 変更のたびに開閉する戦略

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

**残るレース**: `SetInSyncState(false)` と `File.OpenRead` の隙間で OS が dehydrate する可能性は理論上ある。ただし `SetInSyncState(false)` で OS の自動 dehydrate は抑制されているので**実害なし**。

**関連 ADR**:

- ADR-005: コンフリクト解決(3層排他制御)

---
