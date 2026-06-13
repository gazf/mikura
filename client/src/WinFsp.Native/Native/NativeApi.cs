using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Win32;

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
///
/// <para>DLL 解決: WinFsp は <c>%ProgramFiles(x86)%\WinFsp\bin\winfsp-x64.dll</c>
/// に install される。default PATH には含まれないので、process 起動時に明示的に
/// resolver を仕込んで、Registry (HKLM\SOFTWARE\WOW6432Node\WinFsp\InstallDir) か
/// 既定パスから探す。</para>
/// </remarks>
internal static partial class NativeApi
{
    private const string DllName = "winfsp-x64.dll";

    static NativeApi()
    {
        NativeLibrary.SetDllImportResolver(typeof(NativeApi).Assembly, Resolve);
    }

    private static nint Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (!string.Equals(libraryName, DllName, StringComparison.OrdinalIgnoreCase))
            return 0;

        foreach (var path in CandidatePaths())
        {
            if (File.Exists(path) && NativeLibrary.TryLoad(path, out var handle))
                return handle;
        }
        // 最終手段: default search path に任せる (PATH 等が通っていれば拾える)
        return NativeLibrary.TryLoad(libraryName, out var fallback) ? fallback : 0;
    }

    private static IEnumerable<string> CandidatePaths()
    {
        // 1) Registry: HKLM\SOFTWARE\WOW6432Node\WinFsp\InstallDir (x64 host, 32-bit MSI)
        string? installDir = null;
        try
        {
            using var key = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32)
                .OpenSubKey(@"SOFTWARE\WinFsp");
            installDir = key?.GetValue("InstallDir") as string;
        }
        catch { /* registry permission 等は無視 */ }
        if (!string.IsNullOrEmpty(installDir))
            yield return Path.Combine(installDir, "bin", DllName);

        // 2) 既定 install パス
        var pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        if (!string.IsNullOrEmpty(pf86))
            yield return Path.Combine(pf86, "WinFsp", "bin", DllName);

        var pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (!string.IsNullOrEmpty(pf))
            yield return Path.Combine(pf, "WinFsp", "bin", DllName);
    }

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

    /// <summary>
    /// <c>FspFileSystemGetOperationContext</c>: 現在 dispatcher thread で処理中の
    /// IRP の <see cref="OperationContext"/> ポインタを返す。Hint と Kind を取り出して
    /// 非同期 response (STATUS_PENDING) 経路の準備に使う。
    /// 戻り値の Request / Response 寿命は callback return まで。
    /// </summary>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemGetOperationContext")]
    public static unsafe partial OperationContext* FspFileSystemGetOperationContext();

    /// <summary>
    /// <c>FspFileSystemAddDirInfo</c>: directory entry を ReadDirectory の出力 buffer
    /// に追加。<paramref name="dirInfo"/> = null で EOF marker。<paramref name="dirInfo"/>
    /// の <see cref="DirInfo.Size"/> は header(104) + name_bytes を含む total size。
    /// </summary>
    /// <returns>buffer に書けたら true。容量不足 (= caller は ReadDirectory を成功 status
    /// で抜けて、次回 marker 経由で続きを返す) なら false。</returns>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemAddDirInfo")]
    [return: MarshalAs(UnmanagedType.U1)]
    public static unsafe partial bool FspFileSystemAddDirInfo(
        void* dirInfo, void* buffer, uint length, uint* pBytesTransferred);

    /// <summary>
    /// <c>FspFileSystemNotifyBegin</c>: kernel 側 cache invalidation の通知 transaction
    /// 開始。rename 競合があると待たされる、<paramref name="timeoutMs"/> で打切り。
    /// </summary>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemNotifyBegin")]
    public static partial int FspFileSystemNotifyBegin(nint fileSystem, uint timeoutMs);

    [LibraryImport(DllName, EntryPoint = "FspFileSystemNotifyEnd")]
    public static partial int FspFileSystemNotifyEnd(nint fileSystem);

    /// <summary>
    /// <c>FspFileSystemNotify</c>: 1 個以上の <see cref="NotifyInfo"/> を flat な byte
    /// stream として渡す。各 entry の Size 自身に header(12) + name_bytes、続けて配置。
    /// </summary>
    [LibraryImport(DllName, EntryPoint = "FspFileSystemNotify")]
    public static unsafe partial int FspFileSystemNotify(nint fileSystem, void* notifyInfo, nuint size);
}
