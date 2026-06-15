## ADR-002: Not adopting Vanara.PInvoke.CldApi

**Decision**: Implement P/Invoke ourselves instead of using the Vanara library.

**Reasons for rejection**:

- Heap allocations from `PinnedObject` + `Marshal.PtrToStructure` on the hot path
- `DllImport`-based, so it cannot benefit from `LibraryImport` or `UnmanagedCallersOnly`
- Reflection-based marshaller, not Native AOT compatible
- Hundreds of unused functions bundled into the assembly

**Adopted alternative**:

A homegrown `CfApi.Native` layer. Full use of modern C# features: `LibraryImport`, `readonly struct`, function pointers (`delegate* unmanaged`), explicit `Pack = 8`, and so on.

---
