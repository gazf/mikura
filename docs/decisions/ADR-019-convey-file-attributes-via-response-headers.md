## ADR-019: Convey file attributes via response headers

**Decision**: Include file attributes (`X-File-Attributes`) in the response header of file retrieval (GET /content/*). The client reads the header and reflects it into the local NTFS MFT via CfApi. The `/tree` endpoint likewise includes attribute info on each node.

**Design core**:

- HTTP body = file content (inviolable)
- HTTP header = metadata (attributes, lock state, owner, etc.)
- One request retrieves everything, atomically, with no drift

**Flow**:

```
[Hydrate]
Client: GET /content/report.docx (X-Device-Id: <self>)
Server: 
  - authorization check
  - check lock state: if holder.deviceId !== requester.deviceId then "locked by other"
  - response:
      Content-Type: application/octet-stream
      ETag: "abc-123"
      Last-Modified: ...
      X-File-Attributes: ReadOnly        <- when locked
      X-File-Lock-Holder: alice          <- optional, for user notification
      [body: file content]
Client:
  - write to local via transfer.Write (hydrate)
  - interpret X-File-Attributes
  - File.SetAttributes to apply RO attribute to local NTFS MFT

[Startup / tree fetch]
Client: GET /tree (X-Device-Id: <self>)
Server: include { isReadOnly: whether locked by someone else } on each node
Client: CreatePlaceholders with attributes

[Lock state change (WSS broadcast)]
Server: broadcast lock_acquired/lock_released to all clients
Client: update attributes of already-hydrated files
            File.SetAttributes(path, attrs | ReadOnly) or attrs & ~ReadOnly
```

**Header spec**:

| Header | Description | Example |
|---|---|---|
| `X-File-Attributes` | Comma-separated list of attributes | `ReadOnly`, `Hidden,System` |
| `X-File-Lock-Holder` | Display name of lock holder (optional) | `alice` |

Future extensions:

| Header | Description |
|---|---|
| `X-File-Permissions` | Permission-based RO (ADR-008) |
| `X-File-Tags` | Tags |
| `X-File-Owner` | Owner |

**Role split with WSS**:

- **GET /content header**: state at the moment of hydrate (acquired with the body, atomic)
- **GET /tree isReadOnly**: initial state at startup
- **WSS lock_acquired/released**: real-time state change after hydrate

**SSOT principle**:

- Lock state = server-side KV
- File attributes = generated and sent by the server
- Client only reflects; it holds no independent state

**Handling of race conditions**:

- A acquires lock -> server broadcasts -> B receives WSS event and goes RO -> usually prevented this way
- B opens the file before A acquires the lock -> SetAttributes on B's side may fail with a sharing violation
  -> edit may go through in this case; detected by integrity check at close -> conflict file (ADR-017)
- WSS disconnected -> broadcast does not arrive -> re-synced via /tree on recovery (ADR-013)

**Rationale**:

- Natural design aligned with HTTP convention (custom headers carry metadata)
- Clean separation of body and metadata
- One request, atomic, no state drift
- Excellent fit with CfApi's Hydrate flow (`transfer.Write` and `SetAttributes` in one flow)
- Minimal change to existing API (header addition only)
- Same pattern handles future extensions (tags, owner, permission-based RO, etc.)

**Rejected alternatives**:

- **Separate API for metadata**: requires 2 requests, state may change in between
- **/tree only**: drift between hydrate time and /tree fetch time
- **Embed in file content**: impossible (the body is inviolable)
- **Server-side RO at filesystem level**: only content reaches the client, meaningless

**Related ADRs**:

- ADR-008: permission model (the same header mechanism can convey permission-derived RO in the future)
- ADR-013: ALWAYS_FULL + WSS (same pattern in /tree)
- ADR-016: open-time lock
- ADR-017: last resort for abnormal situations
- ADR-018: Device ID based Liveness lock

---
