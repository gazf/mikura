## ADR-023: in-memory staging buffer の設計と上限

**決定**: 編集中ファイルのデータは **per-handle の `byte[]` バッファに in-memory で staging** する。バッファは `ArrayPool<byte>` から rent して capacity-doubling で拡張する。**1 ファイル ≤ 2GB の制約**を受け入れる(`int.MaxValue` 制限)。それ以上は ADR-024 で対応する想定。

**設計**:

```
ServerHandle
├─ byte[] _buffer       (ArrayPool レンタル、capacity)
├─ long _length         (論理コンテンツ長 ≤ buffer.Length)
├─ bool _bufferRented   (返却対象か)
├─ EnsureCapacity(N)    (doubling growth、Rent → BlockCopy → Return old)
├─ EnsureHydratedAsync  (server からの単一 alloc fetch)
└─ DropBuffer           (Cleanup 時に Return)

ArrayPool<byte>.Create(maxArrayLength: 32MB, maxArraysPerBucket: 8)
   ↑ 全 ServerHandle で共有、再利用で LOH garbage 蓄積を抑制
```

**メモリプロファイル**(10MB ファイル コピー時の実測推移):

| 段階 | resident memory |
|---|---|
| 初版(各 Write で `new byte[newLength]`、O(N²)alloc)| ~120 MB |
| capacity-doubling 導入 | ~96 MB |
| hydrate を MemoryStream+ToArray から単一 alloc に変更 | ~59 MB |
| ArrayPool レンタル化 | ~30 MB(8 ファイル並行コピーで ~84 MB に bound)|

**重要な実装ポイント**:

1. **SetFileSize(allocationHint=true) を活用してプリアロケート**
   shell の CopyFileEx は書き込み前に `SetEndOfFile(N)` を呼ぶ。これを `EnsureCapacity(N)` に直結すると、buffer の段階的 doubling resize に伴う中間 byte[] の garbage(~16MB ぶん)が発生せず、1 回で確定サイズを確保できる。

2. **WriteAsync の gap 埋めゼロ化**
   ArrayPool レンタル byte[] は **ゼロクリアされない**(prior renter のデータが残る)。kernel の non-sequential write で `[existingLen..writeOffset)` に gap ができた場合、そこを `Array.Clear` で明示的にゼロ化しないと、別ハンドルで扱った機密データがそのまま upload される(セキュリティ・整合性問題)。

3. **WinFsp callback 経路の per-IRP marshal buffer も `ArrayPool<byte>.Shared` で pool 化**
   `MikuraFileSystem.Read` / `Write` の `IntPtr ↔ byte[]` の中継バッファ(典型 4〜64 KB)を毎回 `new byte[length]` していたが、ArrayPool レンタルにして per-IRP allocation を排除。

**上限とトレードオフ**:

- **1 ファイルあたり 2GB**(`int.MaxValue` で `OverflowException`)
- **1 ファイルサイズ ≒ クライアントメモリ**(ハンドル open〜close の間)
- 同時並行操作数 × ファイルサイズ がメモリ占有のオーダ
- LAN 上のオフィス用途(数 MB 〜 数十 MB のファイル)では十分実用範囲
- 大容量ファイル(GB 級)は ADR-024 で別途対応

**Known limitations(運用前の周知事項)**:

- 2GB 超のファイルは現状アップロード不可
- 1GB ファイルを送るとプロセスメモリ ≒ 1GB が必要
- 1 ファイル = 1 PUT リクエストで送信、途中切断で先頭から再送
- 進捗表示・レジューム・並列チャンク送信はすべて未対応

**実装場所**:

- `client/src/Mikura.Core/Sync/MikuraServerBackend.cs` の `ServerHandle` クラス、`EnsureCapacity` / `EnsureHydratedAsync` / `WriteAsync` / `DropBuffer`
- `client/src/WinFsp.Interop/MikuraFileSystem.cs` の `Read` / `Write` callback の ArrayPool 化

**関連 ADR**:

- 前提: ADR-021(WinFsp 移行で kernel cache を持たず、user-mode buffer に staging する原則)
- 拡張: ADR-024(GB 級ファイル対応の chunked / resumable upload)

---
