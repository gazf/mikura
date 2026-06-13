using System.Buffers;

namespace Mikura.Core.Sync;

/// <summary>
/// Per-handle read-ahead prefetch cache (Samba 流 next-sequential, ADR-031)。
/// 1 IRP につき要求サイズの 2x (cap <see cref="MaxPrefetchSize"/>) をサーバから取り、
/// 要求 byte を返した後の余剰を 1 entry 分だけ保持する。次の IRP が prefetch 範囲の
/// 先頭から始まる (= sequential continue) なら HTTP RTT を省ける。
///
/// <para>単一 entry / single-use semantics:
///   - <see cref="TryConsume"/> hit したら即 <see cref="ArrayPool{T}.Shared"/> Return + null 化
///   - <see cref="Store"/> で新規格納するときも先に古い entry を Return
///   - Write / Dispose 時に <see cref="Invalidate"/></para>
///
/// <para>Sequential detection (arm/disarm):
///   - <see cref="NoteReadAndCheckArmed"/> で「前回 IRP の end == 今回 IRP の start」を判定
///   - <see cref="SeqStreakThreshold"/> 連続で armed = caller は prefetch を発行
///   - break (random offset 着弾) で streak リセット → caller は plain fetch
///   これで CDM RND 4K 系の "always 2x bandwidth 消費" regression を回避。</para>
/// </summary>
internal sealed class PrefetchCache : IDisposable
{
    /// <summary>
    /// 最大 prefetch byte 数 cap。要求 byte の 2x を試みるが、IRP が大きいと
    /// (1MB IRP × 2 = 2MB) bandwidth waste が膨らむためこの cap で抑える。
    /// single-use cache の性質上、cap を IRP × 2 より大きくしても「次 IRP 1 つ分」
    /// しか hit しないので意味が薄い (実測: 256KB → 512KB で SEQ 128K Q=32 は +2% のみ、
    /// noise band)。256KB で打ち止め。
    /// </summary>
    public const int MaxPrefetchSize = 256 * 1024;

    /// <summary>
    /// prefetch を armed にするのに必要な連続 sequential read 数。3 は
    /// 「RND workload で偶然 streak が立つ確率を抑える」最小値。CDM RND Q=32
    /// では offsets が完全ランダムなので 3 連続 sequential はまず起きない (実測:
    /// RND phase 中 armed=0%)。一方 CDM SEQ や application の sequential read には
    /// 警戒なしで armed まで 3 IRP の warm-up を払うだけで済む (= 連続 read の頭
    /// 3 IRP は plain fetch、4 番目以降が prefetch 経路)。
    /// </summary>
    public const int SeqStreakThreshold = 3;

    private byte[]? _buffer;
    private int _start;
    private long _offset;
    private int _length;
    private readonly object _gate = new();

    // sequential pattern tracking (gate と同じ lock 配下で保護)
    private long _lastReadEnd = -1; // -1 = まだ Read 経験なし
    private int _seqStreak;

    /// <summary>
    /// offset が prefetch の先頭と一致したら dest にコピーして cache を消費。
    /// 一致しない (= sequential 切れ) なら cache 廃棄して false を返す。
    /// </summary>
    public bool TryConsume(long offset, Span<byte> dest, out int copied)
    {
        lock (_gate)
        {
            if (_buffer is null)
            {
                copied = 0;
                return false;
            }
            if (offset != _offset)
            {
                // sequential 切れ = stale。次回 prefetch のために廃棄。
                ReturnLocked();
                copied = 0;
                return false;
            }
            var n = Math.Min(dest.Length, _length);
            _buffer.AsSpan(_start, n).CopyTo(dest);
            // single-use: 部分消費でも残りは捨てる (user 指定 spec)。
            ReturnLocked();
            copied = n;
            return true;
        }
    }

    /// <summary>
    /// prefetch fetch 完了後に余剰 byte を格納。buffer の所有権は pool に
    /// 戻されるまで cache 側が持つ (caller は以後触らない)。
    /// </summary>
    public void Store(byte[] buffer, int start, int length, long offset)
    {
        lock (_gate)
        {
            ReturnLocked();
            _buffer = buffer;
            _start = start;
            _length = length;
            _offset = offset;
        }
    }

    /// <summary>
    /// cache を破棄して streak をリセット。Write 直後や Dispose で呼ぶ。
    /// 古い streak のまま prefetch を armed 続行すると、Write で内容が変わった直後に
    /// 古い前提で 2x fetch する無駄が出る (再 arm を待つほうが安全)。
    /// </summary>
    public void Invalidate()
    {
        lock (_gate)
        {
            ReturnLocked();
            _lastReadEnd = -1;
            _seqStreak = 0;
        }
    }

    /// <summary>
    /// Read IRP の到着を記録し、prefetch を発行すべきか (armed) を返す。
    /// 「前回 IRP の end == 今回 IRP の start」が <see cref="SeqStreakThreshold"/>
    /// 連続で続いたら armed = true、それ以外 (= random offset 着弾) は streak を
    /// リセットして armed = false。
    /// </summary>
    /// <remarks>
    /// 呼び出しは ReadAsync の入口、<see cref="TryConsume"/> / fetch 経路に関係なく
    /// 1 IRP につき 1 回。cache hit も sequential continue としてカウントされる
    /// (実体的に「次 byte を読み続けている」ため)。
    /// </remarks>
    public bool NoteReadAndCheckArmed(long offset, int length)
    {
        lock (_gate)
        {
            var sequential = _lastReadEnd >= 0 && _lastReadEnd == offset;
            if (sequential)
            {
                if (_seqStreak < int.MaxValue) _seqStreak++;
            }
            else
            {
                _seqStreak = 1;
            }
            _lastReadEnd = offset + length;
            return _seqStreak >= SeqStreakThreshold;
        }
    }

    private void ReturnLocked()
    {
        if (_buffer is not null)
        {
            ArrayPool<byte>.Shared.Return(_buffer);
            _buffer = null;
            _start = 0;
            _length = 0;
        }
    }

    public void Dispose() => Invalidate();
}
