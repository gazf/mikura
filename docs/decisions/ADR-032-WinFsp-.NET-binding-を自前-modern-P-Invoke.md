## ADR-032: WinFsp .NET binding を自前 modern P/Invoke に置き換え

**決定**: 公式 `winfsp-msil.dll` (delegate-based .NET binding) への依存を撤去し、`LibraryImport` (source-generator P/Invoke) + `delegate* unmanaged[Cdecl]` 関数ポインタ + `[UnmanagedCallersOnly]` static trampoline で構成された自前 binding (`WinFsp.Native` project) を実装、`BackendFileSystem` / `BackendFileSystemHost` の唯一の経路に据える。`UmFileContextIsUserContext2` flag を必ず立て、FileContext は monotonic ID + `ConcurrentDictionary` で管理 (`GCHandle` 不採用)。AOT-ready (analyzer warnings 0)。

### 背景

ADR-021 で CfApi → WinFsp に migrate した後、binding は `winfsp-msil.dll` を経由していた。判明した制約・痛み:

- **per-IRP overhead**: delegate marshaling + runtime reflection callback registration が hot path で常時走る
- **黒箱の Synchronized=true 依存**: legacy `Fsp.FileSystemHost` は内部で callback を直列化していて、mikura 側の path-keyed lock / session refcount コードはその暗黙の整列順序に乗っかっていた。CPU 100% 切り分け時に「並列 callback で race するのか直列のままなのか」を確かめる手段が無く、調査が詰まった
- **AOT 不可**: reflection / delegate marshaling 依存で `<IsAotCompatible>true</IsAotCompatible>` の analyzer を通せない (= 将来 reflection-free 化の足枷)
- **upstream の挙動を変えられない**: バグ・wording・default flag (= 後述 `UmFileContextIsUserContext2`) を自分で握れない

参考として hooyao/winfsp-native (MIT) の API design を確認したが、外部依存を増やさず学習も兼ねて **自前実装方針** を採った (詳細は後述「採用しなかった代案」)。

### 設計

#### 構成

- `WinFsp.Native` project: `IFileSystem` (sync NTSTATUS callback) + 任意実装の `IAsyncFileIo` (`ValueTask<ReadResult>` / `ValueTask<WriteResult>`)、`FileSystemHost` orchestrator、`NativeApi` (LibraryImport)、blittable struct (`VolumeParams` / `TransactRsp` / `NativeFileInfo` 等)
- `WinFsp.Interop` project: mikura の `IFileSystemBackend` ↔ `IFileSystem` adapter (`BackendFileSystem`)、`FileSystemHost` lifecycle wrapper (`BackendFileSystemHost`)
- `Mikura.Core` 側 API (`IFileSystemBackend` / `FileSystemBackend`) は無変更で、binding 差し替えで透過的に動く

#### 核となる選択

- **`LibraryImport` (source-gen P/Invoke)**: compile-time に marshaling stub 生成、runtime reflection ゼロ
- **`delegate* unmanaged[Cdecl]<...>` + `[UnmanagedCallersOnly]`**: callback table を直接 ABI 通りに populate、delegate alloc / marshaling 除去
- **`VolumeParams` は fully blittable struct**: `fixed char[]` で inline 配列、`fixed (VolumeParams* p = &vp)` で native に渡せる構造 (`string` + `MarshalAs ByValTStr` だと in-memory と marshaled で layout が乖離して `*` 渡しが壊れる罠を回避)
- **sync `IFileSystem` + optional `IAsyncFileIo`**: hooyao 流の「全 method `ValueTask` 必須」だと in-memory FS にも `ValueTask` overhead を強要するため、sync 経路を default にして HTTP backed なら `IAsyncFileIo` を併せ実装する分離設計を採用
- **`AsyncCompletion`**: STATUS_PENDING + `FspFileSystemSendResponse` の async response 経路。`TransactRsp` (固定 128B blittable) は `stackalloc` で確保して `&rsp` 直渡し、per-IRP の native heap alloc 0
- **FileContext lifecycle**: `GCHandle.Alloc` + `ToIntPtr` を使わず、自前の `Interlocked.Increment` で発番した `long` ID を `ConcurrentDictionary<long, object>` で管理する。`Free` 後の ID 再発行が構造上不可能 → use-after-free 排除 (詳細は後述 Bug 3 教訓)
- **AOT-ready**: `<IsAotCompatible>true</IsAotCompatible>` を `WinFsp.Native` / `WinFsp.Interop` 両 csproj に固定。reflection 混入時に build 時 warning として弾く regression net

### 過程で表面化した既存 bug と教訓

binding 切替え自体は機能等価 migration だったが、移行検証で表面化した 5 件の bug が含む共通教訓を documenting しておく。

#### 1. `winfsp-msil` の `Synchronized=true` が隠していた race

