## ADR-022: Lock acquisition scope on WinFsp — write-intent + in-process refcount

**Decision**: Redefine ADR-016's "lock at open" to fit the reality of WinFsp callback volume:

1. **Only write-intent opens** acquire locks (read-only opens do not)
2. **Multiple opens to the same path within the same process are aggregated by refcount** (POST/DELETE fire only on the first open and the last close)
3. **On lock conflict, respond immediately with `STATUS_ACCESS_DENIED`** (not 404)

**Background — diff vs. the CfApi era**:

CfApi's `NOTIFY_OPEN_COMPLETION` was a hook that fired only for "the file open the user actually intended", but WinFsp forwards **every `CreateFile` IRP coming from the kernel** to the user-mode `Open` callback. One user operation = dozens of CreateFiles is the norm:

- shell preview / icon overlay / property dialog / Defender / search indexer /
  safe-save rename (requests DELETE permission) / notepad autosave cycle

A naive "acquire lock on every open" implementation was observed firing `POST /locks` **20-30 times in succession** per single edit.

**Design decision 1: lock only on write-intent**

Read-intent opens (content viewing, scanning, preview) can run concurrently per ADR-020's "server is the single truth" principle. To preserve the **"can still open read-only while someone else is editing"** UX of Excel/Word/Notepad, no lock is acquired on read opens.

The path where a write erroneously comes from a read-only handle is rejected by the kernel in principle, but as a defense, `MikuraServerBackend.WriteAsync` throws `UnauthorizedAccessException` when `!h.HasLock && !h.FreshlyCreated` as a double check.

**Design decision 2: share server lock via in-process refcount**

Even for write-intent, as noted above, multiple write-intent opens fire in succession per edit. Independently AcquireLocking each of them causes:

- A burst of POSTs to the server
- A race condition where the first Cleanup on sibling handles releases the server lock -> the remaining handles upload while still thinking they hold the lock

Fix: introduce the `LockSlot` structure in `MikuraServerBackend`. Opens to the same path in the same process simply bump a refcount via the `_activeLocks` dictionary. `POST /locks` fires only on the first open; `DELETE /locks` fires only on the last close. A `TaskCompletionSource` for concurrent opens lets the second-and-later opens inherit the first HTTP result after waiting.

**Design decision 3: NTSTATUS mapping on conflict**

On lock acquisition failure, there was a bug where the generic catch in `MikuraFileSystem.Open` turned all exceptions into `null` and returned `STATUS_OBJECT_NAME_NOT_FOUND`. The user would see "File not found", and the real reason (being edited by another) would not be conveyed.

Fix: catch `UnauthorizedAccessException` specifically and return `STATUS_ACCESS_DENIED`. Excel can then correctly display its "Another user is using this file. Open as read-only?" dialog.

**Open issue: lost update**

During the read-only period the server-side lock is absent, so the following sequence causes a lost update:

```
A: read open -> fetch content "x"
B: read open -> fetch content "x"
A: edit and save (write open -> AcquireLock -> upload "y" -> release)
B: edit and save (write open -> AcquireLock succeeds (A already released) -> upload "B's x->x'")
   <- B overwrites the server with its own "x'" without seeing A's "y" = A's edit is lost
```

This is to be addressed by ADR-026's ETag/If-Match optimistic concurrency control (not covered in this ADR).

**Implementation location**:

- `OpenAsync` / `AcquireSharedAsync` / `ReleaseSharedAsync` / `LockSlot` in `client/src/Mikura.Core/Sync/MikuraServerBackend.cs`
- `Open` callback and `HasWriteAccess` helper in `client/src/WinFsp.Interop/MikuraFileSystem.cs`

**Related ADRs**:

- Supersede: the "lock at open" part of ADR-016 (timing retained, scope narrowed to write-intent)
- Retain: ADR-018 (Liveness with Device ID + heartbeat)
- Derived: ADR-026 (ETag-based lost-update prevention, not yet started)

---
