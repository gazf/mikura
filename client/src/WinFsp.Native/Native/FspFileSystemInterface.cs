using System.Runtime.InteropServices;

namespace WinFsp.Native.Native;

/// <summary>
/// FSP_FILE_SYSTEM_INTERFACE — winfsp/winfsp.h の callback table。
/// 全 callback は <c>unsafe delegate*&lt;...&gt;</c> 形式の native function pointer。
/// </summary>
/// <remarks>
/// <para>各 callback は WinFsp dispatcher thread から native ABI で呼ばれる。我々が
/// 提供する側は <c>[UnmanagedCallersOnly(CallConvs=[typeof(CallConvCdecl)])]</c> を
/// 付けた static method を function pointer 化して詰める (<see cref="FileSystemHost"/>
/// 参照)。delegate-based binding (winfsp-msil) と違って delegate alloc / marshaling
/// が runtime で発生しないため per-IRP overhead が削れる。</para>
/// <para>引数の型対応:
///   FSP_FILE_SYSTEM*       → nint (= IntPtr)
///   PVOID FileContext      → nint (我々が <c>GCHandle</c> をここに置く)
///   PWSTR FileName         → nint (UTF-16 null-terminated、寿命は callback 中のみ)
///   FSP_FSCTL_*_INFO*      → ポインタ (<see cref="NativeFileInfo"/>* 等)
///   NTSTATUS               → int
///   BOOLEAN                → byte (1 byte だが COM とは違い nonzero=true)</para>
/// <para>未実装スロットは <c>null</c> 関数ポインタにしておく。WinFsp は null を
/// 「FS は当該操作をサポートしない」と解釈してくれる。Reserved[31] スロットは
/// レイアウト位置合わせ専用、touch しない。</para>
/// </remarks>
[StructLayout(LayoutKind.Sequential)]
public unsafe struct FspFileSystemInterface
{
    public delegate* unmanaged[Cdecl]<nint, NativeVolumeInfo*, int> GetVolumeInfo;
    public delegate* unmanaged[Cdecl]<nint, nint, NativeVolumeInfo*, int> SetVolumeLabel;
    public delegate* unmanaged[Cdecl]<nint, nint, uint*, nint, nuint*, int> GetSecurityByName;

    public delegate* unmanaged[Cdecl]<nint, nint, uint, uint, uint, nint, ulong, nint*, NativeFileInfo*, int> Create;
    public delegate* unmanaged[Cdecl]<nint, nint, uint, uint, nint*, NativeFileInfo*, int> Open;
    public delegate* unmanaged[Cdecl]<nint, nint, uint, byte, ulong, NativeFileInfo*, int> Overwrite;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, uint, void> Cleanup;
    public delegate* unmanaged[Cdecl]<nint, nint, void> Close;

    public delegate* unmanaged[Cdecl]<nint, nint, nint, ulong, uint, uint*, int> Read;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, ulong, uint, byte, byte, uint*, NativeFileInfo*, int> Write;
    public delegate* unmanaged[Cdecl]<nint, nint, NativeFileInfo*, int> Flush;

    public delegate* unmanaged[Cdecl]<nint, nint, NativeFileInfo*, int> GetFileInfo;
    public delegate* unmanaged[Cdecl]<nint, nint, uint, ulong, ulong, ulong, ulong, NativeFileInfo*, int> SetBasicInfo;
    public delegate* unmanaged[Cdecl]<nint, nint, ulong, byte, NativeFileInfo*, int> SetFileSize;

    public delegate* unmanaged[Cdecl]<nint, nint, nint, int> CanDelete;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, nint, byte, int> Rename;

    public delegate* unmanaged[Cdecl]<nint, nint, nint, nuint*, int> GetSecurity;
    public delegate* unmanaged[Cdecl]<nint, nint, uint, nint, int> SetSecurity;

    public delegate* unmanaged[Cdecl]<nint, nint, nint, nint, nint, uint, uint*, int> ReadDirectory;

    // 以下は本 PoC では未対応。signature だけ定義して null で置く。
    public delegate* unmanaged[Cdecl]<nint, nint, uint, byte, nint, nuint*, int> ResolveReparsePoints;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, nint, nuint*, int> GetReparsePoint;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, nint, nuint, int> SetReparsePoint;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, nint, nuint, int> DeleteReparsePoint;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, uint, uint*, int> GetStreamInfo;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, NativeFileInfo*, int> GetDirInfoByName;
    public delegate* unmanaged[Cdecl]<nint, nint, uint, nint, uint, nint, uint, uint*, int> Control;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, byte, int> SetDelete;
    public delegate* unmanaged[Cdecl]<nint, nint, uint, uint, uint, nint, ulong, nint, uint, byte, nint*, NativeFileInfo*, int> CreateEx;
    public delegate* unmanaged[Cdecl]<nint, nint, uint, byte, ulong, nint, uint, NativeFileInfo*, int> OverwriteEx;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, uint, uint*, int> GetEa;
    public delegate* unmanaged[Cdecl]<nint, nint, nint, uint, NativeFileInfo*, int> SetEa;
    public delegate* unmanaged[Cdecl]<void> Obsolete0;
    public delegate* unmanaged[Cdecl]<nint, byte, void> DispatcherStopped;

    // FSP_FILE_SYSTEM_INTERFACE は末尾に Reserved[31] (PVOID = nint × 31 = 248 bytes)
    // を持つ。struct size を ABI 通りに合わせるため fixed buffer で埋める。
    public fixed long Reserved[31];
}
