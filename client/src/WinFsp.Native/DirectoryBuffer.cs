using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using WinFsp.Native.Native;

namespace WinFsp.Native;

/// <summary>
/// <see cref="IFileSystem.ReadDirectory"/> 実装が directory entry を 1 件ずつ出力 buffer
/// に積むためのヘルパ。<see cref="NativeApi.FspFileSystemAddDirInfo"/> ベース。
/// </summary>
/// <remarks>
/// <para>使い方:
///   <code>
///   public int ReadDirectory(... nint buffer, uint length, out uint bytesTransferred) {
///       var db = new DirectoryBuffer(buffer, length);
///       foreach (var (name, info) in Enumerate(...)) {
///           if (!db.TryAdd(name, info)) break; // buffer 満杯
///       }
///       db.MarkEnd(); // EOF marker
///       bytesTransferred = db.BytesTransferred;
///       return NtStatus.Success;
///   }
///   </code></para>
/// <para>ref struct なので heap escape 不可、スコープ内で使い切る。実装は stackalloc
/// で 1 entry 分の scratch を確保 (DirInfo header 104 + name byte) → <c>FspFileSystemAddDirInfo</c>
/// が caller の output buffer に copy するパターン。entry 1 個あたり最大 65535 byte
/// (DirInfo.Size は UINT16) の制限あり。</para>
/// </remarks>
public unsafe ref struct DirectoryBuffer
{
    private readonly void* _buffer;
    private readonly uint _length;
    private uint _bytesTransferred;

    public DirectoryBuffer(nint buffer, uint length)
    {
        _buffer = (void*)buffer;
        _length = length;
        _bytesTransferred = 0;
    }

    public uint BytesTransferred => _bytesTransferred;

    /// <summary>
    /// 1 entry を出力 buffer に追加。容量不足なら false (= caller は loop を抜けて
    /// success status で return、kernel が次回 marker 付きで続きを取りに来る)。
    /// </summary>
    public bool TryAdd(ReadOnlySpan<char> fileName, in NativeFileInfo info)
    {
        var nameBytes = fileName.Length * 2;
        var totalSize = 104 + nameBytes;
        if (totalSize > ushort.MaxValue) return false; // Size field は UINT16

        // 1 entry を stack 上に組み立て。DirInfo struct 自体の alignment は
        // stackalloc byte の保証外なので、Unsafe で値を書く (Unaligned 安全)。
        Span<byte> entry = stackalloc byte[totalSize];
        entry.Clear(); // padding/reserved を 0 fill

        var entryPtr = (DirInfo*)Unsafe.AsPointer(ref MemoryMarshal.GetReference(entry));
        entryPtr->Size = (ushort)totalSize;
        entryPtr->FileInfo = info;
        // NextOffsetOrPadding / Padding* は 0 のまま

        // FileNameBuf を struct 末尾 (offset 104) に書き込む
        if (nameBytes > 0)
        {
            var nameDestSpan = MemoryMarshal.Cast<byte, char>(entry.Slice(104, nameBytes));
            fileName.CopyTo(nameDestSpan);
        }

        fixed (byte* entryFixed = entry)
        fixed (uint* bytesPtr = &_bytesTransferred)
        {
            return NativeApi.FspFileSystemAddDirInfo(entryFixed, _buffer, _length, bytesPtr);
        }
    }

    /// <summary>
    /// すべての entry を入れた後で呼ぶ。EOF marker を出力。
    /// <see cref="NativeApi.FspFileSystemAddDirInfo"/> に DirInfo=null を渡すと
    /// internal flag が立って kernel 側で "終端到達" と認識される。
    /// </summary>
    public void MarkEnd()
    {
        fixed (uint* bytesPtr = &_bytesTransferred)
        {
            NativeApi.FspFileSystemAddDirInfo(null, _buffer, _length, bytesPtr);
        }
    }
}
