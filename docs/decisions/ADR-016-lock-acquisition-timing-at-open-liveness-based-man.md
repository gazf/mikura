## ADR-016: Lock acquisition timing — at open + Liveness-based management

**Decision**: Acquire the server-side lock at file open. Deliver Samba-equivalent UX and structurally eliminate conflicts. Liveness management uses the Device ID + WSS heartbeat scheme (ADR-018); blocking edits to locked files uses the X-File-Attributes header scheme (ADR-019).

**History**:

- ADR-005 decided "acquire lock at open"
- During Phase 5 implementation, concerns about "even read-only opens trigger locks → server load" led to a temporary switch to "lock only at close" (optimistic approach)
- Load estimates at 100-user scale showed lock acquisition is not an issue
- Returned to "lock at open" by reverting to the design principle "Samba-equivalent, do not tolerate conflicts"

**Load estimate at 100-user scale**:

- One lock acquisition ≈ 5ms (JWT verification + checkPermission + KV.get + KV.atomic)
- Deno KV throughput ≈ several thousand ops/sec
- Peak 50 ops/sec (100 users × 5 files × 10-second burst)
- Utilization ≈ 13%, plenty of headroom

There is no need to avoid "read locks" on server-load grounds. **The real concern is UX** (false alarms on short previews, ghost locks left behind after abnormal termination), which is resolved by ADR-018's 30-second TTL + WSS heartbeat.

**Samba-equivalent UX**:

- Acquire lock on file open → other users are immediately notified "being edited" (WSS broadcast)
- When another user opens the same file → server returns it with the ReadOnly attribute (ADR-019) → the editing application honors RO and blocks editing
- A closes → lock released → other users can edit

This **structurally eliminates conflicts**.

**Safety net**:

- If an edit proceeds without a lock under abnormal conditions (missed WSS event, race condition, bug, etc.) → recover via conflict file (ADR-017)
- Does not fire in normal operation; the final guarantee of the design

**Related ADRs**:

- ADR-005: old specification (updated by this ADR)
- ADR-017: conflict file (last resort for abnormal situations)
- ADR-018: Device ID + WSS heartbeat-based Liveness management
- ADR-019: attribute propagation via X-File-Attributes header
- ADR-020: always dehydrate at close

---
