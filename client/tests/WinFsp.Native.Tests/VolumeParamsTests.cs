using System.Runtime.InteropServices;
using WinFsp.Native.Native;
using Xunit;

namespace WinFsp.Native.Tests;

/// <summary>
/// <see cref="VolumeParams"/> の責務 (winfsp/fsctl.h FSP_FSCTL_VOLUME_PARAMS と整合):
///   - blittable struct のサイズが 504 byte (V0 456 + V1 48) で WinFsp の static assert と一致。
///   - <see cref="VolumeParams.SetPrefix"/> / <see cref="VolumeParams.SetFileSystemName"/>
///     が固定長 <c>fixed char[]</c> に bounded copy する (cap 超過は捨てる)。
///   - <see cref="VolumeParamsFlags"/> の bit 番号操作で対応 bit が正しく立つ。
///     特に <see cref="VolumeParamsFlags.UmFileContextIsUserContext2"/> (bit 16) は
///     per-Open FileContext を必須にする決定的フラグ (Bug #4: 立てないと FileContext が
///     FileNode 単位共有になり、Read open に Create handle がぶつかって全部ゼロ返しに
///     なる)、bit 番号と意味の対応をテストで固定する。
/// </summary>
public class VolumeParamsTests
{
    [Fact]
    public unsafe void StructSize_Is504_MatchesWinFspStaticAssert()
    {
        // FSP_FSCTL_VOLUME_PARAMS の V0(456) + V1(48) = 504 byte と一致しないと
        // FspFileSystemCreate に渡した時に layout がズレて 0xC0000035 を喰らう
        // (実機で確認した crash パターン)。
        Assert.Equal(504, sizeof(VolumeParams));
    }

    [Fact]
    public unsafe void SetPrefix_StoresInFixedCharArray()
    {
        var vp = default(VolumeParams);
        vp.SetPrefix("\\Server\\Share");

        var chars = new char[13];
        for (var i = 0; i < 13; i++) chars[i] = vp.Prefix[i];
        Assert.Equal("\\Server\\Share", new string(chars));
        Assert.Equal('\0', vp.Prefix[13]); // 残りは null fill
    }

    [Fact]
    public unsafe void SetPrefix_LongerThan192Chars_Truncates()
    {
        var vp = default(VolumeParams);
        var longPrefix = new string('A', 300);
        vp.SetPrefix(longPrefix);

        // 192 char cap、超過分は捨てる (例外を投げない)
        var allA = true;
        for (var i = 0; i < 192; i++) if (vp.Prefix[i] != 'A') { allA = false; break; }
        Assert.True(allA);
    }

    [Fact]
    public unsafe void SetFileSystemName_StoresInFixedCharArray()
    {
        var vp = default(VolumeParams);
        vp.SetFileSystemName("NTFS");

        var chars = new char[4];
        for (var i = 0; i < 4; i++) chars[i] = vp.FileSystemName[i];
        Assert.Equal("NTFS", new string(chars));
        Assert.Equal('\0', vp.FileSystemName[4]);
    }

    [Fact]
    public unsafe void SetFileSystemName_LongerThan16Chars_Truncates()
    {
        var vp = default(VolumeParams);
        vp.SetFileSystemName("ThisIsAVeryLongFileSystemName");
        // 例外を投げず、16 文字に切り詰める。
        var first16 = "ThisIsAVeryLongF";
        for (var i = 0; i < 16; i++) Assert.Equal(first16[i], vp.FileSystemName[i]);
    }
}

/// <summary>
/// <see cref="VolumeParamsFlags"/> の bit 番号 (winfsp/fsctl.h:206-236) を固定する。
/// </summary>
public class VolumeParamsFlagsTests
{
    [Fact]
    public void Set_TogglesIndividualBits()
    {
        uint flags = 0;
        VolumeParamsFlags.Set(ref flags, VolumeParamsFlags.CaseSensitiveSearch, true);
        Assert.True(VolumeParamsFlags.Get(flags, VolumeParamsFlags.CaseSensitiveSearch));
        Assert.False(VolumeParamsFlags.Get(flags, VolumeParamsFlags.CasePreservedNames));

        VolumeParamsFlags.Set(ref flags, VolumeParamsFlags.CaseSensitiveSearch, false);
        Assert.False(VolumeParamsFlags.Get(flags, VolumeParamsFlags.CaseSensitiveSearch));
    }

