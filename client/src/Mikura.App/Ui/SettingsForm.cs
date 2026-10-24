using System.Windows.Forms;
using Mikura.App.Config;

namespace Mikura.App.Ui;

/// <summary>
/// Profile-aware Settings dialog (Phase D)。左に profile 一覧、右に選択 profile の
/// detail (ServerUrl 表示 + MountLetter 編集可)。Bottom に global settings
/// (SyncIntervalSeconds)。
/// </summary>
/// <remarks>
/// <para>profile 自体の追加 / 削除は Tray menu の「Add Profile...」「Remove」経由。
/// 本 form は **既存 profile の metadata 編集** に専念する (= drive letter 変更等)。
/// 変更を mount に反映するには MIKURA 再起動 (or per-profile Remount) が必要、
/// 旨を user に balloon で案内する。</para>
///
/// <para>Phase D minimum: list 選択 + drive letter 編集 + Save。複数 profile を
/// 切り替えながら編集可能だが、編集中は in-memory 保持で OK 時に store へ flush。</para>
/// </remarks>
public class SettingsForm : Form
{
    private readonly ProfileStore _store;
    private readonly GlobalSettings _globalSettings;

    private readonly ListBox _profileList = new()
    {
        Width = 160,
        Dock = DockStyle.Left,
    };
    private readonly TextBox _serverUrl = new()
    {
        Width = 280,
        ReadOnly = true,
    };
    private readonly TextBox _mountLetter = new() { Width = 80 };
    private readonly NumericUpDown _syncInterval = new()
    {
        Minimum = 30,
        Maximum = 3600,
        Value = 300,
        Width = 100,
    };
    private readonly Button _saveBtn = new()
    {
        Text = "Save",
        DialogResult = DialogResult.OK,
        Width = 80,
    };
    private readonly Button _cancelBtn = new()
    {
        Text = "Cancel",
        DialogResult = DialogResult.Cancel,
        Width = 80,
    };

    private readonly Dictionary<string, Profile> _edited = new();

    public SettingsForm(ProfileStore store, GlobalSettings globalSettings)
    {
        _store = store;
        _globalSettings = globalSettings;

        Text = "MIKURA Settings";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = false;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(560, 320);
        AcceptButton = _saveBtn;
        CancelButton = _cancelBtn;

        _syncInterval.Value = Math.Clamp(
            _globalSettings.SyncIntervalSeconds,
            (int)_syncInterval.Minimum,
            (int)_syncInterval.Maximum);

        // Profile list (left panel)
        var profiles = _store.LoadProfiles();
        foreach (var p in profiles)
        {
            _edited[p.Name] = p;
            _profileList.Items.Add(p.Name);
        }
        _profileList.SelectedIndexChanged += OnSelectProfile;

        // Detail panel (right)
        var detail = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            ColumnCount = 2,
            RowCount = 4,
            AutoSize = false,
        };
        detail.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        detail.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        detail.Controls.Add(new Label
        {
            Text = "Server URL:",
            Anchor = AnchorStyles.Left,
            AutoSize = true,
        }, 0, 0);
        detail.Controls.Add(_serverUrl, 1, 0);

        detail.Controls.Add(new Label
        {
            Text = "Mount Letter:",
            Anchor = AnchorStyles.Left,
            AutoSize = true,
        }, 0, 1);
        detail.Controls.Add(_mountLetter, 1, 1);

        detail.Controls.Add(new Label
        {
            Text = "Sync Interval (s):",
            Anchor = AnchorStyles.Left,
            AutoSize = true,
        }, 0, 2);
        detail.Controls.Add(_syncInterval, 1, 2);

        _mountLetter.TextChanged += OnMountLetterChanged;

        // Bottom button row
        var btnRow = new FlowLayoutPanel
        {
            Dock = DockStyle.Bottom,
            FlowDirection = FlowDirection.RightToLeft,
            Height = 40,
            Padding = new Padding(8),
        };
        btnRow.Controls.Add(_cancelBtn);
        btnRow.Controls.Add(_saveBtn);

        Controls.Add(detail);
        Controls.Add(_profileList);
        Controls.Add(btnRow);

        // 初期選択
        if (_profileList.Items.Count > 0)
        {
            _profileList.SelectedIndex = 0;
        }
        else
        {
            _serverUrl.Text = "(no profile)";
            _mountLetter.Enabled = false;
        }

        _saveBtn.Click += OnSave;
    }

    private string? _currentName;

    private void OnSelectProfile(object? sender, EventArgs e)
    {
        if (_profileList.SelectedItem is not string name) return;
        if (!_edited.TryGetValue(name, out var p)) return;
        _currentName = name;
        _serverUrl.Text = p.ServerUrl;
        _mountLetter.Text = p.MountLetter;
    }

    private void OnMountLetterChanged(object? sender, EventArgs e)
    {
        if (_currentName is null) return;
        if (!_edited.TryGetValue(_currentName, out var p)) return;
        _edited[_currentName] = p with { MountLetter = _mountLetter.Text.Trim() };
    }

    private void OnSave(object? sender, EventArgs e)
    {
        // 全 edited を flush
        foreach (var p in _edited.Values)
        {
            _store.SaveProfile(p);
        }
        _globalSettings.SyncIntervalSeconds = (int)_syncInterval.Value;
        _globalSettings.Save();

        MessageBox.Show(
            "Settings saved. Drive letter changes require restart or Remount of the affected profile.",
            "MIKURA Settings",
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }
}
