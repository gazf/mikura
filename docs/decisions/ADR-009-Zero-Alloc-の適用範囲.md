## ADR-009: Zero Alloc の適用範囲

**決定**: モダン C# の機能は活用するが、過剰な最適化は避ける。

**適用する**:

- `LibraryImport` による source-generated マーシャラ
- 構造体の `readonly struct` 化
- 関数ポインタ(`delegate* unmanaged<>`)、Delegate 不使用
- `UnmanagedCallersOnly` コールバック
- ホットパスの `stackalloc` + `ArrayPool<T>` ハイブリッド

**適用しない(現時点)**:

- `ValueTask` 化(async 境界でメリット薄い)
- `PoolingAsyncValueTaskMethodBuilder`(効果が測れていない)
- カスタム `IValueTaskSource` 実装(オーバーエンジニアリング)
- UniTask 等の外部ライブラリ(標準機能で足りる)

**判断基準**: ボトルネックになってから最適化する。それまでは可読性・保守性優先。

---
