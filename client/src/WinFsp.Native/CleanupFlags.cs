namespace WinFsp.Native;

/// <summary>
/// FSP_FSCTL_VOLUME_PARAMS::Cleanup callback の Flags 引数。
/// winfsp.h の <c>FspCleanupDelete</c> 系定数と一致。
/// </summary>
[Flags]
public enum CleanupFlags : uint
{
    None = 0,
    Delete = 0x01,
    SetAllocationSize = 0x02,
    SetArchiveBit = 0x10,
    SetLastAccessTime = 0x20,
    SetLastWriteTime = 0x40,
    SetChangeTime = 0x80,
}
