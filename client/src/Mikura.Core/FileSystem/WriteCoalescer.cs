using System.Buffers;
using System.Diagnostics;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace Mikura.Core.FileSystem;

/// <summary>
/// kernel Write IRP を後段の HTTP PATCH に流す前段の write cache。
/// <para>
/// 連続/非連続を問わず handle 単位で IRP を集約し、target サイズに達するか
/// idle timeout / Cleanup で 1 リクエスト (multipart/mixed PATCH) として
/// 送出する。range metadata と実バイナリを分離して持ち、同じハンドルへの
/// 散発的な小書き込みも 1 PATCH に潰れる (RND 4K Q=32 等が支配する benchmark
/// の RTT 数を IRP 単位から chunk 単位に圧縮する目的)。
/// </para>
/// <para>
/// 順序保証: append 順にそのまま range list に積み、PATCH も同順で送出する。
/// 上書き (同 offset 二度書き) は range list 順 = 後勝ち で server が逐次
/// 適用する。my-impl の旧経路 (ChunkedUploader 並列 worker) で潜在的にあった
/// race は構造上発生しない。
/// </para>
/// </summary>
internal sealed class WriteCoalescer : IAsyncDisposable
{
    // バッファ目標サイズ。1 PATCH の wire 上のペイロード上限を兼ねる。
    // 4MB は ArrayPool 上限 / WinFsp 1 IRP 最大 / HTTP/1.1 chunked transfer
    // の現実的な分割境界、いずれにもフィットする。
    private const int TargetBufferSize = 4 * 1024 * 1024;

    // バーストの最終 chunk を Cleanup を待たずに巻き取るための無入力 timeout。
    // 50ms は Excel/SQLite のような短 pause を挟む writer のレイテンシ悪化を
    // 体感できない範囲、かつ「次のバーストが来る前に確実に flush」できる長さ。
    private const int IdleFlushMs = 50;

    // range list の最大エントリ数。multipart 1 part あたり ~110B overhead が
    // かかるので、極端な数で送ると body size が膨らむ。実用上 4MB / 64B = 64K
    // 超は出ないが、メモリ防衛で上限を切る。
    private const int MaxRanges = 4096;

    // 進化経緯:
    //   - 初代: ArrayPool<byte>.Create(4MB, maxArraysPerBucket: 4)
    //     → 16 並行 session で 4 slot 不足 → 12 session ぶん fresh alloc に fallback
    //   - 2 代: ArrayPool<byte>.Shared (d4b065d)
    //     → fallback 解消したが TLSCachedArrayPool の per-thread slot が ThreadPool 拡張
    //       のたびに増殖、CDM 反復で Working Set が monotonic に成長して頭打ちにならない
    //       (ユーザ実測: 1 回 ~150 MB → 10 回 ~200 MB と増え続け)
    //   - 現在: maxArraysPerBucket を 16 まで増やした bounded pool に回帰
    //     → bucket 上限 16 × 4MB = 64 MB に hard cap、per-thread cache 無し
    //     → 16 並行 session も fallback せず捌けて、反復回数に依存しない安定 retain
    private static readonly ArrayPool<byte> _pool =
        ArrayPool<byte>.Create(maxArrayLength: TargetBufferSize, maxArraysPerBucket: 16);

    private readonly IServerApi _server;
    private readonly string _uploadId;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Timer _idleTimer;

    // _gate で保護される現バッファ状態。
    private byte[]? _buf;
    private int _bufFilled;
    private readonly List<UploadRange> _ranges = new(capacity: 64);

    // N-deep pipeline: 同時 in-flight PATCH 本数の上限。Read 側が HttpClient の
    // MaxConnectionsPerServer=8 並列で 342 MB/s 出ているのに対し、Write は serial
    // PATCH だと 80 MB/s 頭打ち。N を増やせば HTTP/1.1 multi-connection を使い切れる。
    // 順序: 同一 buffer 内は range list 順で保証、buffer 間は flush 順で submit するが
    // server 側到着順は GC されない (実 server は seek+write が fd 独立なので
    // 非重複 range なら問題ない。重複は最後勝ち = 旧 ChunkedUploader 並列 worker と同じ)。
    private const int MaxInFlight = 4;
    private readonly SemaphoreSlim _sendSlots = new(MaxInFlight, MaxInFlight);
    private readonly List<Task> _inFlightSends = new(capacity: MaxInFlight);
    private readonly object _inFlightSendsGate = new();

