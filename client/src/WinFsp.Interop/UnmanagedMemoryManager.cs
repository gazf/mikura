using System.Buffers;

namespace WinFsp.Interop;

/// <summary>
/// WinFsp が IRP の buffer として渡してくる unmanaged <see cref="IntPtr"/> を
/// <see cref="Memory{Byte}"/> として下層 (<c>IFileSystemBackend.ReadAsync</c>) に
/// 流すためのアダプタ。これにより HTTP response stream → IRP buffer への
/// 中間 byte[] (ArrayPool) と <see cref="System.Runtime.InteropServices.Marshal.Copy"/>
/// が省け、per-IRP の memcpy を 2 回から 1 回に減らす。
///
/// <para>**寿命の前提 (重要)**: WinFsp は IRP buffer の有効期間を
/// 「callback が return するまで、もしくは <c>SendReadResponse</c> 呼び出し
/// 完了まで」と保証する。本クラスを wrap した <see cref="Memory{Byte}"/> は
/// その期間に閉じた同期スコープでのみ使うこと — async chain が
/// <c>SendReadResponse</c> 後にこの Memory を捕捉して触ると use-after-free。</para>
///
/// <para>呼び出し側は必ず <c>using</c> で破棄して、Dispose 後に
/// <see cref="SendReadResponse"/> を呼ぶ順序を守る。</para>
/// </summary>
internal sealed unsafe class UnmanagedMemoryManager : MemoryManager<byte>
{
    private readonly byte* _ptr;
    private readonly int _length;

    public UnmanagedMemoryManager(IntPtr ptr, int length)
    {
        _ptr = (byte*)ptr;
        _length = length;
    }

    public override Span<byte> GetSpan() => new(_ptr, _length);

    public override MemoryHandle Pin(int elementIndex = 0)
    {
        if ((uint)elementIndex > (uint)_length) throw new ArgumentOutOfRangeException(nameof(elementIndex));
        return new MemoryHandle(_ptr + elementIndex);
    }

    public override void Unpin() { }

    protected override void Dispose(bool disposing) { }
}
