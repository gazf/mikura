using System.Runtime.InteropServices;

namespace WinFsp.Native.Native;

/// <summary>
/// FSP_FSCTL_DIR_INFO — winfsp/fsctl.h:298-310。104 byte 固定 + 末尾 flexible
/// <c>WCHAR FileNameBuf[]</c>。<see cref="DirectoryBuffer"/> の <c>TryAdd</c> 経由で
/// 構築 + <see cref="NativeApi.FspFileSystemAddDirInfo"/> に渡す。
/// </summary>
/// <remarks>
/// レイアウト内訳:
///   Size(2) + padding(6) [次の FileInfo を 8-byte align するため]
///   FileInfo(72) → 80
///   union { NextOffset(8) | Padding[24] } = 24 byte → 104
///   FileNameBuf[] = flexible (caller が name 分の追加 byte 必要)
/// </remarks>
[StructLayout(LayoutKind.Sequential, Size = 104)]
public struct DirInfo
{
    public ushort Size;
    // padding 6 byte が暗黙に入る (次の FileInfo が UINT64 alignment 要求)
    public NativeFileInfo FileInfo;
    public ulong NextOffsetOrPadding;
    public ulong PaddingReserved0;
    public ulong PaddingReserved1;
    // ↑ union 24 byte 分。実体は NextOffset (UINT64) しか使わないので 24 byte 占有のみ。
    // FileNameBuf[] は struct の後ろに caller が WCHAR 配列で書く。
}
