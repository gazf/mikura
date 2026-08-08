using System.Runtime.Versioning;
using System.Windows.Forms;
using Mikura.App.Enrollment;
using Mikura.Core.Enrollment;

namespace Mikura.App.Ui;

/// <summary>
/// 招待リンクを貼り付けてプロファイルを追加するダイアログ。
/// </summary>
/// <remarks>
/// <para>ADR-034: 従来は <c>OpenFileDialog</c> で init.json を選ばせていたが、
/// 「管理者から送られた JSON ファイルを選んでください」は一般ユーザーには
/// 通じない。入力欄 1 つに畳み、開いた瞬間にクリップボードを覗いて
/// 招待らしきものがあれば自動で埋める。</para>
///
/// <para>失敗理由はダイアログ内に出す。従来は <c>inits/failed/</c> に黙って
/// 移動して Trace に書くだけで、user が必要とするその瞬間には何も見えなかった。</para>
/// </remarks>
[SupportedOSPlatform("windows")]
public sealed class AddProfileForm : Form
{
    private readonly IReadOnlyList<string> _reservedLetters;

    private readonly TextBox _invitation = new()
    {
        Multiline = true,
        ScrollBars = ScrollBars.Vertical,
        Width = 460,
        Height = 68,
    };
    private readonly ComboBox _mountLetter = new()
    {
        DropDownStyle = ComboBoxStyle.DropDownList,
        Width = 90,
    };
    private readonly Label _status = new()
    {
        AutoSize = false,
        Width = 460,
        Height = 34,
        ForeColor = Color.Firebrick,
    };
    private readonly Button _okBtn = new() { Text = "追加", Width = 90 };
    private readonly Button _cancelBtn = new()
    {
        Text = "キャンセル",
        Width = 90,
        DialogResult = DialogResult.Cancel,
    };

    /// <summary>OK で閉じたときのみ非 null。</summary>
    public EnrollmentInvitation? Invitation { get; private set; }

    /// <summary>OK で閉じたときのみ非 null。</summary>
    public string? MountLetter { get; private set; }

    /// <param name="reservedLetters">
    /// 既存 profile が使用中 / 予約中のドライブレター。候補から除く。
    /// </param>
    /// <param name="prefill">
    /// 事前に埋めておくテキスト (mikura:// リンクのクリック経由)。null なら
    /// クリップボードを見る。
    /// </param>
    public AddProfileForm(IReadOnlyList<string> reservedLetters, string? prefill = null)
    {
        _reservedLetters = reservedLetters;

        Text = "プロファイルを追加";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = false;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(500, 260);
        CancelButton = _cancelBtn;
        AcceptButton = _okBtn;

        BuildLayout();
        PopulateDriveLetters();
        if (string.IsNullOrWhiteSpace(prefill))
        {
            PrefillFromClipboard();
        }
        else
        {
            _invitation.Text = prefill.Trim();
        }

        _okBtn.Click += OnOk;
        _invitation.TextChanged += (_, _) => ClearStatus();
    }

    private void BuildLayout()
    {
        var help = new Label
        {
            AutoSize = false,
            Width = 460,
            Height = 34,
            Text = "管理者から受け取った招待リンクを貼り付けてください。" +
                   "(mikura:// で始まるリンク、または init.json の中身)",
            ForeColor = SystemColors.GrayText,
        };

        var letterLabel = new Label
        {
            Text = "ドライブ",
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            Padding = new Padding(0, 6, 0, 0),
        };

        var letterRow = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.LeftToRight,
            AutoSize = true,
            WrapContents = false,
            Margin = new Padding(0, 6, 0, 0),
        };
        letterRow.Controls.Add(letterLabel);
        letterRow.Controls.Add(_mountLetter);

        var buttonRow = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.RightToLeft,
            AutoSize = true,
            WrapContents = false,
            Width = 460,
        };
        buttonRow.Controls.Add(_okBtn);
        buttonRow.Controls.Add(_cancelBtn);

        var root = new FlowLayoutPanel
        {
            FlowDirection = FlowDirection.TopDown,
            Dock = DockStyle.Fill,
            Padding = new Padding(16),
            WrapContents = false,
        };
        root.Controls.Add(help);
        root.Controls.Add(_invitation);
        root.Controls.Add(letterRow);
        root.Controls.Add(_status);
        root.Controls.Add(buttonRow);
        Controls.Add(root);
    }

    private void PopulateDriveLetters()
    {
        var free = DriveLetters.ListFree(_reservedLetters);
        if (free.Count == 0)
        {
            // 全て埋まっている状態。追加させても必ずマウントに失敗するので、
            // ここで止めて理由を出す方が親切。
            _mountLetter.Enabled = false;
            _okBtn.Enabled = false;
            ShowStatus("空きドライブレターがありません。既存のドライブを整理してください。");
            return;
        }

        foreach (var letter in free)
        {
            _mountLetter.Items.Add(letter);
        }
        _mountLetter.SelectedIndex = 0;
    }

    /// <summary>
    /// クリップボードに招待らしきものがあれば入力欄を埋める。
    /// 解釈できない中身は無視する (無関係なテキストで欄を汚さない)。
    /// </summary>
    private void PrefillFromClipboard()
    {
        string text;
        try
        {
            if (!Clipboard.ContainsText()) return;
            text = Clipboard.GetText();
        }
        catch
        {
            // 他プロセスがクリップボードをロックしている等。プリフィルは
            // あくまで利便性なので、失敗しても黙って諦める。
            return;
        }

        if (!EnrollmentInvitation.TryParse(text, out _, out _)) return;

        _invitation.Text = text.Trim();
        ShowInfo("クリップボードの招待リンクを読み込みました。");
    }

    private void OnOk(object? sender, EventArgs e)
    {
        if (!EnrollmentInvitation.TryParse(_invitation.Text, out var invitation, out var error))
        {
            ShowStatus(error ?? "招待リンクを解釈できませんでした。");
            _invitation.Focus();
            return;
        }

        Invitation = invitation;
        MountLetter = _mountLetter.SelectedItem as string;
        DialogResult = DialogResult.OK;
        Close();
    }

    private void ShowStatus(string message)
    {
        _status.ForeColor = Color.Firebrick;
        _status.Text = message;
    }

    private void ShowInfo(string message)
    {
        _status.ForeColor = SystemColors.GrayText;
        _status.Text = message;
    }

    private void ClearStatus() => _status.Text = string.Empty;
}
