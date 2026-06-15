## ADR-009: Scope of Zero Alloc

**Decision**: Leverage modern C# features, but avoid over-optimization.

**Apply**:

- Source-generated marshallers via `LibraryImport`
- `readonly struct` for structs
- Function pointers (`delegate* unmanaged<>`), no Delegate
- `UnmanagedCallersOnly` callbacks
- Hot-path `stackalloc` + `ArrayPool<T>` hybrid

**Do not apply (for now)**:

- `ValueTask` conversion (little benefit at async boundaries)
- `PoolingAsyncValueTaskMethodBuilder` (effect not measured)
- Custom `IValueTaskSource` implementations (over-engineering)
- External libraries like UniTask (standard features suffice)

**Criterion**: Optimize once it becomes a bottleneck. Until then, prioritize readability and maintainability.

---
