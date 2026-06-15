## ADR-002: Vanara.PInvoke.CldApi の不採用

**決定**: Vanara ライブラリを使わず、P/Invoke を自前実装する。

**却下理由**:

- ホットパスで `PinnedObject` + `Marshal.PtrToStructure` のヒープアロケが発生
- `DllImport` ベースで、`LibraryImport` や `UnmanagedCallersOnly` の利点を享受できない
- リフレクションベースのマーシャラで Native AOT に非対応
- 使わない数百関数がアセンブリに含まれる

**採用した代替**:

自前の `CfApi.Native` レイヤー。`LibraryImport`、`readonly struct`、関数ポインタ(`delegate* unmanaged`)、`Pack = 8` 明示等、モダン C# の機能をフル活用。

---