並列 callback dispatch で `path-keyed lock` / `session refcount` の整列順序を保つ責務が mikura 側 backend にあった事が legacy 時代は見えていなかった。新 binding (= 並列 dispatch がデフォルト) で初めて表面化し、`shouldUpload = h.HasLock && (...)` 形式に整理することで「同じ Create handle に kernel が 2 度 Cleanup を post する」異常パターンを HasLock=false で吸収できる構造にした。

教訓: **暗黙の直列化に依存した責務分担は、binding を入れ替えた瞬間に露見する**。整列順序は binding 側に押し付けず、backend 側の不変式で守る。

#### 2. faulted `TaskCompletionSource` の unobserved exception

`AcquireSessionSlotAsync` の first caller が StartUpload で 403 を喰らった時に `TrySetException` で TCS を faulted 化していた。second caller がいないと `Task.Exception` が誰にも読まれず、GC finalizer 経由で `TaskScheduler.UnobservedTaskException` として **30 秒遅れ** で発火する罠。

教訓: **TCS を faulted にしたら同期的に `_ = TCS.Task.Exception` で observed 化**する (後続が await して再 throw する分には同じ `AggregateException` を読み出すだけで副作用なし)。

#### 3. `GCHandle` slot 再利用 = use-after-free

`GCHandle.Alloc` + `ToIntPtr` を fileContext として WinFsp に渡す教科書通りの実装が、`Free` 後の slot 再利用で別 managed object (実機観測: `System.Threading.Thread` が同 slot に着地) を unrelated callback で参照する race を発生させた。`InvalidCastException` から `UnmanagedCallersOnly` callback 経由で process 終了 (`[FATAL] AppDomain.UnhandledException terminating=True`)。

教訓: **`GCHandle.ToIntPtr` は教科書的だが production の churn 下では壊れる**。自前 monotonic ID + dict のほうが安全 (per-IRP lookup cost ~30ns、無視可能)。GC root にしないが、長寿命の参照は backend 側 collection に張ってあるので leak しない。

#### 4. `UmFileContextIsUserContext2` を立てないと FileContext が path 単位共有

WinFsp 既定では FileContext を **FileNode の `UserContext`** として扱う (= 同一 path への全 Open で共有)。我々が Open ごとに新 ID を返しても、後続 IRP の fileContext は Create handle の ID で上書きされ、Read open の Read IRP が Create handle (`FreshlyCreated=true`) を経由して **`ReadAsync` の zero-fill 早期 return** に落ちる。実機で **書いた 64MiB と一致しない全 byte ゼロが返る**症状を再現。

教訓: **WinFsp のデフォルトは FileNode shared**。per-Create 独立を期待するなら **`UmFileContextIsUserContext2` を必ず set**する。WinFsp の参考実装 (hooyao 含む) では言及が薄く、自分で踏むまで気付かない種類の罠。test は `VolumeParamsFlagsTests.UmFileContextIsUserContext2_BitSet_HasExpectedRawValue` で bit 番号と raw 値 (`0x10000`) を固定。

#### 5. `PrefetchCache` partial hit を zero-fill していた (binding と無関係の既存バグ)

ADR-031 prefetch 実装以来潜在していた Mikura.Core 側 bug。3 連続 sequential read で prefetch が armed され、要求 byte の 2x をサーバから取得して **余剰を per-handle cache に格納**する。直後の read が cache offset と一致しつつ要求サイズ > cache 保有量のケース (例: 64KB IRP の後に 1MB IRP の mixed IRP size workload) で、旧コードは cache 分を返したあと残り byte を `Span.Clear()` で **zero-fill** していた。結果、caller (kernel → application) には「先頭は実 byte、後半は zero」の混合データが返り、**ZIP CRC 検証や XML parser で破損として検出される** (Excel / Word 等 zip container 開封時の「ファイルレベルの検証と修復」)。修正は partial hit を検出したら `offset += cachedBytes` で残り分を server fetch 経路に **fall through** させる形に。

教訓: **「通常ここには来ない (safety net)」コメントは大抵間違っている**。mixed IRP size の workload は普通に存在する。`Span.Clear()` を safety net として書いた場合はそれが起こったときの **副作用 (corrupt data) と起こりうる場面** をちゃんと考える。binding 移行が無くても踏むバグだったが、新 binding 採用検証で xlsm ファイルを試したことで初めて顕在化した。

### Trade-off 整理

