using System.Runtime.InteropServices;

namespace WinFsp.Native.Native;

/// <summary>
/// FSP_FSCTL_FILE_INFO — winfsp/fsctl.h:277-290。72 bytes 固定。
/// 名前は System.IO.FileInfo との衝突を避けるため Native プレフィックス付き。
/// </summary>
[StructLayout(LayoutKind.Sequential, Size = 72)]
public struct NativeFileInfo
{
    public uint FileAttributes;
    public uint ReparseTag;
    public ulong AllocationSize;
    public ulong FileSize;
    public ulong CreationTime;
    public ulong LastAccessTime;
    public ulong LastWriteTime;
    public ulong ChangeTime;
    public ulong IndexNumber;
    public uint HardLinks; // 未実装、0 固定
    public uint EaSize;
}

/// <summary>
/// FSP_FSCTL_VOLUME_INFO — winfsp/fsctl.h:268-274。88 bytes 固定。
/// 内訳: TotalSize(8) + FreeSize(8) + VolumeLabelLength(2) + WCHAR[32](64) + padding(6)。
/// VolumeLabel は <c>fixed char[32]</c> として inline 配置 (CharSet.Unicode 相当)。
/// </summary>
[StructLayout(LayoutKind.Sequential, Size = 88)]
public unsafe struct NativeVolumeInfo
{
    public ulong TotalSize;
    public ulong FreeSize;
    public ushort VolumeLabelLength; // バイト単位 (= 文字数 * 2)
    public fixed char VolumeLabel[32];

    /// <summary>
    /// VolumeLabel フィールドに <paramref name="label"/> をコピーして
    /// <see cref="VolumeLabelLength"/> も同時にセット (バイト単位)。32 文字 cap。
    /// </summary>
    public void SetLabel(ReadOnlySpan<char> label)
    {
        var len = Math.Min(label.Length, 32);
        fixed (char* p = VolumeLabel)
        {
            for (var i = 0; i < len; i++) p[i] = label[i];
        }
        VolumeLabelLength = (ushort)(len * 2);
    }
}
