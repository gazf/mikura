using System.Diagnostics;
using System.Net.Http;
using System.Windows.Forms;
using Mikura.App.Config;
using Mikura.App.Enrollment;
using Mikura.App.Profiles;
using Mikura.Core.Identity;

namespace Mikura.App.Ui;

/// <summary>
/// WinForms tray host (Phase D)。multi-profile aware menu と Settings dialog を
/// 提供する。実 mount / WSS / sync の責務は <see cref="ProfileManager"/> +
/// <see cref="ProfileSession"/> に移譲済み (Phase C で完了)。
/// </summary>
public sealed class TrayAppContext : ApplicationContext
{
    private readonly ProfileStore _store;
    private readonly GlobalSettings _globalSettings;
    private readonly NotifyIcon _tray;
    private readonly ContextMenuStrip _menu;

    private ProfileManager? _manager;

    private readonly ToolStripMenuItem _statusItem;
    private readonly ToolStripMenuItem _profilesItem;
    private readonly ToolStripMenuItem _addProfileItem;
    private readonly ToolStripMenuItem _settingsItem;

    public TrayAppContext(ProfileStore store, GlobalSettings globalSettings)
    {
        _store = store;
        _globalSettings = globalSettings;

        _statusItem = new ToolStripMenuItem("Initializing...") { Enabled = false };
        _profilesItem = new ToolStripMenuItem("Profiles");
        _addProfileItem = new ToolStripMenuItem("Add Profile...", null, OnAddProfile);
        _settingsItem = new ToolStripMenuItem("Settings...", null, OnOpenSettings);

        _menu = new ContextMenuStrip();
        _menu.Items.Add(_statusItem);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(_profilesItem);
        _menu.Items.Add(_addProfileItem);
        _menu.Items.Add(_settingsItem);
#if DEBUG
        // ADR メモリ調査用 (LOH segment 占有確認): Force Gen2 GC + LOH compacting で
        // free space を OS に返却。Task Manager / VMMap で Managed Heap が落ちれば
        // ArrayPool 経由の LOH retain だけと判定できる (= 真 leak ではない)。
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(new ToolStripMenuItem("[Debug] Force Full GC", null, (_, _) =>
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

        // CPU 100% 切り分け用 stats snapshot。
        _menu.Items.Add(new ToolStripMenuItem("[Debug] Dump Stats", null, (_, _) =>
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
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(new ToolStripMenuItem("Exit", null, OnExit));

        _tray = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "MIKURA",
            Visible = true,
            ContextMenuStrip = _menu,
        };
        _tray.DoubleClick += OnTrayDoubleClick;

        _ = StartAsync();
    }

    private async Task StartAsync()
    {
        try
        {
            var deviceId = DeviceIdProvider.Compute();
            Trace.WriteLine($"Device ID: {deviceId}");

            _manager = new ProfileManager(_store, deviceId);
            await _manager.LoadAndStartAllAsync(OnSessionAdded).ConfigureAwait(true);
            RefreshProfilesMenu();
            UpdateAggregateStatus();

            if (_manager.Sessions.Count == 0)
            {
                ShowBalloon(
                    "MIKURA: no profile configured",
                    $"Use 'Add Profile...' menu or drop *.init.json into '{Path.Combine(AppContext.BaseDirectory, "inits")}'.");
            }
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[ERROR] StartAsync failed: {ex}");
            SetStatus("Error");
            ShowBalloon("MIKURA error", ex.Message, ToolTipIcon.Error);
        }
    }

    private void OnSessionAdded(ProfileSession session)
    {
        session.StatusChanged += _ => UpdateAggregateStatus();
    }

    /// <summary>
    /// 全 session の status を集約して 1 行にまとめる。
    ///   - 0 session: "No profile"
    ///   - 全 Connected: "Connected: N profiles"
    ///   - 一部 Failed/Connecting: "X/N connected"
    /// </summary>
    private void UpdateAggregateStatus()
    {
        if (_manager is null)
        {
            SetStatus("Initializing...");
            return;
        }
        var sessions = _manager.Sessions;
        if (sessions.Count == 0)
        {
            SetStatus("No profile");
            return;
        }
        var connected = sessions.Count(s => s.Status == ProfileSessionStatus.Connected);
        if (connected == sessions.Count)
        {
            SetStatus(connected == 1
                ? $"Connected: {sessions.First().Profile.ServerUrl}"
                : $"Connected: {connected} profiles");
        }
        else
        {
            SetStatus($"{connected}/{sessions.Count} profiles connected");
        }
    }

    /// <summary>
    /// Profiles サブメニューを refresh。各 profile につき "<name> (status)" → 子 menu
    /// で Open / Sync now / Remount / Remove を提供。
    /// </summary>
    private void RefreshProfilesMenu()
    {
        _profilesItem.DropDownItems.Clear();
        if (_manager is null || _manager.Sessions.Count == 0)
        {
            _profilesItem.DropDownItems.Add(new ToolStripMenuItem("(none)")
            {
                Enabled = false,
            });
            return;
        }
        foreach (var session in _manager.Sessions)
        {
            var label = $"{session.Profile.Name} [{FormatStatus(session)}]";
            var item = new ToolStripMenuItem(label);
            item.DropDownItems.Add(new ToolStripMenuItem("Open", null,
                (_, _) => OpenProfile(session)));
            item.DropDownItems.Add(new ToolStripMenuItem("Sync now", null,
                async (_, _) => await SyncProfile(session)));
            item.DropDownItems.Add(new ToolStripMenuItem("Remount", null,
                async (_, _) => await RemountProfile(session)));
            item.DropDownItems.Add(new ToolStripSeparator());
            item.DropDownItems.Add(new ToolStripMenuItem("Remove", null,
                async (_, _) => await RemoveProfile(session)));
            _profilesItem.DropDownItems.Add(item);
        }
    }

    private static string FormatStatus(ProfileSession s) => s.Status switch
    {
        ProfileSessionStatus.Connected => "OK",
        ProfileSessionStatus.Connecting => "...",
        ProfileSessionStatus.Failed => "ERR",
        _ => "—",
    };

    private void OpenProfile(ProfileSession session)
    {
        var target = session.MountPoint ?? session.Profile.MountLetter;
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
            Trace.WriteLine($"OpenProfile({session.Profile.Name}) failed: {ex.Message}");
        }
    }

    private async Task SyncProfile(ProfileSession session)
    {
        var ok = await session.SyncNowAsync(CancellationToken.None);
        if (!ok)
        {
            ShowBalloon($"Sync failed: {session.Profile.Name}",
                "See log for details.", ToolTipIcon.Error);
        }
    }

    private async Task RemountProfile(ProfileSession session)
    {
        var target = session.MountPoint ?? session.Profile.MountLetter;
        var result = MessageBox.Show(
            $"Remount '{session.Profile.Name}' at {target}?\n\nIn-flight handles will fail.",
            "Remount",
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Information);
        if (result != DialogResult.OK) return;
        try
        {
            await session.RestartAsync().ConfigureAwait(true);
            RefreshProfilesMenu();
            UpdateAggregateStatus();
            ShowBalloon("Remount complete",
                $"{session.Profile.Name} → {session.MountPoint}.");
        }
        catch (Exception ex)
        {
            ShowBalloon($"Remount failed: {session.Profile.Name}",
                ex.Message, ToolTipIcon.Error);
        }
    }

    private async Task RemoveProfile(ProfileSession session)
    {
        var result = MessageBox.Show(
            $"Remove profile '{session.Profile.Name}'?\n\n" +
            "This unmounts the drive and deletes secret.bin + profile.json.\n" +
            "Bearer token will need re-enrollment.",
            "Remove Profile",
            MessageBoxButtons.OKCancel,
            MessageBoxIcon.Warning);
        if (result != DialogResult.OK) return;
        if (_manager is null) return;
        await _manager.RemoveAsync(session.Profile.Name).ConfigureAwait(true);
        RefreshProfilesMenu();
        UpdateAggregateStatus();
    }

    /// <summary>
    /// init.json file を選択 → POST /enroll → ProfileManager に登録。
    /// 多 profile 中の操作経路として scope された scanner (inits/ dir 一括ではなく
    /// 単一 file 直接) を使う。
    /// </summary>
    private async void OnAddProfile(object? sender, EventArgs e)
    {
        if (_manager is null) return;
        using var dialog = new OpenFileDialog
        {
            Title = "Select init.json from admin",
            Filter = "init.json (*.json)|*.json|All files|*.*",
        };
        if (dialog.ShowDialog() != DialogResult.OK) return;

        var sourcePath = dialog.FileName;
        var initsDir = Path.Combine(AppContext.BaseDirectory, "inits");
        Directory.CreateDirectory(initsDir);

        // EnrollmentScanner は inits/ 配下を scan する想定なので、選択した file を
        // 一旦 inits/ 直下に copy してから scan を回す。成功すれば scanner が
        // file 自体を削除する。
        var destFile = Path.Combine(initsDir,
            $"{Path.GetFileNameWithoutExtension(sourcePath)}.{Guid.NewGuid():N}.init.json");
        try
        {
            File.Copy(sourcePath, destFile);
        }
        catch (Exception ex)
        {
            ShowBalloon("Add Profile failed", ex.Message, ToolTipIcon.Error);
            return;
        }

        try
        {
            using var http = new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(15),
            };
            var scanner = new EnrollmentScanner(_store, http);
            var created = await scanner.ScanAndEnrollAsync().ConfigureAwait(true);
            if (created == 0)
            {
                ShowBalloon("Add Profile",
                    "No new profile created. See inits/failed/ for details.",
                    ToolTipIcon.Warning);
                return;
            }

            // 新規 profile が ProfileStore に乗ったので、まだ session 化されていない
            // ものを spawn する。
            var existing = _manager.Sessions.Select(s => s.Profile.Name).ToHashSet();
            foreach (var profile in _store.LoadProfiles())
            {
                if (existing.Contains(profile.Name)) continue;
                // token は store に保存済み、AddAndStart は保存も含むので
                // 既に保存済みなら overwrite される (= idempotent)。代わりに
                // session だけ立ち上げる経路として、LoadAndStartAll を再実行する。
            }
            // 簡単化: scanner 完了後に LoadAndStartAll を再実行 (= 既存 session は
            // 重複 add で skip される、新規だけ追加される)。
            await _manager.LoadAndStartAllAsync(OnSessionAdded).ConfigureAwait(true);
            RefreshProfilesMenu();
            UpdateAggregateStatus();
            ShowBalloon("Add Profile",
                $"{created} profile(s) enrolled and mounted.");
        }
        catch (Exception ex)
        {
            ShowBalloon("Add Profile failed", ex.Message, ToolTipIcon.Error);
        }
    }

    private void OnOpenSettings(object? sender, EventArgs e)
    {
        using var form = new SettingsForm(_store, _globalSettings);
        form.ShowDialog();
        // Settings 変更 (= mount letter 変更等) があれば profile を restart して
        // 反映する。簡単化: 全 manager を tear down + 再 LoadAndStartAll は重いので、
        // user に「Restart MIKURA で反映」案内のみ (= Phase D の minimum 実装)。
        RefreshProfilesMenu();
    }

    private void OnTrayDoubleClick(object? sender, EventArgs e)
    {
        var first = _manager?.FirstOrDefault();
        if (first is not null) OpenProfile(first);
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
                _manager.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(3));
                _manager = null;
            }
        }
        catch { /* ignore shutdown errors */ }

        _tray.Visible = false;
    }
}