| 観点 | 評価 |
|---|---|
| per-IRP overhead | delegate marshaling 廃止 + stackalloc 化で **per-IRP native heap alloc 0**、managed alloc は `UnmanagedMemoryManager` class (~24B) + `async Task` state machine box のみ |
| 性能 (CDM) | SEQ R/W 数百 MB/s、RND4K Q=1 W で legacy 比 +18% (per-IRP `Trace.WriteLine` 撤去の効果が乗った)。RND4K の CPU 100% は WinFsp CSQ spinlock 構造的問題で binding 層では届かない (= legacy 同等) |
| AOT-readiness | `<IsAotCompatible>true</IsAotCompatible>` を analyzer green で固定、reflection 混入の regression net 確立。実 AOT publish は `Mikura.App` (WinForms) が引っ張るため未対応、binding 単独では可能 |
| 並行性の制御感 | dispatcher thread 数を `MIKURA_NATIVE_THREADCOUNT` で外から制御可能 (debug escape hatch、1=serialized で legacy 同等)、`MIKURA_NATIVE_TRACE` で per-IRP 観測も可 |
| ABI risk | WinFsp upstream の struct layout 変更で壊れる risk を引き取る (`VolumeParams` 504B / `TransactRsp` 128B / `NativeFileInfo` 72B 等の固定値を `WinFsp.Native.Tests` で常時 assert)。実 driver 側互換は `WinFsp.Native.IntegrationTests` (Windows + WinFsp 実機 mount) で end-to-end check |
| 学習コスト | WinFsp 仕様 (callback table / NTSTATUS / VolumeParams flag / `FspFileSystemSendResponse` 等) を自分で把握する負担を引き取る。代わりに「binding の挙動を理解していないと 5 件の bug は debug できない」状態を解消 |

### 採用しなかった代案

- **`winfsp-msil` 継続使用**: per-IRP marshaling overhead を許容、CPU 100% 切り分け不能な状態の継続、AOT 不可、debug 不能の binding バグへの対応無策。defer の defer になる
- **hooyao/winfsp-native への依存**: MIT、3 ⭐、API design は近い。ただし (a) FileContext は `GCHandle.Alloc` ベース (= 上記 Bug 3 を踏む risk)、(b) FileSystem method が全て `ValueTask` 必須で sync-only backend に overhead を強要、(c) async response の `FspTransactRsp` を closure local として捕捉 (= heap promote) で stackalloc 化の道が遠い、(d) `UmFileContextIsUserContext2` の意義への言及なし。production grade に乗せるには結局 fork して直す事になるので、最初から自前にした
- **WinFsp upstream に PR**: 仕様変更 (`UmFileContextIsUserContext2` を default ON にする等) は upstream 側破壊的変更で受け入れにくい、待ち時間も読めない。自前 binding なら自分で握れる
- **drvfs / NFS 等 別 FS**: そもそも mikura は ADR-021 で CfApi → WinFsp を選択済み、本 ADR の scope ではない

### 関連 ADR / コード

- 前提: ADR-021 (WinFsp 移行)、ADR-022 (lock スコープ)、ADR-025 (chunked upload)、ADR-027 (per-handle 2-outstanding 制約)、ADR-031 (prefetch)
- 関連: ADR-031 (本 ADR の Bug 5 修正で挙動が変わる、ただし設計意図は維持)
- 実装:
  - [`WinFsp.Native/FileSystemHost.cs`](../client/src/WinFsp.Native/FileSystemHost.cs): `FspFileSystemInterface` populate + callback trampoline + FileContext lifecycle (monotonic ID + dict)
  - [`WinFsp.Native/AsyncCompletion.cs`](../client/src/WinFsp.Native/AsyncCompletion.cs): STATUS_PENDING + stackalloc `TransactRsp` + `FspFileSystemSendResponse`
  - [`WinFsp.Native/Native/VolumeParams.cs`](../client/src/WinFsp.Native/Native/VolumeParams.cs) / [`NativeApi.cs`](../client/src/WinFsp.Native/Native/NativeApi.cs): blittable struct + LibraryImport
  - [`WinFsp.Interop/BackendFileSystem.cs`](../client/src/WinFsp.Interop/BackendFileSystem.cs) / [`BackendFileSystemHost.cs`](../client/src/WinFsp.Interop/BackendFileSystemHost.cs): mikura `IFileSystemBackend` adapter
- 検証:
  - [`WinFsp.Interop.Tests/BackendFileSystemTests.cs`](../client/tests/WinFsp.Interop.Tests/BackendFileSystemTests.cs): intent 分類 / NTSTATUS 変換 / Cleanup flag mapping 等の責務固定
  - [`WinFsp.Native.Tests/VolumeParamsTests.cs`](../client/tests/WinFsp.Native.Tests/VolumeParamsTests.cs): struct layout + bit 番号 (特に `UmFileContextIsUserContext2`=bit 16) を固定
  - [`WinFsp.Native.IntegrationTests/MountRoundtripTests.cs`](../client/tests/WinFsp.Native.IntegrationTests/MountRoundtripTests.cs): 実 WinFsp driver mount + R/W roundtrip + Bug 4 regression、`[SkippableFact]` で WinFsp 未 install 環境では自動 skip
  - [`Mikura.Core.Tests/FileSystem/FileSystemBackendTests.cs`](../client/tests/Mikura.Core.Tests/FileSystem/FileSystemBackendTests.cs) の `Cleanup_AfterLockAlreadyReleased_DoesNotReAttemptUpload` / `Read_PartialPrefetchHit_FallsThroughToServerInsteadOfZeroFill` (どちらも旧条件に戻すと確実に fail することを逆転検証)
