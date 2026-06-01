using System.Buffers;
using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Mikura.Core.Abstractions;

namespace Mikura.Transport;

public sealed class HttpEventStream : IEventStream
{
    private readonly ClientWebSocket _ws;
    private readonly string _deviceId;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    // ReadEventsAsync の receive buffer。connection と寿命を揃えて、
    // async iterator の state machine に都度新規 alloc が乗らないようにする。
    // 8 KiB は通常の event message(file path + meta、数百 byte)を 1 frame で
    // 包めるサイズ。それを超える大 message は do/while で継ぎ足し(slow path)。
    private readonly byte[] _recvBuffer = new byte[8192];
    private bool _disposed;

    private HttpEventStream(ClientWebSocket ws, string deviceId)
    {
        _ws = ws;
        _deviceId = deviceId;
    }

    public static async Task<HttpEventStream> ConnectAsync(
        string serverUrl,
        string bearerToken,
        string deviceId,
        CancellationToken ct = default)
    {
        var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", $"Bearer {bearerToken}");
        ws.Options.SetRequestHeader("X-Device-Id", deviceId);
        // dev 用 self-signed cert を素通り (HttpServerApi 側と同方針)。
        ws.Options.RemoteCertificateValidationCallback = (_, _, _, _) => true;

        var wsUrl = serverUrl.TrimEnd('/')
            .Replace("https://", "wss://")
            .Replace("http://", "ws://")
            + "/events";

        await ws.ConnectAsync(new Uri(wsUrl), ct);
        return new HttpEventStream(ws, deviceId);
    }

    public async IAsyncEnumerable<ServerEvent> ReadEventsAsync([EnumeratorCancellation] CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try
            {
                // ConfigureAwait(false): UI sync context にコールバックを post しない。
                // 受信継続が UI スレッドに依存しないようにする (heartbeat 同期ブロッキング時代の名残対策)。
                result = await _ws.ReceiveAsync(_recvBuffer, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                yield break;
            }

            if (result.MessageType == WebSocketMessageType.Close) yield break;
            if (result.MessageType != WebSocketMessageType.Text) continue;

            // 通常 (event は 1 frame = 数百 byte) は _recvBuffer から直接 deserialize。
            // 8 KiB を超えた multi-frame message は do/while で継ぎ足し(slow path)。
            ReadOnlyMemory<byte> messageMemory;
            ArrayBufferWriter<byte>? overflow = null;
            if (result.EndOfMessage)
            {
                messageMemory = _recvBuffer.AsMemory(0, result.Count);
            }
            else
            {
                overflow = new ArrayBufferWriter<byte>(initialCapacity: result.Count * 2);
                overflow.Write(_recvBuffer.AsSpan(0, result.Count));
                bool aborted = false;
                do
                {
                    try
                    {
                        result = await _ws.ReceiveAsync(_recvBuffer, ct).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException)
                    {
                        yield break;
                    }
                    if (result.MessageType == WebSocketMessageType.Close) yield break;
                    if (result.MessageType != WebSocketMessageType.Text) { aborted = true; break; }
                    overflow.Write(_recvBuffer.AsSpan(0, result.Count));
                } while (!result.EndOfMessage);
                if (aborted) continue;
                messageMemory = overflow.WrittenMemory;
            }

            // 中間 string を作らず、受信した UTF-8 byte span から直接 source-gen で deserialize。
            // diagnostic 用に raw json を出したい時だけ Encoding.UTF8.GetString に落ちる。
            ServerEvent? evt;
            try
            {
                evt = JsonSerializer.Deserialize(
                    messageMemory.Span,
                    TransportJsonContext.Default.ServerEvent);
            }
            catch (Exception ex)
            {
                var raw = System.Text.Encoding.UTF8.GetString(messageMemory.Span);
                System.Diagnostics.Trace.WriteLine($"WSS recv: deserialize failed: {ex.Message} json={raw}");
                continue;
            }

            if (evt is null) continue;

            yield return evt;
        }
    }

    /// <summary>
    /// ADR-018 Step 2: SID/Device ID ハートビート。10 秒ごとに呼び出すことで、
    /// サーバ側が当該 device の全ロックの TTL を 30 秒延長する。
    /// 送信は ClientWebSocket への並行 send を避けるため SemaphoreSlim でガード。
    /// </summary>
    public async Task SendHeartbeatAsync(CancellationToken ct = default)
    {
        if (_ws.State != WebSocketState.Open) return;
        await SendControlAsync("heartbeat", ct).ConfigureAwait(false);
    }

    /// <summary>
    /// WSS control message ({ type, deviceId }) を 1 frame で送る。
    /// source-gen で reflection なし、SerializeToUtf8Bytes で string 中継なし、
    /// proper escape で deviceId injection 安全。
    /// </summary>
    private async Task SendControlAsync(string type, CancellationToken ct)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(
            new WsControlMessage(type, _deviceId),
            TransportJsonContext.Default.WsControlMessage);

        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await _ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct)
                .ConfigureAwait(false);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        if (_ws.State == WebSocketState.Open)
        {
            // ADR-018 Step 3: グレースフル終了は terminate 送信 → サーバ側で当該
            // device の全ロックを即時解除する (TTL 30 秒待ちを回避)。
            try { await SendControlAsync("terminate", CancellationToken.None).ConfigureAwait(false); }
            catch { /* best-effort */ }

            try { await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None); }
            catch { /* ignore shutdown errors */ }
        }
        _ws.Dispose();
        _sendLock.Dispose();
    }
}
