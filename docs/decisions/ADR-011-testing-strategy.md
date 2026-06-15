## ADR-011: Testing strategy

**Decision**: Server side uses in-memory KV unit tests; client side is centered on real-machine testing.

**Server side**:

- Deno standard tests + `:memory:` KV for isolated tests
- Run `deno task test` in CI

**Client side**:

- Domain layer (Mikura.Core) is mockable and unit-testable
- Interop layer and below require real-machine testing (CfApi depends on the Windows kernel)
- E2E: verify operations from Explorer on a real Windows machine

---
