using System.Diagnostics;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Runtime.Versioning;
using Mikura.App.Config;
using Mikura.Core.FileSystem;
using Mikura.Core.Sync;
using Mikura.Transport;
using WinFsp.Interop;

namespace Mikura.App.Profiles;

/// <summary>
/// 1 つの profile に対する mount session。HTTP / WSS / WinFsp host / SyncEngine /
/// OnlineGate を内包し、完全に独立して動作する。1 session の障害は他に伝播しない
/// (= multi-profile mode で 1 endpoint が offline でも他は無事)。
/// </summary>
/// <remarks>
/// <para>本クラスは <see cref="TrayAppContext"/> の旧 StartAsync /
/// RunEventLoopWithReconnectAsync / RunHeartbeatAsync の内容を per-profile に
/// 切り出したもの。Phase C で抽象化、Phase D で複数 instance を並列稼働させる。</para>
///
/// <para>Status は単純な enum、UI / log は本クラス外側で参照する。</para>
/// </remarks>
[SupportedOSPlatform("windows")]
public sealed class ProfileSession : IAsyncDisposable
{
    private static readonly TimeSpan WssHeartbeatInterval = TimeSpan.FromSeconds(10);

    public Profile Profile { get; }
    public string DeviceId { get; }
    public OnlineGate OnlineGate { get; } = new();

    public string? MountPoint { get; private set; }
    public ProfileSessionStatus Status { get; private set; } =
        ProfileSessionStatus.Idle;
    public string? StatusMessage { get; private set; }

    /// <summary>Status / MountPoint が変わった時に発火する。UI 更新の hook。</summary>
    public event Action<ProfileSession>? StatusChanged;

    private readonly string _token;

    private HttpClient? _http;
    private HttpServerApi? _server;
    private FileSystemBackend? _backend;
    private BackendFileSystemHost? _fsHost;
    private SyncEngine? _syncEngine;
    private HttpEventStream? _eventStream;
    private CancellationTokenSource? _eventLoopCts;

    public ProfileSession(Profile profile, string token, string deviceId)
    {
        Profile = profile ?? throw new ArgumentNullException(nameof(profile));
        if (string.IsNullOrEmpty(token))
            throw new ArgumentException("token required", nameof(token));
        if (string.IsNullOrEmpty(deviceId))
            throw new ArgumentException("deviceId required", nameof(deviceId));
        _token = token;
        DeviceId = deviceId;
    }

    /// <summary>
    /// HTTP / WinFsp mount / WSS event loop を立ち上げる。例外は内部で catch して
    /// Status を Failed に落とす (= 呼び出し側が他 profile を巻き込まない設計)。
    /// </summary>
    public async Task StartAsync(CancellationToken ct = default)
    {
        SetStatus(ProfileSessionStatus.Connecting, "Connecting...");
        try
        {
            // SocketsHttpHandler の明示構成: PooledConnectionLifetime と
            // MaxConnectionsPerServer を絞らないと、4MB chunk PATCH を流す経路で
            // Http1Connection 内部 buffer が auto-grow したまま居座る。
            // 多重 profile では各 profile が独自 HttpClient を持つので、上限は
            // per-session で同じ 8 connection を維持。
            var handler = new SocketsHttpHandler
            {
                PooledConnectionLifetime = TimeSpan.FromMinutes(1),
                PooledConnectionIdleTimeout = TimeSpan.FromSeconds(15),
                MaxConnectionsPerServer = 8,
            };
            _http = new HttpClient(handler);
            _http.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", _token);
            _http.DefaultRequestHeaders.Add("X-Device-Id", DeviceId);
            _server = new HttpServerApi(_http, Profile.ServerUrl);

            _backend = new FileSystemBackend(_server);
            Log($"Initializing backend (server={Profile.ServerUrl})");
            await _backend.InitializeAsync().ConfigureAwait(true);
            Log($"Backend initialized: {_backend.TreeSnapshot.Count} entries cached");

            _fsHost = new BackendFileSystemHost(_backend, OnlineGate);
            Log($"Mounting at '{Profile.MountLetter}'");
            MountPoint = _fsHost.Mount(Profile.MountLetter);
            Log($"Mounted at {MountPoint}");

            _syncEngine = new SyncEngine(_backend, MountPoint, DeviceId,
                notifyKernelCache: _fsHost.NotifyExternalChange);
            _eventLoopCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _ = RunEventLoopWithReconnectAsync(_eventLoopCts.Token);

            SetStatus(ProfileSessionStatus.Connected, Profile.ServerUrl);
        }
        catch (Exception ex)
        {
            Log($"[ERROR] StartAsync failed: {ex}");
            SetStatus(ProfileSessionStatus.Failed, ex.Message);
            // 部分構築 resources の clean-up は DisposeAsync 経路に任せる
            // (= TrayAppContext がまとめて Dispose する規律)。
        }
    }

