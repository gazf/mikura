## ADR-003: Layer structure — 5 layers

**Decision**: A 5-layer structure: Native / Interop / Core / Transport / App.

**Responsibilities per layer**:

- **CfApi.Native**: P/Invoke mapping of Win32 CfApi only. No business logic
- **CfApi.Interop**: Translation between Native types and Domain types, callback dispatch. Does not leak Native types outside
- **Mikura.Core**: Domain logic, use cases, abstract interfaces (`IMikuraServer`, `IEventStream`, etc.)
- **Mikura.Transport**: HTTP / WSS / SSE and other communication implementations
- **Mikura.App**: WinForms UI, settings, DI wiring, entry point

**Dependency direction**:

```
Native ← Interop ← Core ← App
                    ↓
                 Transport → Deno Server
```

**Rationale**:

- Clear responsibilities, conforms to Clean Architecture
- Core has no knowledge of the CfApi/HTTP concrete implementations (easy to test, easy to port)
- Core / Transport can be reused when a CLI / Web UI is added in the future

---
