using System.Runtime.InteropServices;

namespace WinFsp.Native.Native;

/// <summary>
/// FSP_FSCTL_VOLUME_PARAMS — winfsp/fsctl.h:255-265 の C struct を C# にミラー。
/// V0 (456 byte) + V1 (48 byte) = 504 byte (winfsp の static assert と一致)。
/// </summary>
/// <remarks>
/// <para>このまま <c>*</c> ポインタとして native に渡す必要があるため、<b>fully blittable</b>
/// (managed reference 含まない) であること必須。<c>fixed char[]</c> による inline 配列で
/// Prefix / FileSystemName を保持し、<see cref="SetPrefix"/> / <see cref="SetFileSystemName"/>
/// でセットする。C# の <c>string</c> フィールド + <c>[MarshalAs ByValTStr]</c> 形式は
/// in-memory layout (8byte ref) と marshaled layout (384byte inline char) が乖離するため、
/// <c>fixed (VolumeParams* p = &amp;vp)</c> 経由で native に渡すと layout が壊れる。</para>
/// <para>V0 サイズ内訳: 40 (regular) + 4 (bitfield) + 384 (Prefix) + 32 (FsName) = 456。
/// V1 サイズ内訳: 4 (bitfield) + 28 (timeouts + reserved32) + 16 (reserved64×2) = 48。
/// 合計 504、static assert 一致。</para>
/// </remarks>
[StructLayout(LayoutKind.Sequential)]
public unsafe struct VolumeParams
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

    /// <summary>V0 bitfield 全 32bit。<see cref="VolumeParamsFlags"/> の bit 番号で操作。</summary>
    public uint Flags;

    /// <summary>UNC prefix (\Server\Share)。WCHAR[192] inline、空 OK。</summary>
    public fixed char Prefix[192];

    /// <summary>表示用 FS 名 (例: "NTFS")。WCHAR[16] inline。</summary>
    public fixed char FileSystemName[16];

    // ── V1 fields (offset 456) ──
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

    /// <summary>Prefix フィールドに <paramref name="s"/> をコピー (192 char cap、超過分は捨てる)。</summary>
    public void SetPrefix(ReadOnlySpan<char> s)
    {
        var len = Math.Min(s.Length, 192);
        fixed (char* p = Prefix)
        {
            for (var i = 0; i < len; i++) p[i] = s[i];
            for (var i = len; i < 192; i++) p[i] = '\0';
        }
    }

    /// <summary>FileSystemName フィールドに <paramref name="s"/> をコピー (16 char cap)。</summary>
    public void SetFileSystemName(ReadOnlySpan<char> s)
    {
        var len = Math.Min(s.Length, 16);
        fixed (char* p = FileSystemName)
        {
            for (var i = 0; i < len; i++) p[i] = s[i];
            for (var i = len; i < 16; i++) p[i] = '\0';
        }
    }
}

/// <summary>
/// <see cref="VolumeParams.Flags"/> の bit 番号定数。C bitfield の宣言順と一致。
/// 詳細コメントは winfsp/fsctl.h:206-236 参照。
/// </summary>
public static class VolumeParamsFlags
{
    // FS attribute info (offset 0-9)
    public const int CaseSensitiveSearch = 0;
    public const int CasePreservedNames = 1;
    public const int UnicodeOnDisk = 2;
    public const int PersistentAcls = 3;
    public const int ReparsePoints = 4;
    public const int ReparsePointsAccessCheck = 5;
    public const int NamedStreams = 6;
    public const int HardLinks = 7;
    public const int ExtendedAttributes = 8;
    public const int ReadOnlyVolume = 9;

    // kernel-mode flags (offset 10-15)
    public const int PostCleanupWhenModifiedOnly = 10;
    public const int PassQueryDirectoryPattern = 11;
    public const int AlwaysUseDoubleBuffering = 12;
    public const int PassQueryDirectoryFileName = 13;
    public const int FlushAndPurgeOnCleanup = 14;
    public const int DeviceControl = 15;

    // user-mode flags (offset 16-23)
    public const int UmFileContextIsUserContext2 = 16;
    public const int UmFileContextIsFullContext = 17;
    public const int UmNoReparsePointsDirCheck = 18;
    // UmReservedFlags:5 = bits 19-23 (skip)

    // additional kernel-mode flags (offset 24-31)
    public const int AllowOpenInKernelMode = 24;
    public const int CasePreservedExtendedAttributes = 25;
    public const int WslFeatures = 26;
    public const int DirectoryMarkerAsNextOffset = 27;
    public const int RejectIrpPriorToTransact0 = 28;
    public const int SupportsPosixUnlinkRename = 29;
    public const int PostDispositionWhenNecessaryOnly = 30;
    public const int KmReservedFlags = 31;

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
