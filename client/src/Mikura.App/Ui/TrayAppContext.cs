using System.Diagnostics;
using System.Windows.Forms;
using Mikura.App.Config;
using Mikura.App.Profiles;
using Mikura.Core.Identity;

namespace Mikura.App.Ui;

/// <summary>
/// WinForms tray host。実 mount / WSS / sync の責務は <see cref="ProfileManager"/>
/// + <see cref="ProfileSession"/> に移譲し、本クラスは tray icon + menu + lifecycle
/// に専念する。
/// </summary>
/// <remarks>
/// Phase C 過渡: 単一 profile 想定の menu (Open / Sync now / Remount) を維持。
/// Phase D で「Profiles ▶ [name1] / [name2]」サブメニュー + per-profile 操作に拡張。
/// </remarks>
public sealed class TrayAppContext : ApplicationContext
{
    private readonly ProfileStore _store;
    private readonly GlobalSettings _globalSettings;
    private readonly NotifyIcon _tray;

    private ProfileManager? _manager;

    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _openItem;
    private readonly ToolStripMenuItem _syncNowItem;
    private readonly ToolStripMenuItem _settingsItem;
    private readonly ToolStripMenuItem _resetItem;

    public TrayAppContext(ProfileStore store, GlobalSettings globalSettings)
    {
        _store = store;
        _globalSettings = globalSettings;

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
#if DEBUG
        // ADR メモリ調査用 (LOH segment 占有確認): Force Gen2 GC + LOH compacting で
        // free space を OS に返却。Task Manager / VMMap で Managed Heap が落ちれば
        // ArrayPool 経由の LOH retain だけと判定できる (= 真 leak ではない)。
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("[Debug] Force Full GC", null, (_, _) =>
        {
            var beforeManaged = GC.GetTotalMemory(forceFullCollection: false) / 1024 / 1024;
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
            var afterManaged = GC.GetTotalMemory(forceFullCollection: false) / 1024 / 1024;
            var msg = $"[gc] managed live: {beforeManaged}MB -> {afterManaged}MB " +
                      $"(check Task Manager / VMMap for RSS / Managed Heap delta)";
            Trace.WriteLine(msg);
        }));

        // CPU 100% 切り分け用 stats snapshot。CDM 中に複数回 click すると delta が見えて
        // 「GC が頻発してるか」「ThreadPool thread が増え続けてるか」「Pending Work が
        // 詰まってるか」を判定できる。
        menu.Items.Add(new ToolStripMenuItem("[Debug] Dump Stats", null, (_, _) =>
        {
            var proc = System.Diagnostics.Process.GetCurrentProcess();
            var gen0 = GC.CollectionCount(0);
            var gen1 = GC.CollectionCount(1);
            var gen2 = GC.CollectionCount(2);
            var managedMb = GC.GetTotalMemory(forceFullCollection: false) / 1024 / 1024;
            var workingSetMb = proc.WorkingSet64 / 1024 / 1024;
            var privateMb = proc.PrivateMemorySize64 / 1024 / 1024;
            var cpuTime = proc.TotalProcessorTime;
            var threadCount = proc.Threads.Count;

            System.Threading.ThreadPool.GetAvailableThreads(out var availWorker, out var availIo);
            System.Threading.ThreadPool.GetMaxThreads(out var maxWorker, out var maxIo);
            System.Threading.ThreadPool.GetMinThreads(out var minWorker, out var minIo);
            var pending = System.Threading.ThreadPool.PendingWorkItemCount;
            var completed = System.Threading.ThreadPool.CompletedWorkItemCount;
            var tpThreadCount = System.Threading.ThreadPool.ThreadCount;

            var msg = $"[stats] proc: cpuTime={cpuTime.TotalSeconds:F1}s threads={threadCount} " +
                      $"working={workingSetMb}MB private={privateMb}MB | " +
                      $"gc: managed={managedMb}MB g0={gen0} g1={gen1} g2={gen2} | " +
                      $"tp: threads={tpThreadCount} pending={pending} completed={completed} " +
                      $"worker={maxWorker - availWorker}/{maxWorker}(min={minWorker}) " +
                      $"io={maxIo - availIo}/{maxIo}(min={minIo})";
            Trace.WriteLine(msg);
        }));
#endif
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
        var profiles = _store.LoadProfiles();
        if (profiles.Count == 0)
        {
            SetStatus("No profile");
            ShowBalloon(
                "MIKURA: no profile configured",
                $"Drop *.init.json into '{Path.Combine(AppContext.BaseDirectory, "inits")}' and restart.");
            return;
        }

