using System.Runtime.InteropServices;

namespace WinFsp.Native.Native;

/// <summary>
/// winfsp-x64.dll への P/Invoke 宣言。LibraryImport で source-generator が
/// marshaling コードを compile-time に生成 → AOT 対応、runtime reflection 不要。
/// </summary>
/// <remarks>
/// 旧 winfsp-msil.dll (.NET binding) を経由せず、kernel-mode driver の
/// user-mode stub を直接叩く。signature は winfsp/winfsp.h の <c>FSP_API</c>
/// 関数群 (FspFileSystemCreate / Delete / SetMountPoint / RemoveMountPoint /
/// StartDispatcher / StopDispatcher / SendResponse / GetOperationContext) と一致。
/// </remarks>
internal static partial class NativeApi
{
    private const string DllName = "winfsp-x64.dll";

    /// <summary>
    /// winfsp.h の <c>FSP_FSCTL_DISK_DEVICE_NAME</c> 相当。FspFileSystemCreate に
    /// 第 1 引数として渡す。Disk-style FS (drive letter mount) の場合これ。
    /// Network FS なら <c>"WinFsp.Net"</c> を渡す。
    /// </summary>
    public const string DiskDeviceName = "WinFsp.Disk";

    /// <summary>
    /// <c>FspFileSystemCreate</c>: native FSP_FILE_SYSTEM を確保 + VolumeParams を
    /// 内部 copy + callback interface ポインタを設定。SetMountPoint / StartDispatcher
    /// と組み合わせて初めて IRP dispatch が開始する。
    /// </summary>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemCreate", StringMarshalling = StringMarshalling.Utf16)]
    public static unsafe partial int FspFileSystemCreate(
        string devicePath,
        VolumeParams* volumeParams,
        FspFileSystemInterface* iface,
        nint* pFileSystem);

    /// <summary>
    /// <c>FspFileSystemDelete</c>: native FSP_FILE_SYSTEM の解放。Mount 後は必ず
    /// StopDispatcher → Delete の順。
    /// </summary>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemDelete")]
    public static partial void FspFileSystemDelete(nint fileSystem);

    /// <summary>
    /// <c>FspFileSystemSetMountPoint</c>: drive letter ("Z:") or path 形式の
    /// mount point を kernel に bind。失敗時は IO_REPARSE_TAG エラー等を返す。
    /// </summary>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemSetMountPoint", StringMarshalling = StringMarshalling.Utf16)]
    public static partial int FspFileSystemSetMountPoint(nint fileSystem, string? mountPoint);

    [LibraryImport(DllName, EntryPoint = "FspFileSystemRemoveMountPoint")]
    public static partial void FspFileSystemRemoveMountPoint(nint fileSystem);

    /// <summary>
    /// <c>FspFileSystemStartDispatcher</c>: thread pool を起動し、IRP の受信 +
    /// callback dispatch を開始。threadCount=0 で WinFsp 既定 (typically 2*CPU)。
    /// </summary>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemStartDispatcher")]
    public static partial int FspFileSystemStartDispatcher(nint fileSystem, uint threadCount);

    [LibraryImport(DllName, EntryPoint = "FspFileSystemStopDispatcher")]
    public static partial void FspFileSystemStopDispatcher(nint fileSystem);

    /// <summary>
    /// <c>FspFileSystemSendResponse</c>: STATUS_PENDING で先に return した IRP を
    /// 後から完了通知するための async response API。Response struct は WinFsp 定義の
    /// FSP_FSCTL_TRANSACT_RSP (Hint + Kind + Status + per-operation 出力データ) を
    /// 詰めて渡す。本 PoC では同期 callback のみで使わない。
    /// </summary>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemSendResponse")]
    public static partial void FspFileSystemSendResponse(nint fileSystem, nint pResponse);

    /// <summary>
    /// <c>FspFileSystemPreflight</c>: mount point が有効かを事前検証。
    /// drive letter なら既に使われていないか、path なら親 dir 存在か等。
    /// </summary>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemPreflight", StringMarshalling = StringMarshalling.Utf16)]
    public static partial int FspFileSystemPreflight(string devicePath, string? mountPoint);
}