    [Theory]
    [InlineData(VolumeParamsFlags.CaseSensitiveSearch, 0)]
    [InlineData(VolumeParamsFlags.CasePreservedNames, 1)]
    [InlineData(VolumeParamsFlags.UnicodeOnDisk, 2)]
    [InlineData(VolumeParamsFlags.PersistentAcls, 3)]
    [InlineData(VolumeParamsFlags.PostCleanupWhenModifiedOnly, 10)]
    [InlineData(VolumeParamsFlags.PassQueryDirectoryPattern, 11)]
    [InlineData(VolumeParamsFlags.FlushAndPurgeOnCleanup, 14)]
    [InlineData(VolumeParamsFlags.UmFileContextIsUserContext2, 16)]
    public void BitNumbers_AreStableAndMatchWinFspHeader(int actualBitNumber, int expectedBitNumber)
    {
        // bit 番号は WinFsp 仕様と一致させる必要があり、定数の値が誤って変わると
        // 全 flag 設定が 1 bit ズレる (例: UmFileContextIsUserContext2 が bit 16 で
        // なくなれば Bug #4 が再発)。
        Assert.Equal(expectedBitNumber, actualBitNumber);
    }

    [Fact]
    public void UmFileContextIsUserContext2_BitSet_HasExpectedRawValue()
    {
        // Bug #4 regression: この bit が立たないと FileContext が FileNode 単位共有
        // になり、Open(Read) handle に Create handle がぶつかる。立てた時の raw 値が
        // 0x10000 (= 1<<16) であることを固定。
        uint flags = 0;
        VolumeParamsFlags.Set(ref flags, VolumeParamsFlags.UmFileContextIsUserContext2, true);
        Assert.Equal(0x10000u, flags);
    }
}

/// <summary>
/// <see cref="OperationContext"/> と <see cref="TransactRsp"/> の struct layout が
/// winfsp/fsctl.h FSP_FSCTL_TRANSACT_REQ / FSP_FSCTL_TRANSACT_RSP と整合すること。
/// SendResponse 時に offset がズレると IRP の Status / FileInfo が kernel に正しく
/// 伝わらないので、layout は固定する。
/// </summary>
public class TransactStructLayoutTests
{
    [Fact]
    public unsafe void TransactRsp_SizeIs128_AndHeaderOffsetsMatchWinFsp()
    {
        Assert.Equal(128, sizeof(TransactRsp));
        Assert.Equal(0, Marshal.OffsetOf<TransactRsp>(nameof(TransactRsp.Version)).ToInt32());
        Assert.Equal(2, Marshal.OffsetOf<TransactRsp>(nameof(TransactRsp.Size)).ToInt32());
        Assert.Equal(4, Marshal.OffsetOf<TransactRsp>(nameof(TransactRsp.Kind)).ToInt32());
        Assert.Equal(8, Marshal.OffsetOf<TransactRsp>(nameof(TransactRsp.Hint)).ToInt32());
        Assert.Equal(16, Marshal.OffsetOf<TransactRsp>(nameof(TransactRsp.IoStatusInformation)).ToInt32());
        Assert.Equal(20, Marshal.OffsetOf<TransactRsp>(nameof(TransactRsp.IoStatusStatus)).ToInt32());
        // Rsp union (offset 24-127) は AsyncCompletion.SendResponseWrite が
        // (byte*)&rsp + 24 で書き込むので、union 開始位置 = 24 は固定の前提。
    }

    [Fact]
    public unsafe void TransactReqHeader_Layout_MatchesWinFsp()
    {
        Assert.Equal(0, Marshal.OffsetOf<TransactReqHeader>(nameof(TransactReqHeader.Version)).ToInt32());
        Assert.Equal(2, Marshal.OffsetOf<TransactReqHeader>(nameof(TransactReqHeader.Size)).ToInt32());
        Assert.Equal(4, Marshal.OffsetOf<TransactReqHeader>(nameof(TransactReqHeader.Kind)).ToInt32());
        Assert.Equal(8, Marshal.OffsetOf<TransactReqHeader>(nameof(TransactReqHeader.Hint)).ToInt32());
    }
}

/// <summary>
/// <see cref="NativeFileInfo"/> (= FSP_FSCTL_FILE_INFO) の layout が WinFsp と整合すること。
/// SendResponseWrite が <c>(byte*)&rsp + 24</c> に書き込む先がこの struct で、size 違いや
/// field offset 違いがあると kernel に渡る FileSize 等が破損する。
/// </summary>
public class NativeFileInfoLayoutTests
{
    [Fact]
    public unsafe void Size_Is72()
    {
        // FSP_FSCTL_FILE_INFO size = 72 byte。SendResponseWrite が rsp の offset 24 から
        // 書く前提なので、72 byte 以内 = TransactRsp の union 領域 (104 byte) に収まる。
        Assert.Equal(72, sizeof(NativeFileInfo));
    }
}
