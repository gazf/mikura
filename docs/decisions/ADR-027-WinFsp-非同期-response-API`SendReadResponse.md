## ADR-027: WinFsp 非同期 response API(`SendReadResponse` 系)の温存

**決定**: 採用は当面**見送り**。ただし read-ahead を実装しても Q32 シナリオで並列度の頭打ちが残った場合の次手段として、調査結果を記録しておく。

### 背景

CDM Q32T1 などの「同一 handle に多数並列 IRP を投げる」ベンチマークで、観測された throughput が Q1T1 (160 MB/s) に対し Q32T1 (30 MB/s) と**逆転**する現象を踏んだ。perf-trace で `BackendFileSystem.Read` callback の thread 分布を取ると、`MountEx(ThreadCount=16, Synchronized=false)` を指定しても**実質 2 thread しか dispatch されない**ことが裏取れた。

切り分けの結果、ボトルネックは WinFsp 側ではなく **Windows kernel の Cache Manager が buffered I/O を per-handle 2 outstanding に直列化する設計上限**だと結論した。WinFsp `MaxRead` 系のチューニング knob は .NET binding (`Fsp.FileSystemHost`) に exposed されておらず、Mount/MountEx の `ThreadCount` を上げても効果無し、`Synchronized=false` も効果無し。

これらが空振りした上での「最後の余地」として、binding に存在する `GetOperationRequestHint` / `SendReadResponse` / `SendWriteResponse` / `SendReadDirectoryResponse` および `STATUS_PENDING` を使った**非同期 response パターン**を調査した。

### API の意味

WinFsp の callback は標準では同期で値を返すが、**callback 内で `STATUS_PENDING` を返すと操作が「未完了」のまま保留され、後で `Send*Response(hint, status, bytesTransferred)` を呼ぶことで完了通知できる**(ネイティブの `FspFileSystemSendResponse` を C# から叩く形)。

```csharp
public override int Read(...) {
    var hint = host.GetOperationRequestHint();   // 操作 ID
    Task.Run(async () => {
        try {
            var n = await _backend.ReadAsync(...);
            Marshal.Copy(...);   // IntPtr buffer は SendResponse まで生存保証
            host.SendReadResponse(hint, STATUS_SUCCESS, (uint)n);
        } catch (Exception ex) {
            host.SendReadResponse(hint, MapToNtStatus(ex), 0);
        }
    });
    pBytesTransferred = 0;
    return STATUS_PENDING;       // 即 return、worker thread 解放
}
```

### 期待効果

| 効果 | 確度 |
|---|---|
| WinFsp dispatcher worker thread が backend HTTP 完了を待たず即解放 | **確実**(API 仕様どおり) |
| backend I/O が ThreadPool で並列に進行 | **確実** |
| Cache Manager が「真の async FS」と認識し per-handle 並列上限を緩める可能性 | **未確認**(SMB/NFS 等 kernel-mode redirector が overlapped I/O 前提で動くため、kernel 側が「async なら待たない」と判定する経路が存在する可能性はあるが、WinFsp の user-mode 実装で同等の特権を得られるかは公式 doc に記載なし) |

### コストとリスク

- **buffer lifetime 管理が必須**: `IntPtr buffer` は WinFsp が保持する response 領域で、`SendResponse` を呼ぶまで生存保証される。**二重 response**(API 仕様違反)、**応答忘れ**(IRP リーク → 上位 app が hang)を絶対に出さない実装規律が要る
- **completion 順序が dispatch 順と異なる可能性**: 上位 app は overlapped I/O で発行しているはずなので問題ないが、ロジック上の前提として明記しておく必要あり
- **error path の網羅**: `STATUS_OBJECT_NAME_NOT_FOUND` / `STATUS_NETWORK_UNREACHABLE` / 汎用 IO error を全て `SendReadResponse(hint, ...)` 経由で返す必要あり、抜けると hang
- **`BackendFileSystem` に `FileSystemHost` 参照を保持する変更**(現状 `Init(host0)` で受けて捨てている)
- 実装規模: Read 単体で ~30 行追加、Write / ReadDirectory も同パターン化するなら ~100 行

### 判断

read-ahead(handle-local 先読みバッファ)の方が:

- **効果が予測可能**(kernel の挙動に依存せず、cache hit すれば 0 round-trip という確定論)
- **実装が backend 層で完結**(WinFsp 側の規約を変更しない)
- **失敗しても劣化が穏やか**(先読みが外れた場合は現状と同等の挙動)

なので**第一候補は read-ahead**。本 ADR の async response 化は「read-ahead を入れても Q32 シナリオで満足できる結果が出ない場合の次手段」として温存する。

### 関連 ADR

- 前提: ADR-021(WinFsp 移行で user-mode FS の制約を引き受けた点)、ADR-025(per-IRP HTTP 直流の write 経路)
- 競合候補: read-ahead 実装(別途 ADR 化予定)

---
