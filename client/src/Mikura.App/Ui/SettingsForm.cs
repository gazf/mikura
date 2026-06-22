using System.Windows.Forms;

namespace Mikura.App.Ui;

/// <summary>
/// Phase B 過渡実装: 旧 AppSettings ベースの form を一時的に「情報表示のみ」に
/// 縮退させる。本格的な profile-aware UI (= profile list editor、init.json import
/// dialog 等) は Phase D で実装する。
/// </summary>
/// <remarks>
/// 現状 user 操作の経路: <c>&lt;exe-dir&gt;/inits/</c> に admin から配布された
/// <c>*.init.json</c> を drop して mikura を再起動する。enrollment 完了で
/// <c>profiles/</c> 配下に profile が出来上がる。
/// </remarks>
public class SettingsForm : Form
{
    public SettingsForm()
    {
        Text = "MIKURA Settings";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = false;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(440, 200);

        var label = new Label
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            AutoSize = false,
            Padding = new Padding(16),
            Text =
                "Profile-aware settings UI is under construction.\n\n" +
                "To add a profile, drop an `*.init.json` file into:\n" +
                $"  {Path.Combine(AppContext.BaseDirectory, "inits")}\n\n" +
                "Then restart MIKURA.",
        };

        var okBtn = new Button
        {
            Text = "Close",
            DialogResult = DialogResult.OK,
            Dock = DockStyle.Bottom,
            Height = 32,
        };

        Controls.Add(label);
        Controls.Add(okBtn);
        AcceptButton = okBtn;
    }
}
