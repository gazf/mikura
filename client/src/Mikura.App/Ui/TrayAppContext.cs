using System.Diagnostics;
using System.Net.Http;
using System.Windows.Forms;
using Mikura.App.Config;
using Mikura.App.Enrollment;
using Mikura.App.Profiles;
using Mikura.Core.Enrollment;
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

    /// <summary>
    /// UI スレッドへの marshal 用。<see cref="NotifyIcon"/> は Control ではなく
    /// Invoke を持たないので、ハンドルを持つ不可視 Control を 1 つ立てておく。
    /// </summary>
    private readonly Control _marshaller;

    /// <summary>
    /// 起動引数で渡された mikura:// リンク。初期化完了後にダイアログを開く。
    /// </summary>
    public string? PendingInvitationText { get; init; }

    public TrayAppContext(ProfileStore store, GlobalSettings globalSettings)
    {
        _store = store;
        _globalSettings = globalSettings;

        _marshaller = new Control();
        // Handle を触ることで、この (= UI) スレッド上でウィンドウハンドルを
        // 確定させる。CreateControl() は非表示・親なしのコントロールでは
        // ハンドルを作らないので、BeginInvoke の marshal 先にならない。
        _ = _marshaller.Handle;

        _statusItem = new ToolStripMenuItem("Initializing...") { Enabled = false };
        _profilesItem = new ToolStripMenuItem("Profiles");
        _addProfileItem = new ToolStripMenuItem("プロファイルを追加...", null, OnAddProfile);
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

            // mikura:// リンクから起動された場合は、マウントが落ち着いてから
            // ダイアログを出す (ドライブレター候補が確定した状態で見せるため)。
            if (!string.IsNullOrWhiteSpace(PendingInvitationText))
            {
                await ShowAddProfileAsync(PendingInvitationText).ConfigureAwait(true);
            }
            else if (_manager.Sessions.Count == 0)
            {
                ShowBalloon(
                    "MIKURA: プロファイル未設定",
                    "メニューの「プロファイルを追加」から、管理者に発行してもらった招待リンクを貼り付けてください。");
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
    /// 招待リンクを貼り付け → POST /enroll → ProfileManager に登録。
    /// </summary>
    /// <remarks>
    /// ADR-034: 入口はファイル選択ではなく貼り付け 1 欄。ダイアログ側で招待の
    /// 形式検証とドライブレター選択まで済ませてから、ここで実際に enrollment を
    /// 走らせる。失敗理由は balloon に出す (従来は inits/failed/ に黙って
    /// 移動するだけで user からは見えなかった)。
    /// </remarks>
    private void OnAddProfile(object? sender, EventArgs e) => _ = ShowAddProfileAsync(null);

    /// <summary>
    /// mikura:// リンクのクリックで後発プロセスから渡された引数を処理する。
    /// パイプのスレッドから呼ばれるので、UI スレッドへ marshal する。
    /// </summary>
    public void HandleActivationPayload(string payload)
    {
        if (string.IsNullOrWhiteSpace(payload)) return;
        try
        {
            _marshaller.BeginInvoke(() => _ = ShowAddProfileAsync(payload));
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[Tray] activation payload dropped: {ex.Message}");
        }
    }

    private async Task ShowAddProfileAsync(string? prefill)
    {
        if (_manager is null) return;

        var reserved = _store.LoadProfiles().Select(p => p.MountLetter).ToArray();
        EnrollmentInvitation invitation;
        string? mountLetter;
        using (var dialog = new AddProfileForm(reserved, prefill))
        {
            if (dialog.ShowDialog() != DialogResult.OK || dialog.Invitation is null)
            {
                return;
            }
            invitation = dialog.Invitation;
            mountLetter = dialog.MountLetter;
        }

        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            var client = new EnrollmentClient(_store, http);
            var profile = await client
                .EnrollAsync(invitation, mountLetter)
                .ConfigureAwait(true);

            // 新規 profile は store に乗っているので、LoadAndStartAll を再実行して
            // session だけ立ち上げる (既存 session は重複 add で skip される)。
            await _manager.LoadAndStartAllAsync(OnSessionAdded).ConfigureAwait(true);
            RefreshProfilesMenu();
            UpdateAggregateStatus();
            ShowBalloon("プロファイルを追加しました",
                $"{profile.Name} を {profile.MountLetter} にマウントしました。");
        }
        catch (Exception ex)
        {
            ShowBalloon("プロファイルの追加に失敗しました", ex.Message, ToolTipIcon.Error);
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
        _marshaller.Dispose();
    }
}
