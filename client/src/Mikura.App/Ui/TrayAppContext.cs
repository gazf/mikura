using System.Diagnostics;
using System.Net.Http.Headers;
using System.Windows.Forms;
using Mikura.App.Config;
using Mikura.Core.Identity;
using Mikura.Core.Sync;
using Mikura.Transport;
using WinFsp.Interop;

namespace Mikura.App.Ui;

public sealed class TrayAppContext : ApplicationContext
{
    private readonly AppSettings _settings;
    private readonly NotifyIcon _tray;

    private static readonly TimeSpan WssHeartbeatInterval = TimeSpan.FromSeconds(10);

    private HttpServerApi? _server;
    private ServerBackend? _backend;
    private BackendFileSystemHost? _fsHost;
    private SyncEngine? _syncEngine;
    private HttpEventStream? _eventStream;
    private CancellationTokenSource? _eventLoopCts;
    private string? _deviceId;
    private string? _mountPoint;
    private readonly OnlineGate _onlineGate = new();

    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _openItem;
    private readonly ToolStripMenuItem _syncNowItem;
    private readonly ToolStripMenuItem _settingsItem;
    private readonly ToolStripMenuItem _resetItem;

    public TrayAppContext(AppSettings settings)
    {
        _settings = settings;

        _statusItem = new ToolStripMenuItem("Initializing...") { Enabled = false };
        _openItem = new ToolStripMenuItem("Open sync folder", null, OnOpenFolder);
        _syncNowItem = new ToolStripMenuItem("Sync now", null, OnSyncNow);
        _settingsItem = new ToolStripMenuItem("Settings...", null, OnOpenSettings);
        _resetItem = new ToolStripMenuItem("Remount...", null, OnReset);

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(_openItem);
        menu.Items.Add(_syncNowItem);
        menu.Items.Add(_settingsItem);
        menu.Items.Add(_resetItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Exit", null, OnExit));

        _tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "MIKURA",
            Visible = true,
            ContextMenuStrip = menu
        };
        _tray.DoubleClick += OnOpenFolder;

        _ = StartAsync();
    }

    private async Task StartAsync()
    {
        if (!_settings.IsConfigured)
        {
            SetStatus("Not configured");
            ShowBalloon("Please configure MIKURA", "Right-click the tray icon → Settings.");
            OnOpenSettings(this, EventArgs.Empty);
            if (!_settings.IsConfigured) return;
        }

        try
        {
            SetStatus("Connecting...");
            _deviceId = DeviceIdProvider.GetOrCreate();
            Trace.WriteLine($"Device ID: {_deviceId}");

            // SocketsHttpHandler を明示構成しないと SocketsHttpHandler の既定が
            // PooledConnectionLifetime = Infinite、MaxConnectionsPerServer =
            // int.MaxValue になり、接続が永久に keep-alive で残る。各接続は
            // Http1Connection 内部に _writeBuffer / _readBuffer (ArrayBuffer)
            // を持ち、4MB チャンクの PATCH を流すたびにそれらが auto-grow して
            // 巨大なまま (実機: 複数 connection × 数十 MB ≈ 100MB 超) 居座る。
            // chunked upload 8 並列 + WSS + その他で MaxConnections を 16 に絞り、
            // 短めの lifetime で循環させて、接続側のメモリを bound する。
            var handler = new SocketsHttpHandler
            {
                // Http1Connection の _writeBuffer は過去の最大送信サイズで auto-grow
                // して縮まないため、connection を短命にして頻繁に張り直すことで
                // 常駐メモリを bound する。chunked upload (N=4) + WSS + ad-hoc で
                // 6 connection あれば足りる。
                PooledConnectionLifetime = TimeSpan.FromMinutes(1),
                PooledConnectionIdleTimeout = TimeSpan.FromSeconds(15),
                MaxConnectionsPerServer = 8,
            };
            var http = new HttpClient(handler);
            http.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", _settings.BearerToken);
            http.DefaultRequestHeaders.Add("X-Device-Id", _deviceId);
            _server = new HttpServerApi(http, _settings.ServerUrl);

            _backend = new ServerBackend(_server);
            Trace.WriteLine($"Initializing backend (server={_settings.ServerUrl})");
            await _backend.InitializeAsync().ConfigureAwait(true);
            Trace.WriteLine($"Backend initialized: {_backend.TreeSnapshot.Count} entries cached");

            _fsHost = new BackendFileSystemHost(_backend, _onlineGate);
            Trace.WriteLine($"Mounting at '{_settings.SyncRootPath}'");
            _mountPoint = _fsHost.Mount(_settings.SyncRootPath);
            Trace.WriteLine($"Mounted at {_mountPoint}");

            _syncEngine = new SyncEngine(_backend, _mountPoint, _deviceId);
            _eventLoopCts = new CancellationTokenSource();
            _ = RunEventLoopWithReconnectAsync(_eventLoopCts.Token);

            SetStatus($"Connected: {_settings.ServerUrl}");
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[ERROR] StartAsync failed: {ex}");
            SetStatus("Error");
            ShowBalloon("MIKURA error", ex.Message, ToolTipIcon.Error);
        }
    }

