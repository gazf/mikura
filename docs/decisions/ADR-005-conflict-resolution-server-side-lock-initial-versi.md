## ADR-005: Conflict resolution — server-side lock (initial version)

**Decision (initial version)**: Acquire a server-side lock when a file is opened, release it after close + upload completion.

**Three layers of exclusion control**:

1. Logical lock (server-side KV): Notify other users that editing is in progress
2. ETag / If-Match (HTTP): Insurance against missed locks, prevents concurrent PUTs
3. Atomic rename (filesystem): Hides partially-written data from other users during write

**Current status**:

This ADR was re-evaluated during Phase 5 implementation and **updated by ADR-016 / ADR-018**. SID-based liveness management + conflict-file strategy (ADR-017) is now in use.

**Related ADRs**: ADR-016, ADR-017, ADR-018

---