    private volatile bool _shutdown;
    private volatile Exception? _firstError;

    public WriteCoalescer(IServerApi server, string uploadId)
    {
        _server = server;
        _uploadId = uploadId;
        _idleTimer = new Timer(OnIdleFire, this, Timeout.Infinite, Timeout.Infinite);
    }

    /// <summary>
    /// IRP をバッファ末尾に pack し、range list にエントリを追加する。バッファに
    /// 載らない場合は flush してから新バッファに retry する。1 IRP が
    /// <see cref="TargetBufferSize"/> 超のときはバッファを経由せず単 range の
    /// 単一 PATCH として直送 (multipart overhead を払わない)。
    /// <para>
    /// 戻り値が <see cref="ValueTask"/>: gate 非競合 + バッファ内 append (sync 完了)
    /// が hot path で、その場合 Task の heap alloc を回避する。flush 経路に入る時だけ
    /// 内部で async 状態機を heap promote する。
    /// </para>
    /// </summary>
    public async ValueTask AppendAsync(long fileOffset, ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        if (data.Length == 0) return;
        ThrowIfBroken();

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // target 超の単一 IRP は coalesce せず単 range PATCH に直流。
            // FlushLocked が背景 send を kick するだけで return するので、ここで
            // 全 in-flight を drain してから直流に出す (順序保証)。大 IRP は元々
            // データサイズ自体が支配的なので pipeline 化の旨味は薄く、シンプルに同期で OK。
            if (data.Length >= TargetBufferSize)
            {
                await FlushLocked(ct).ConfigureAwait(false);
                await DrainPendingAsync().ConfigureAwait(false);
                await _server.UploadChunkAsync(_uploadId, fileOffset, data, ct).ConfigureAwait(false);
                return;
            }

            // バッファ初回確保 or 容量・range 数オーバー時は先に flush。
            if (_buf is null)
            {
                _buf = _pool.Rent(TargetBufferSize);
            }
            else if (_bufFilled + data.Length > TargetBufferSize || _ranges.Count >= MaxRanges)
            {
                await FlushLocked(ct).ConfigureAwait(false);
                _buf = _pool.Rent(TargetBufferSize);
            }

            data.CopyTo(_buf.AsMemory(_bufFilled));
            // 直前 range と file offset 上で連続なら、そのまま末尾を伸ばす。
            // バッファ上の position も連続している (常に _bufFilled に書く) ので
            // 1 つの長い range に統合される = multipart overhead を避けられる。
            if (_ranges.Count > 0)
            {
                var last = _ranges[^1];
                if (last.FileOffset + last.Length == fileOffset)
                {
                    _ranges[^1] = last with { Length = last.Length + data.Length };
                }
                else
                {
                    _ranges.Add(new UploadRange(fileOffset, _bufFilled, data.Length));
                }
            }
            else
            {
                _ranges.Add(new UploadRange(fileOffset, _bufFilled, data.Length));
            }
            _bufFilled += data.Length;

            // ちょうど満杯に達したら即 flush (次の IRP を待たない)。
            if (_bufFilled >= TargetBufferSize)
            {
                await FlushLocked(ct).ConfigureAwait(false);
            }

            if (_buf is not null && _bufFilled > 0)
            {
                _idleTimer.Change(IdleFlushMs, Timeout.Infinite);
            }
        }
        finally { _gate.Release(); }
    }

    /// <summary>
    /// 現バッファを送信して、in-flight PATCH を完走まで待つ。Finalize で呼ぶ。
    /// Abort 経路では <see cref="DisposeAsync"/> 側で同じ流れを踏む。
    /// </summary>
    public async ValueTask FlushAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try { await FlushLocked(ct).ConfigureAwait(false); }
        finally { _gate.Release(); }
        // FlushLocked は背景 send を kick するだけなので、ここで明示的に drain。
        await DrainPendingAsync().ConfigureAwait(false);
    }

    // _gate 保有前提。現バッファを切り離して send タスクに渡す。
    // send 自体は別 Task で背景進行し、await はせず即 return する (pipeline)。
    // in-flight 数が <see cref="MaxInFlight"/> に達していたら _sendSlots で待つ。
    private async ValueTask FlushLocked(CancellationToken ct)
    {
        if (_buf is null || _ranges.Count == 0)
        {
            // _buf だけあって range なし (= 異常状態) も含めて、バッファだけ pool に戻す。
            if (_buf is not null)
            {
                _pool.Return(_buf, clearArray: false);
                _buf = null;
                _bufFilled = 0;
            }
            return;
        }

        _idleTimer.Change(Timeout.Infinite, Timeout.Infinite);

        // in-flight 上限に達していたら、どれかが終わって slot が空くまで待つ。
        // この await の間 _gate は保有したままなので、新 append は queue で待つ。
        // ただし MaxInFlight 本走らせている間に append が gate で詰まる事は事実上ない
        // (kernel IRP より HTTP send の方が遅いケース = 元々の bottleneck パターン)。
        await _sendSlots.WaitAsync(ct).ConfigureAwait(false);

        var buf = _buf;
        var bufLen = _bufFilled;
        var ranges = _ranges.ToArray();
        _buf = null;
        _bufFilled = 0;
        _ranges.Clear();

        // ここで新 send を kick して背景に放す。slot は send 完了時に SendBatchAsync 内で release。
        var task = SendBatchAsync(buf, bufLen, ranges, ct);
        lock (_inFlightSendsGate)
        {
            // 完了済みエントリは drain せず溜まり続けるので、ここで間引く。
            _inFlightSends.RemoveAll(t => t.IsCompleted);
            _inFlightSends.Add(task);
        }
    }

    private async Task SendBatchAsync(byte[] buf, int bufLen, UploadRange[] ranges, CancellationToken ct)
    {
        try
        {
            if (ranges.Length == 1)
            {
                // 単 range は multipart の overhead を払わず単 PATCH に。
                var r = ranges[0];
                await _server.UploadChunkAsync(
                    _uploadId,
                    r.FileOffset,
                    buf.AsMemory(r.BufferOffset, r.Length),
                    ct).ConfigureAwait(false);
            }
            else
            {
                await _server.UploadChunksMultipartAsync(
                    _uploadId,
                    buf.AsMemory(0, bufLen),
                    ranges,
                    ct).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _firstError = ex;
            // throw しても背景タスクなので observer はいない (DrainPendingAsync が
            // _firstError 経由で吸い上げる)。
        }
        finally
        {
            _pool.Return(buf, clearArray: false);
            _sendSlots.Release();
        }
    }

    /// <summary>
    /// 進行中の背景 send を完走まで待つ。FlushAsync が呼ばれた後で
    /// FinalizeUploadAsync を投げる前に、全 PATCH が確実に到達していることを
    /// 保証するために使う。
    /// </summary>
    private async ValueTask DrainPendingAsync()
    {
        Task[] snapshot;
        lock (_inFlightSendsGate)
        {
            snapshot = _inFlightSends.ToArray();
            _inFlightSends.Clear();
        }
        if (snapshot.Length > 0)
        {
            try { await Task.WhenAll(snapshot).ConfigureAwait(false); }
            catch { /* error は _firstError に記録済 */ }
        }
        ThrowIfBroken();
    }

    private static void OnIdleFire(object? state)
    {
        var self = (WriteCoalescer)state!;
        _ = self.IdleFlushAsync();
    }

    private async Task IdleFlushAsync()
    {
        if (_shutdown) return;
        try
        {
            await _gate.WaitAsync().ConfigureAwait(false);
            try
            {
                if (_shutdown) return;
                await FlushLocked(CancellationToken.None).ConfigureAwait(false);
            }
            finally { _gate.Release(); }
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"WriteCoalescer idle flush failed: {ex.Message}");
        }
    }

    private void ThrowIfBroken()
    {
        var err = _firstError;
        if (err is not null)
        {
            throw new IOException("write cache flush failed: " + err.Message, err);
        }
    }

    public async ValueTask DisposeAsync()
    {
        _shutdown = true;
        try { await _idleTimer.DisposeAsync().ConfigureAwait(false); }
        catch { /* ignore */ }

        // FlushAsync は背景 send まで drain して return する。
        try { await FlushAsync(CancellationToken.None).ConfigureAwait(false); }
        catch (Exception ex)
        {
            Trace.WriteLine($"WriteCoalescer.Dispose flush failed: {ex.Message}");
        }

        // 念のため未処理の背景 task と残バッファを掃除。
        try { await DrainPendingAsync().ConfigureAwait(false); }
        catch (Exception ex)
        {
            Trace.WriteLine($"WriteCoalescer.Dispose drain failed: {ex.Message}");
        }

        if (_buf is not null)
        {
            _pool.Return(_buf, clearArray: false);
            _buf = null;
        }
    }
}