    /// <summary>Sync engine の手動 full sync を 1 回叩く。</summary>
    public async Task<bool> SyncNowAsync(CancellationToken ct = default)
    {
        if (_syncEngine is null) return false;
        try
        {
            await _syncEngine.FullSyncAsync(ct);
            return true;
        }
        catch (Exception ex)
        {
            Log($"SyncNow failed: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// Remount の代替: unmount → re-init → remount。in-flight handle は失敗するが、
    /// /tree を refetch して内部 cache を rebuild する。
    /// </summary>
    public async Task RestartAsync(CancellationToken ct = default)
    {
        await StopAsync().ConfigureAwait(false);
        await StartAsync(ct).ConfigureAwait(false);
    }

    /// <summary>WSS reconnect ループを止め、mount を unmount する。</summary>
    public async Task StopAsync()
    {
        try
        {
            _eventLoopCts?.Cancel();
            _eventLoopCts?.Dispose();
            _eventLoopCts = null;

            // ADR-018 Step 3: WSS Dispose で terminate メッセージ送信、KV TTL 30s 待たずに lock 解放。
            if (_eventStream is not null)
            {
                try
                {
                    await _eventStream.DisposeAsync().AsTask()
                        .WaitAsync(TimeSpan.FromSeconds(2));
                }
                catch { /* best-effort */ }
                _eventStream = null;
            }

            _fsHost?.Dispose();
            _fsHost = null;
            _server?.Dispose();
            _server = null;
            _http?.Dispose();
            _http = null;
        }
        catch (Exception ex)
        {
            Log($"StopAsync error: {ex.Message}");
        }
        SetStatus(ProfileSessionStatus.Idle, null);
        OnlineGate.Set(false);
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
    }

    private async Task RunEventLoopWithReconnectAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            using var heartbeatCts =
                CancellationTokenSource.CreateLinkedTokenSource(ct);
            try
            {
                var stream = await HttpEventStream.ConnectAsync(
                    Profile.ServerUrl, _token, DeviceId, ct);
                _eventStream = stream;
                OnlineGate.Set(true);

                await using (stream)
                {
                    var heartbeat = Task.Run(
                        () => RunHeartbeatAsync(stream, heartbeatCts.Token));
                    try
                    {
                        await _syncEngine!.RunEventLoopAsync(stream, ct)
                            .ConfigureAwait(false);
                    }
                    finally
                    {
                        heartbeatCts.Cancel();
                        try { await heartbeat.ConfigureAwait(false); }
                        catch { /* ignore */ }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _eventStream = null;
                // ADR-021: WSS link drop で gate 落とし、IRP を即 STATUS_NETWORK_UNREACHABLE。
                OnlineGate.Set(false);
                Log($"EventLoop disconnected: {ex.Message}, reconnecting in 5s...");
                try { await Task.Delay(5000, ct); }
                catch (OperationCanceledException) { break; }
            }
        }
        _eventStream = null;
        OnlineGate.Set(false);
    }

    private static async Task RunHeartbeatAsync(
        HttpEventStream stream,
        CancellationToken ct)
    {
        var sentCount = 0;
        while (!ct.IsCancellationRequested)
        {
            if (ct.WaitHandle.WaitOne(WssHeartbeatInterval)) break;
            try
            {
                await stream.SendHeartbeatAsync(ct).ConfigureAwait(false);
                sentCount++;
                if (sentCount == 1 || sentCount % 6 == 0)
                {
                    Trace.WriteLine(
                        $"[{nameof(ProfileSession)}] WSS heartbeat sent (total={sentCount})");
                }
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Trace.WriteLine(
                    $"[{nameof(ProfileSession)}] heartbeat failed: {ex.Message}");
            }
        }
    }

    private void SetStatus(ProfileSessionStatus status, string? message)
    {
        Status = status;
        StatusMessage = message;
        StatusChanged?.Invoke(this);
    }

    private void Log(string msg) =>
        Trace.WriteLine($"[Profile:{Profile.Name}] {msg}");
}

public enum ProfileSessionStatus
{
    Idle,
    Connecting,
    Connected,
    Failed,
}
