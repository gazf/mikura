using System.Runtime.InteropServices;

namespace WinFsp.Native.Native;

/// <summary>
/// FSP_FSCTL_VOLUME_PARAMS — winfsp/fsctl.h:255-265 の C struct を C# にミラー。
/// V0 + V1 で計 504 bytes (winfsp の static assert と一致)。
/// </summary>
/// <remarks>
/// bitfield (V0: ~25 bit + V1: 5 bit + padding) は C# で表現できないので、UInt32 1
/// 個に packed して setter で位置を計算する。<see cref="Flags1"/> / <see cref="Flags2"/>
/// が V0 の 2 つの bitfield ブロック、<see cref="V1Flags"/> が V1 の bitfield。
/// 詳細な bit 配置は <see cref="VolumeParamsFlags"/> 参照。
/// </remarks>
[StructLayout(LayoutKind.Sequential, Size = 504)]
public struct VolumeParams
{
    public ushort Version;
    public ushort SectorSize;
    public ushort SectorsPerAllocationUnit;
    public ushort MaxComponentLength;
    public ulong VolumeCreationTime;
    public uint VolumeSerialNumber;

    public uint TransactTimeout;
    public uint IrpTimeout;
    public uint IrpCapacity;
    public uint FileInfoTimeout;

    // V0 bitfield #1 (FILE_FS_ATTRIBUTE_INFORMATION + kernel-mode flags): 16 bit 使用
    //   bit 0: CaseSensitiveSearch
    //   bit 1: CasePreservedNames
    //   bit 2: UnicodeOnDisk
    //   bit 3: PersistentAcls
    //   bit 4: ReparsePoints
    //   bit 5: ReparsePointsAccessCheck
    //   bit 6: NamedStreams
    //   bit 7: HardLinks (未実装、0 固定)
    //   bit 8: ExtendedAttributes
    //   bit 9: ReadOnlyVolume
    //   bit 10: PostCleanupWhenModifiedOnly
    //   bit 11: PassQueryDirectoryPattern
    //   bit 12: AlwaysUseDoubleBuffering
    //   bit 13: PassQueryDirectoryFileName
    //   bit 14: FlushAndPurgeOnCleanup
    //   bit 15: DeviceControl
    public uint Flags1;

    // V0 bitfield #2 (user/kernel mode flags, 残り 16 bit):
    //   bit 0: UmFileContextIsUserContext2
    //   bit 1: UmFileContextIsFullContext
    //   bit 2: UmNoReparsePointsDirCheck
    //   bit 3-7: UmReservedFlags (5 bit)
    //   bit 8: AllowOpenInKernelMode
    //   bit 9: CasePreservedExtendedAttributes
    //   bit 10: WslFeatures
    //   bit 11: DirectoryMarkerAsNextOffset
    //   bit 12: RejectIrpPriorToTransact0
    //   bit 13: SupportsPosixUnlinkRename
    //   bit 14: PostDispositionWhenNecessaryOnly
    //   bit 15: KmReservedFlags
    public uint Flags2;

    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 192 / 2)]
    public string Prefix; // FSP_FSCTL_VOLUME_PREFIX_SIZE = 192 bytes (96 WCHARs)

    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 16)]
    public string FileSystemName; // FSP_FSCTL_VOLUME_FSNAME_SIZE = 32 bytes (16 WCHARs)

    // ── V1 fields ──
    // V1 bitfield: 5 個の *TimeoutValid bit + reserved
    //   bit 0: VolumeInfoTimeoutValid
    //   bit 1: DirInfoTimeoutValid
    //   bit 2: SecurityTimeoutValid
    //   bit 3: StreamInfoTimeoutValid
    //   bit 4: EaTimeoutValid
    public uint V1Flags;

    public uint VolumeInfoTimeout;
    public uint DirInfoTimeout;
    public uint SecurityTimeout;
    public uint StreamInfoTimeout;
    public uint EaTimeout;
    public uint FsextControlCode;
    public uint Reserved32;
    public ulong Reserved64_0;
    public ulong Reserved64_1;
}

/// <summary>
/// VolumeParams の bitfield 位置定数。Flags1 / Flags2 の bit 番号を name 付きで扱う。
/// </summary>
public static class VolumeParamsFlags
{
    // Flags1
    public const int CaseSensitiveSearch = 0;
    public const int CasePreservedNames = 1;
    public const int UnicodeOnDisk = 2;
    public const int PersistentAcls = 3;
    public const int ReparsePoints = 4;
    public const int ReparsePointsAccessCheck = 5;
    public const int NamedStreams = 6;
    public const int ExtendedAttributes = 8;
    public const int ReadOnlyVolume = 9;
    public const int PostCleanupWhenModifiedOnly = 10;
    public const int PassQueryDirectoryPattern = 11;
    public const int AlwaysUseDoubleBuffering = 12;
    public const int PassQueryDirectoryFileName = 13;
    public const int FlushAndPurgeOnCleanup = 14;
    public const int DeviceControl = 15;

    // Flags2
    public const int UmFileContextIsUserContext2 = 0;
    public const int UmFileContextIsFullContext = 1;
    public const int UmNoReparsePointsDirCheck = 2;
    public const int AllowOpenInKernelMode = 8;
    public const int CasePreservedExtendedAttributes = 9;
    public const int WslFeatures = 10;
    public const int DirectoryMarkerAsNextOffset = 11;
    public const int SupportsPosixUnlinkRename = 13;
    public const int PostDispositionWhenNecessaryOnly = 14;

    // V1Flags
    public const int VolumeInfoTimeoutValid = 0;
    public const int DirInfoTimeoutValid = 1;
    public const int SecurityTimeoutValid = 2;
    public const int StreamInfoTimeoutValid = 3;
    public const int EaTimeoutValid = 4;

    public static void Set(ref uint flagsField, int bit, bool value)
    {
        if (value) flagsField |= (1u << bit);
        else flagsField &= ~(1u << bit);
    }

    public static bool Get(uint flagsField, int bit) => (flagsField & (1u << bit)) != 0;
}