        try
        {
            var deviceId = DeviceIdProvider.Compute();
            Trace.WriteLine($"Device ID: {deviceId}");

            _manager = new ProfileManager(_store, deviceId);
            _manager.LoadAndStartAllAsync(OnSessionAdded).GetAwaiter().GetResult();
            await UpdateStatusFromManagerAsync();
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[ERROR] StartAsync failed: {ex}");
            SetStatus("Error");
            ShowBalloon("MIKURA error", ex.Message, ToolTipIcon.Error);
        }
    }

    /// <summary>新 session 発火時の hook。各 session の status 変化を tray に集約する。</summary>
    private void OnSessionAdded(ProfileSession session)
    {
        session.StatusChanged += s =>
        {
            // Phase C 過渡: 単一 session 想定で先頭 session の status をそのまま表示。
            // Phase D で「2/3 profiles connected」等の集約表示に変える。
            _ = UpdateStatusFromManagerAsync();
        };
    }

    private Task UpdateStatusFromManagerAsync()
    {
        var first = _manager?.FirstOrDefault();
        if (first is null)
        {
            SetStatus("No profile");
        }
        else if (first.Status == ProfileSessionStatus.Connected)
        {
            SetStatus($"Connected: {first.Profile.ServerUrl}");
        }
        else if (first.Status == ProfileSessionStatus.Failed)
        {
            SetStatus($"Error: {first.StatusMessage}");
        }
        else
        {
            SetStatus(first.StatusMessage ?? first.Status.ToString());
        }
        return Task.CompletedTask;
    }

    private void SetStatus(string text)
    {
        if (_statusItem.Owner?.InvokeRequired == true)
            _statusItem.Owner.Invoke(() => _statusItem.Text = text);
        else
            _statusItem.Text = text;
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
        var first = _manager?.FirstOrDefault();
        var target = first?.MountPoint ?? first?.Profile.MountLetter;
        if (string.IsNullOrEmpty(target)) return;
        try
        {
            Process.Start(new ProcessStartInfo("explorer.exe", target)
            {
                UseShellExecute = true,
            });
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"OpenFolder failed: {ex.Message}");
        }
    }

    private async void OnSyncNow(object? sender, EventArgs e)
    {
        var first = _manager?.FirstOrDefault();
        if (first is null) return;
        SetStatus("Syncing...");
        var ok = await first.SyncNowAsync(CancellationToken.None);
        if (!ok)
        {
            SetStatus("Error");
            ShowBalloon("Sync failed", "See log for details.", ToolTipIcon.Error);
            return;
        }
        await UpdateStatusFromManagerAsync();
    }

    private void OnOpenSettings(object? sender, EventArgs e)
    {
        // Phase C 過渡: SettingsForm は profile-aware UI 未完成。情報表示のみ。
        using var form = new SettingsForm();
        form.ShowDialog();
    }

    /// <summary>
    /// Re-mount the current (first) profile. ADR-020/021: persistent local cache が
    /// 無いので、tear down + remount で /tree refetch + 内部 cache rebuild に等価。
    /// </summary>
    private async void OnReset(object? sender, EventArgs e)
    {
        var first = _manager?.FirstOrDefault();
        if (first is null) return;
        var target = first.MountPoint ?? first.Profile.MountLetter;
        var result = MessageBox.Show(
            $"Remount the mikura drive at {target}?\n\nIn-flight handles will fail.",
            "Remount",
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Information,
            MessageBoxDefaultButton.Button1);
        if (result != DialogResult.OK) return;

        SetStatus("Remounting...");
        try
        {
            await first.RestartAsync().ConfigureAwait(true);
            await UpdateStatusFromManagerAsync();
            ShowBalloon("Remount complete", $"Drive available at {first.MountPoint}.");
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
            if (_manager is not null)
            {
                // 同期的に dispose (ADR-018 Step 3: WSS terminate 送信を待つ短時間 block)
                _manager.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(3));
                _manager = null;
            }
        }
        catch { /* ignore shutdown errors */ }

        _tray.Visible = false;
    }
}