    private async Task RunEventLoopWithReconnectAsync(CancellationToken ct)
    {
        var deviceId = _deviceId
            ?? throw new InvalidOperationException("Device ID not initialized");

        while (!ct.IsCancellationRequested)
        {
            using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            try
            {
                var stream = await HttpEventStream.ConnectAsync(
                    _settings.ServerUrl, _settings.BearerToken, deviceId, ct);
                _eventStream = stream;
                _onlineGate.Set(true);

                await using (stream)
                {
                    var heartbeat = Task.Run(() => RunHeartbeatAsync(stream, heartbeatCts.Token));
                    try
                    {
                        await _syncEngine!.RunEventLoopAsync(stream, ct).ConfigureAwait(false);
                    }
                    finally
                    {
                        heartbeatCts.Cancel();
                        try { await heartbeat.ConfigureAwait(false); } catch { /* ignore */ }
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
                // ADR-021 core requirement: when the WSS link drops, flip the
                // gate so all in-flight Read/Write/Open IRPs fail immediately
                // with STATUS_NETWORK_UNREACHABLE — the Samba-equivalent UX.
                _onlineGate.Set(false);
                Trace.WriteLine($"EventLoop disconnected: {ex.Message}, reconnecting in 5s...");
                try { await Task.Delay(5000, ct); }
                catch (OperationCanceledException) { break; }
            }
        }
        _eventStream = null;
        _onlineGate.Set(false);
    }

    private static async Task RunHeartbeatAsync(HttpEventStream stream, CancellationToken ct)
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
                    Trace.WriteLine($"WSS heartbeat sent (total={sentCount})");
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Trace.WriteLine($"Heartbeat failed: {ex.Message}");
            }
        }
    }

    private void SetStatus(string text)
    {
        if (_statusItem.Owner?.InvokeRequired == true)
            _statusItem.Owner.Invoke(() => _statusItem.Text = text);
        else
            _statusItem.Text = text;
        _tray.Text = $"MIKURA - {text}".Length > 63 ? "MIKURA" : $"MIKURA - {text}";
    }

    private void ShowBalloon(string title, string text, ToolTipIcon icon = ToolTipIcon.Info)
    {
        _tray.BalloonTipTitle = title;
        _tray.BalloonTipText = text;
        _tray.BalloonTipIcon = icon;
        _tray.ShowBalloonTip(3000);
    }

    private void OnOpenFolder(object? sender, EventArgs e)
    {
        var target = _mountPoint ?? _settings.SyncRootPath;
        if (string.IsNullOrEmpty(target)) return;
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", target) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"OpenFolder failed: {ex.Message}");
        }
    }

    private async void OnSyncNow(object? sender, EventArgs e)
    {
        if (_syncEngine is null) return;
        SetStatus("Syncing...");
        try
        {
            await _syncEngine.FullSyncAsync(CancellationToken.None);
            SetStatus($"Connected: {_settings.ServerUrl}");
        }
        catch (Exception ex)
        {
            SetStatus("Error");
            ShowBalloon("Sync failed", ex.Message, ToolTipIcon.Error);
        }
    }

    private void OnOpenSettings(object? sender, EventArgs e)
    {
        using var form = new SettingsForm(_settings);
        if (form.ShowDialog() == DialogResult.OK)
        {
            ShowBalloon("Settings saved", "Restart MIKURA to apply changes.");
        }
    }

    /// <summary>
    /// Re-mount the volume. Replaces the old "reset local cache" action — under
    /// ADR-020/021 there is no persistent local cache to clear. Tearing down and
    /// remounting effectively re-fetches /tree and rebuilds in-memory state.
    /// </summary>
    private async void OnReset(object? sender, EventArgs e)
    {
        var result = MessageBox.Show(
            $"Remount the mikura drive at {_mountPoint ?? _settings.SyncRootPath}?\n\nIn-flight handles will fail.",
            "Remount",
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Information,
            MessageBoxDefaultButton.Button1);
        if (result != DialogResult.OK) return;

        SetStatus("Remounting...");
        try
        {
            _eventLoopCts?.Cancel();
            _eventLoopCts?.Dispose();
            _eventLoopCts = null;
            _ = _eventStream?.DisposeAsync().AsTask();
            _eventStream = null;

            _fsHost?.Dispose();
            _fsHost = null;

            await _backend!.InitializeAsync();
            _fsHost = new BackendFileSystemHost(_backend, _onlineGate);
            _mountPoint = _fsHost.Mount(_settings.SyncRootPath);

            _syncEngine = new SyncEngine(_backend, _mountPoint, _deviceId!);
            _eventLoopCts = new CancellationTokenSource();
            _ = RunEventLoopWithReconnectAsync(_eventLoopCts.Token);

            SetStatus($"Connected: {_settings.ServerUrl}");
            ShowBalloon("Remount complete", $"Drive available at {_mountPoint}.");
        }
        catch (Exception ex)
        {
            SetStatus("Error");
            ShowBalloon("Remount failed", ex.Message, ToolTipIcon.Error);
        }
    }

    private void OnExit(object? sender, EventArgs e)
    {
        Shutdown();
        ExitThread();
    }

    private void Shutdown()
    {
        try
        {
            _eventLoopCts?.Cancel();
            _eventLoopCts?.Dispose();
            _eventLoopCts = null;

            // ADR-018 Step 3: WSS dispose で terminate メッセージを送信。
            // プロセス終了前に届くよう短時間ブロックする (送信失敗時は KV TTL 30s に委ねる)。
            if (_eventStream is not null)
            {
                try { _eventStream.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(2)); }
                catch { /* best-effort */ }
                _eventStream = null;
            }

            _fsHost?.Dispose();
            _fsHost = null;
            _server?.Dispose();
        }
        catch { /* ignore shutdown errors */ }

        _tray.Visible = false;
        _tray.Dispose();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) Shutdown();
        base.Dispose(disposing);
    }
}
