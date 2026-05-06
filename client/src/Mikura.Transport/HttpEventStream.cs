using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Mikura.Core.Abstractions;

namespace Mikura.Transport;

public sealed class HttpEventStream : IEventStream
{
    private readonly ClientWebSocket _ws;
    private readonly string _deviceId;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
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

        var wsUrl = serverUrl.TrimEnd('/')
            .Replace("https://", "wss://")
            .Replace("http://", "ws://")
            + "/events";

        await ws.ConnectAsync(new Uri(wsUrl), ct);
        return new HttpEventStream(ws, deviceId);
    }

    public async IAsyncEnumerable<ServerEvent> ReadEventsAsync([EnumeratorCancellation] CancellationToken ct)
    {
        var buffer = new byte[8192];

        while (!ct.IsCancellationRequested && _ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try
            {
                // ConfigureAwait(false): UI sync context にコールバックを post しない。
                // 受信継続が UI スレッドに依存しないようにする (heartbeat 同期ブロッキング時代の名残対策)。
                result = await _ws.ReceiveAsync(buffer, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                yield break;
            }

            if (result.MessageType == WebSocketMessageType.Close) yield break;
            if (result.MessageType != WebSocketMessageType.Text) continue;

            var json = Encoding.UTF8.GetString(buffer, 0, result.Count);

            ServerEvent? evt;
            try
            {
                evt = JsonSerializer.Deserialize<ServerEvent>(json);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine($"WSS recv: deserialize failed: {ex.Message} json={json}");
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

        var payload = $"{{\"type\":\"heartbeat\",\"deviceId\":\"{_deviceId}\"}}";
        var bytes = Encoding.UTF8.GetBytes(payload);

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
            try
            {
                var payload = $"{{\"type\":\"terminate\",\"deviceId\":\"{_deviceId}\"}}";
                var bytes = Encoding.UTF8.GetBytes(payload);
                await _sendLock.WaitAsync(CancellationToken.None);
                try
                {
                    await _ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None);
                }
                finally { _sendLock.Release(); }
            }
            catch { /* best-effort */ }

            try { await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, CancellationToken.None); }
            catch { /* ignore shutdown errors */ }
        }
        _ws.Dispose();
        _sendLock.Dispose();
    }
}
