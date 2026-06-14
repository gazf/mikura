using System.Runtime.InteropServices;

namespace WinFsp.Native.Native;

/// <summary>
/// FSP_FSCTL_NOTIFY_INFO — winfsp/fsctl.h:322-328。12 byte 固定 header + 末尾
/// <c>WCHAR FileNameBuf[]</c>。<see cref="NativeApi.FspFileSystemNotify"/> に渡す。
/// </summary>
[StructLayout(LayoutKind.Sequential, Size = 12)]
public struct NotifyInfo
{
    /// <summary>entry total size (header 12 + name byte 数、4-byte 倍数に padding 推奨)。</summary>
    public ushort Size;
    /// <summary>FILE_NOTIFY_INFORMATION の Filter (FILE_NOTIFY_CHANGE_*).</summary>
    public uint Filter;
    /// <summary>FILE_NOTIFY_INFORMATION の Action (FILE_ACTION_ADDED 等).</summary>
    public uint Action;
    // FileNameBuf[] = flexible
}

/// <summary>FILE_NOTIFY_CHANGE_* flag values。winfsp/fsctl.h と一致。</summary>
[Flags]
public enum NotifyFilter : uint
{
    FileName = 0x01,
    DirName = 0x02,
    Attributes = 0x04,
    Size = 0x08,
    LastWrite = 0x10,
    LastAccess = 0x20,
    Creation = 0x40,
    Security = 0x100,
}

/// <summary>FILE_ACTION_* enum values。</summary>
public enum NotifyAction : uint
{
    Added = 1,
    Removed = 2,
    Modified = 3,
    RenamedOldName = 4,
    RenamedNewName = 5,
}
