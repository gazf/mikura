using System.Buffers;
using System.Diagnostics;
using System.Threading.Channels;
using Mikura.Core.Abstractions;

namespace Mikura.Core.Sync;

/// <summary>
/// ADR-025: byte-range chunked upload session のクライアント側エンジン。
/// kernel の Write IRP から渡された (offset, data) を ArrayPool レンタル
/// バッファに退避し、Channel<UploadChunk> bounded queue 経由で N=8 並列の
/// PATCH に流す。queue が満杯のときは <see cref="EnqueueAsync"/> が natural
/// backpressure として待機するので、handle 単位のメモリ占有は最大
/// <c>(capacity + workers) × chunk size</c> に bound される。
/// </summary>
internal sealed class ChunkedUploader : IAsyncDisposable
{
    // 8 並列だと TCP connection 8 本が同時に Http1Connection の write buffer を
    // 大きくしたままになる (数十 MB × 並列数で数百 MB) のが実機メモリ膨張の主因だった。
    // 4 並列なら半分程度に bound される。LAN ベンチで 4 → 8 のスループット差は
    // 数 % 程度なので安全側に倒す。
    private const int MaxInFlight = 4;
    private const int QueueCapacity = 1; // rendezvous: writer 1 buffered + 4 workers ≈ 5 in system

    // chunk buffer は handle 共通の専用 pool (read 経路と分離)。WinFsp の Write
    // IRP は典型 64KB〜1MB 程度なので 4MB 上限で十分。
    // maxArraysPerBucket は in-flight 上限 (8) より少し大きい程度で OK。pool が
    // 過去 rent を抱え込みすぎると idle 時のプロセスメモリが膨らむため、
    // handle の同時実行 N 本前提でも 4 で足りる (= 4 × 4MB × 7 bucket 〜 112MB
    // 上限、現実的には 1MB chunk 多用で 16MB 程度に収まる)。
    private static readonly ArrayPool<byte> _chunkPool =
        ArrayPool<byte>.Create(maxArrayLength: 4 * 1024 * 1024, maxArraysPerBucket: 4);

    private readonly IMikuraServer _server;
    private readonly string _uploadId;
    private readonly Channel<UploadChunk> _channel;
    private readonly Task[] _workers;
    private readonly CancellationTokenSource _shutdownCts = new();

    private readonly object _errorGate = new();
    private Exception? _firstError;

    public ChunkedUploader(IMikuraServer server, string uploadId)
    {
        _server = server;
        _uploadId = uploadId;
        _channel = Channel.CreateBounded<UploadChunk>(new BoundedChannelOptions(QueueCapacity)
        {
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = false,
            SingleWriter = false,
        });

        _workers = new Task[MaxInFlight];
        for (int i = 0; i < MaxInFlight; i++)
        {
            _workers[i] = Task.Run(WorkerLoopAsync);
        }
    }

    public string UploadId => _uploadId;

    private async Task WorkerLoopAsync()
    {
        var ct = _shutdownCts.Token;
        try
        {
            await foreach (var chunk in _channel.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                try
                {
                    await _server.UploadChunkAsync(_uploadId, chunk.Offset, chunk.Memory, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    _chunkPool.Return(chunk.Buffer, clearArray: false);
                    return;
                }
                catch (Exception ex)
                {
                    lock (_errorGate) _firstError ??= ex;
                    _chunkPool.Return(chunk.Buffer, clearArray: false);
                    // 後続 chunk を捨てて全 worker を即時シャットダウンする。
                    _shutdownCts.Cancel();
                    return;
                }
                _chunkPool.Return(chunk.Buffer, clearArray: false);
            }
        }
        catch (OperationCanceledException) { /* shutdown */ }
        catch (Exception ex)
        {
            lock (_errorGate) _firstError ??= ex;
        }
    }

    /// <summary>
    /// chunk を queue に投入する。queue 満杯時は worker が捌くまで非同期に待つ
    /// (= kernel Write の natural backpressure)。先行 chunk が失敗していたら
    /// 即座に <see cref="IOException"/> を投げて伝播する。
    /// </summary>
    public async Task EnqueueAsync(long offset, ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        ThrowIfBroken();

        var buffer = _chunkPool.Rent(data.Length);
        data.CopyTo(buffer);
        var chunk = new UploadChunk(offset, buffer, data.Length);
        try
        {
            await _channel.Writer.WriteAsync(chunk, ct).ConfigureAwait(false);
        }
        catch
        {
            _chunkPool.Return(buffer, clearArray: false);
            throw;
        }
    }

    /// <summary>
    /// 全 chunk の送信完了を待つ。失敗があれば <see cref="IOException"/> として
    /// 上位 (Cleanup) に伝播する。
    /// </summary>
    public async Task DrainAsync()
    {
        _channel.Writer.TryComplete();
        try
        {
            await Task.WhenAll(_workers).ConfigureAwait(false);
        }
        catch
        {
            // 個別エラーは _firstError 経由で集約済み。
        }
        ThrowIfBroken();
    }

    /// <summary>
    /// 進行中の送信を打ち切り、buffer を pool に戻す。例外は出さない (best effort)。
    /// </summary>
    public async Task AbortAsync()
    {
        _shutdownCts.Cancel();
        _channel.Writer.TryComplete();
        try
        {
            await Task.WhenAll(_workers).ConfigureAwait(false);
        }
        catch { /* 抑止 */ }

        // queue に残った chunk の buffer を回収。
        while (_channel.Reader.TryRead(out var chunk))
        {
            _chunkPool.Return(chunk.Buffer, clearArray: false);
        }
    }

    private void ThrowIfBroken()
    {
        Exception? err;
        lock (_errorGate) err = _firstError;
        if (err is not null)
        {
            throw new IOException("chunked upload failed: " + err.Message, err);
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { await AbortAsync().ConfigureAwait(false); }
        catch (Exception ex) { Trace.WriteLine($"ChunkedUploader.Dispose: {ex.Message}"); }
        _shutdownCts.Dispose();
    }

    private readonly struct UploadChunk
    {
        public readonly long Offset;
        public readonly byte[] Buffer;
        public readonly int Length;

        public UploadChunk(long offset, byte[] buffer, int length)
        {
            Offset = offset;
            Buffer = buffer;
            Length = length;
        }

        public ReadOnlyMemory<byte> Memory => Buffer.AsMemory(0, Length);
    }
}
