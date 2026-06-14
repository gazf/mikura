using System.Buffers;

namespace WinFsp.Native;

/// <summary>
/// 生 unmanaged byte buffer (IRP の Buffer ポインタ) を <see cref="Memory{T}"/> で
/// 公開するための <see cref="MemoryManager{T}"/>。
/// </summary>
/// <remarks>
/// <para>kernel が提供する IRP buffer は WinFsp callback の return まで生存保証される。
/// 非同期 (STATUS_PENDING) で <c>SendResponse</c> 完了まで使う場合も、callback return
/// 自体は遅らせていない (= "PENDING を返した時点で kernel buffer は keep alive 契約"
/// が継続する WinFsp 仕様)。</para>
/// <para>per-IRP に 1 個 alloc されるので、hot path では小さい cost が乗る。将来
/// <see cref="ArrayPool{T}"/> 風の pool 化を検討する余地あり。</para>
/// </remarks>
internal sealed unsafe class UnmanagedMemoryManager : MemoryManager<byte>
{
    private byte* _pointer;
    private readonly int _length;

    public UnmanagedMemoryManager(void* pointer, int length)
    {
        _pointer = (byte*)pointer;
        _length = length;
    }

    public override Span<byte> GetSpan() => new(_pointer, _length);

    public override MemoryHandle Pin(int elementIndex = 0)
    {
        if ((uint)elementIndex > (uint)_length)
            throw new ArgumentOutOfRangeException(nameof(elementIndex));
        return new MemoryHandle(_pointer + elementIndex);
    }

    public override void Unpin() { /* unmanaged は常に pinned */ }

    protected override void Dispose(bool disposing)
    {
        // 所有権は WinFsp。我々は free しない。pointer 無効化のみ。
        _pointer = null;
    }
}
