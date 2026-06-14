namespace WinFsp.Native.Native;

/// <summary>
/// FSP_FSCTL_TRANSACT_REQ.Kind / FSP_FSCTL_TRANSACT_RSP.Kind の enum 値。
/// winfsp/fsctl.h:152-178 と一致。
/// </summary>
public enum FspFsctlTransactKind : uint
{
    Reserved = 0,
    Create = 1,
    Overwrite = 2,
    Cleanup = 3,
    Close = 4,
    Read = 5,
    Write = 6,
    QueryInformation = 7,
    SetInformation = 8,
    QueryEa = 9,
    SetEa = 10,
    FlushBuffers = 11,
    QueryVolumeInformation = 12,
    SetVolumeInformation = 13,
    QueryDirectory = 14,
    FileSystemControl = 15,
    DeviceControl = 16,
    Shutdown = 17,
    LockControl = 18,
    QuerySecurity = 19,
    SetSecurity = 20,
    QueryStreamInformation = 21,
}
