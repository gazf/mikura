## ADR-020: Always dehydrate at close — operation model equivalent to SMB over VPN

**Decision**: Always attempt dehydrate at file close. Keep no local cache; the server is the single source of truth. This is **the same operation model as SMB over VPN**, consistent with mikura's target requirement (Samba replacement).

**Comparison of operation models**:

| Aspect | SMB over VPN | mikura |
|---|---|---|
| File entity | Server only | Server only (only placeholders local) |
| Client cache | Volatile, eventually released | Released via dehydrate |
| Transport | SMB protocol (TCP 445) | HTTPS (CfApi + GET /content) |
| Auth | LDAP / Kerberos | OIDC + JWT + Device ID |
| Essence of behavior | Same | Same |

**Flow**:

```
[At close]
- With edits: upload -> unlock -> attempt dehydrate
- Without edits: unlock -> attempt dehydrate

[Dehydrate behavior]
- App fully released the handle: succeeds immediately
- App reacquires for intermediate save etc.: fails with sharing violation -> retry queue
- Retry queue periodically retries -> succeeds after app fully exits

[When needed again]
- Handle acquired -> CfApi fires FETCH_DATA -> re-fetched via GET /content
- Same behavior as SMB's "re-read from server"
```

**Behavior for Word intermediate save etc.**:

```
Word: Ctrl+S -> handle momentarily released
mikura: CLOSE_COMPLETION -> upload -> attempt dehydrate
Word: immediately reacquires handle
mikura: dehydrate fails with sharing violation -> retry queue

or (if Word fully released the handle):

Word: Ctrl+S -> handle fully released
mikura: CLOSE_COMPLETION -> upload -> dehydrate succeeds
Word: reacquires handle -> CfApi: FETCH_DATA -> rehydrate
```

Both behaviors are the same as SMB over VPN. Rehydrate latency may be faster than SMB thanks to HTTP/2 + parallelism.

**Consistency guarantee mechanism**:

| Mechanism | Role |
|---|---|
| Close-time dehydrate | In 99% of cases, immediately attempts to drop local content |
| Dehydrate retry queue | Catch-up for failures due to sharing violation, etc. |
| Re-dehydrate on WSS modified event | Immediate response when another client modifies |
| ETag compare against /tree at startup | Whole-tree consistency sync, recovers missed WSS events |

The combination achieves **practically perfect consistency**.

**Properties of CfDehydratePlaceholder**:

- **Local NTFS operation only, no server communication**
- Only releases clusters; the placeholder (MFT metadata) remains
- Cost ~ 0 (a few ms)
- Failure cases: pinned, in use by another process, `NOT_IN_SYNC` state

**Rationale**:

- **Same operation model as SMB over VPN**: consistent with mikura's target requirement (Samba replacement); users get familiar behavior
- **Naturally aligned with CfApi's flow**: optimistic caching (ETag checks, etc.) mismatches with CfApi's cache decision (it does not call FETCH_DATA when cache exists)
- **Consistency problems are eliminated in principle**: no stale local cache remains
- **Strictly upholds "server is truth"**: aligned with design principle ADR-004
- **Dehydrate is free**: local-only operation, negligible cost
- **Security**: leaves no unneeded data locally
- **Simple**: no cache management logic needed

**Relation to Storage Sense**:

Windows Storage Sense also has a feature to "dehydrate unused cloud files", but mikura explicitly dehydrates at close, so it does not depend on Storage Sense behavior.

**Pin feature (future)**:

CfApi's `CfSetPinState` can mark a file as pinned to prevent dehydration. As a feature for the user to explicitly choose "files I always want local", this can be added later. Considered on the roadmap.

**Rejected alternatives**:

- **Optimistic cache + ETag check**: a concept absent from SMB, poorly aligned with CfApi's flow (no FETCH_DATA when cached), no means to intervene at open
- **Use local cache + leave to Storage Sense**: lacks mikura's consistency story; consistency guarantee becomes OS-dependent
- **Time-based dehydrate (10 minutes later, etc.)**: half-measure, does not fundamentally solve the consistency problem

**Implementation notes**:

- `OnFileCloseAsync` returns `safeToDehydrate` (current design retained)
- On upload failure, `safeToDehydrate = false` (protect local edits, ADR-016)
- Otherwise `safeToDehydrate = true` (dehydrate even without edits)
- On dehydrate failure -> retry queue (sharing violation is expected; handle later)
- WSS modified event handler: "if already hydrated, attempt dehydrate"

**Related ADRs**:

- ADR-004: offline behavior (server-is-truth principle)
- ADR-013: ALWAYS_FULL (placeholder always remains, only content is dehydrated)
- ADR-014: hybrid modification detection
- ADR-016: open-time lock
- ADR-019: X-File-Attributes header

---
