## ADR-010: Adopt HTTP/2 (future)

**Decision**: Enable HTTP/2 on both server and client (implement after Phase 5 completes).

**Rationale**:

- Easily enabled via `HttpClient` configuration
- Header compression (HPACK) reduces overhead from repeated auth tokens
- Multiplexing parallelizes metadata fetches
- Automatic HTTP/1.1 fallback

**HTTP/3 deferred**:

- Implementations are still young in both Deno and .NET
- Concerns about UDP 443 traversal through corporate firewalls

---
