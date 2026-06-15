## ADR-004: Offline behavior — read-only or unavailable

**Decision**: Editing is disabled while offline. Either "read-only" or "unavailable" is selected depending on the environment.

**Rejected alternatives**:

- **Offline editing + conflict resolution on reconnect**: The Nextcloud / OneDrive approach. A source of conflicts, harms UX

**Rationale**:

- Conflicts are prevented by construction
- Audit / compliance stays clean
- Implementation is significantly simpler (no UploadQueue, no ConflictResolver)
- A reasonable trade-off for an internal file-server replacement

**Implementation policy**:

- Network state monitoring
- When offline, FETCH_DATA returns `STATUS_CLOUD_FILE_NETWORK_UNAVAILABLE`
- Status display in the task tray

---
