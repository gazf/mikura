## ADR-017: Conflict file strategy — last resort for abnormal situations

**Decision**: mikura's design philosophy is "do not tolerate conflicts" (structurally prevented by the open-time lock in ADR-016 + the RO reflection in ADR-019). The conflict file mechanism remains as a **last-resort guarantee that does not fire under normal operation**.

**Clarification of positioning**:

- Normal operation: when lock acquisition fails the file is opened RO -> editing itself does not occur -> no conflict
- Abnormal situations only: when WSS drops, race conditions (B opens before A acquires the lock), bugs, etc. cause an edit to go through
- Safety net to **absolutely never lose the user's work** even in abnormal situations

**Implementation**:

When lock acquisition fails, or when an integrity check during upload (ETag mismatch, etc.) detects a conflict, the local change is preserved as `<stem>.conflict-<yyyyMMdd-HHmmss><ext>`, and the original file is dehydrated to revert to the server version.

```csharp
private static async Task<bool> SaveAsConflictFileAsync(string relativePath, string localPath)
{
    var dir = Path.GetDirectoryName(localPath);
    var stem = Path.GetFileNameWithoutExtension(localPath);
    var ext = Path.GetExtension(localPath);
    var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss");
    var conflictPath = Path.Combine(dir, $"{stem}.conflict-{stamp}{ext}");

    await using var src = File.OpenRead(localPath);
    await using var dst = File.Create(conflictPath);
    await src.CopyToAsync(dst);

    return true;
}
```

**Operational implication**:

- A conflict file occurring during normal operation = design-level abnormal situation or a possible bug
- Treat as a logged and monitored event
- If it happens frequently, revisit WSS connection stability and the lock mechanism

**Rationale**:

- Zero-data-loss principle (never lose the user's work)
- Same approach as Dropbox / OneDrive (end users are familiar with it)
- Allows merging after the fact
- The original file is synced to the server version, so consistency is preserved

**Related ADRs**:

- ADR-016: open-time lock (normally prevents conflicts here)
- ADR-018: Device ID based Liveness lock
- ADR-019: X-File-Attributes header (primary edit-blocking mechanism)

---
