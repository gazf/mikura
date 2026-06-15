## ADR-014: Hybrid modification detection — open/close window + sync-time based

**Decision**: Detect file modifications in two stages.

1. **Stage 1**: Did `LastWriteTimeUtc` change within the open/close window?
2. **Stage 2**: Is `LastWriteTimeUtc` newer than the last synced time (`LastSyncedWriteTimes`)?

If either is true, set `isModified = true` and mark for upload.

**Background**:

Notepad's `save-to-temp+rename` save and autosave write **outside** the OPEN/CLOSE callback window. Stage 1 alone misses these.

**Implementation**:

Added `SyncContext.LastSyncedWriteTimes` (`ConcurrentDictionary<string, DateTime>`):

- Record the server's `lastModified` during FullSync
- Record on receipt of WSS events (created/modified)
- On close, when `safeToDehydrate=true`, record the current `writeTime` (upload success or pure read)

This catches writes that do not involve OPEN/CLOSE (rename-saves, etc.) on the next close.

**Reasons for selection**:

- Lighter than approaches using USN journal or FileSystemWatcher
- As a design decision, "two-stage detection" is simple and easy to reason about
- Directly resolved the symptom of missed Notepad edits on a real machine

---
