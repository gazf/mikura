using System.Windows.Forms;
using Mikura.App.Config;

namespace Mikura.App.Ui;

public class SettingsForm : Form
{
    private readonly AppSettings _settings;

    private readonly TextBox _serverUrl = new() { Width = 320 };
    private readonly TextBox _bearerToken = new() { Width = 320, UseSystemPasswordChar = true };
    private readonly TextBox _syncRoot = new() { Width = 260 };
    private readonly Button _browseBtn = new() { Text = "...", Width = 36 };
    private readonly NumericUpDown _syncInterval = new() { Minimum = 30, Maximum = 3600, Value = 300, Width = 100 };
    private readonly Button _okBtn = new() { Text = "OK", DialogResult = DialogResult.OK, Width = 80 };
    private readonly Button _cancelBtn = new() { Text = "Cancel", DialogResult = DialogResult.Cancel, Width = 80 };

    public SettingsForm(AppSettings settings)
    {
        _settings = settings;
        Text = "MIKURA Settings";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = false;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(440, 220);
        AcceptButton = _okBtn;
        CancelButton = _cancelBtn;

        _serverUrl.Text = settings.ServerUrl;
        _bearerToken.Text = settings.BearerToken;
        _syncRoot.Text = settings.SyncRootPath;
        _syncInterval.Value = Math.Clamp(settings.SyncIntervalSeconds, (int)_syncInterval.Minimum, (int)_syncInterval.Maximum);

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(12),
            ColumnCount = 2,
            RowCount = 5,
            AutoSize = true
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        layout.Controls.Add(new Label { Text = "Server URL:", Anchor = AnchorStyles.Left, AutoSize = true }, 0, 0);
        layout.Controls.Add(_serverUrl, 1, 0);

        layout.Controls.Add(new Label { Text = "Bearer Token:", Anchor = AnchorStyles.Left, AutoSize = true }, 0, 1);
        layout.Controls.Add(_bearerToken, 1, 1);

        var syncRootPanel = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, AutoSize = true, Margin = Padding.Empty };
        syncRootPanel.Controls.Add(_syncRoot);
        syncRootPanel.Controls.Add(_browseBtn);
        _browseBtn.Click += OnBrowse;

        layout.Controls.Add(new Label { Text = "Sync Root:", Anchor = AnchorStyles.Left, AutoSize = true }, 0, 2);
        layout.Controls.Add(syncRootPanel, 1, 2);

        layout.Controls.Add(new Label { Text = "Sync Interval (s):", Anchor = AnchorStyles.Left, AutoSize = true }, 0, 3);
        layout.Controls.Add(_syncInterval, 1, 3);

        var buttons = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Bottom,
            Height = 44,
            Padding = new Padding(0, 8, 12, 8)
        };
        buttons.Controls.Add(_cancelBtn);
        buttons.Controls.Add(_okBtn);

        Controls.Add(layout);
        Controls.Add(buttons);

        _okBtn.Click += OnOk;
    }

    private void OnBrowse(object? sender, EventArgs e)
    {
        using var dlg = new FolderBrowserDialog
        {
            Description = "Select MIKURA sync root folder",
            SelectedPath = string.IsNullOrWhiteSpace(_syncRoot.Text)
                ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)
                : _syncRoot.Text
        };
        if (dlg.ShowDialog(this) == DialogResult.OK)
            _syncRoot.Text = dlg.SelectedPath;
    }

    private void OnOk(object? sender, EventArgs e)
    {
        if (string.IsNullOrWhiteSpace(_serverUrl.Text)) { Warn("Server URL is required."); return; }
        if (string.IsNullOrWhiteSpace(_bearerToken.Text)) { Warn("Bearer token is required."); return; }
        if (string.IsNullOrWhiteSpace(_syncRoot.Text)) { Warn("Sync root is required."); return; }

        _settings.ServerUrl = _serverUrl.Text.Trim();
        _settings.BearerToken = _bearerToken.Text.Trim();
        _settings.SyncRootPath = _syncRoot.Text.Trim();
        _settings.SyncIntervalSeconds = (int)_syncInterval.Value;
        _settings.Save();
    }

    private void Warn(string message)
    {
        MessageBox.Show(this, message, "MIKURA", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        DialogResult = DialogResult.None;
    }
}
