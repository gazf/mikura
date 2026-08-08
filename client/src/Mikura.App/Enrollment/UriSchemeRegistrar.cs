using System.Runtime.Versioning;
using Microsoft.Win32;
using Mikura.Core.Enrollment;

namespace Mikura.App.Enrollment;

/// <summary>
/// <c>mikura://</c> を自プロセスに関連付ける。
/// </summary>
/// <remarks>
/// <para>ADR-034: 招待をリンクとして送れると、user 側の作業は「クリックして
/// 確認する」だけになる。<c>HKCU\Software\Classes</c> に書くので管理者権限も
/// インストーラも要らない。</para>
///
/// <para>毎回起動時に呼んで冪等に上書きする。実行ファイルが移動しても
/// 追随させたいので、既存エントリの有無ではなく **パスが一致するか** を見る。</para>
/// </remarks>
public static class UriSchemeRegistrar
{
    private const string KeyPath = $@"Software\Classes\{EnrollmentInvitation.UriScheme}";

    /// <summary>
    /// 関連付けを登録する。失敗しても例外は投げない (= 貼り付け経路が残るので
    /// 致命的ではない)。登録したか、既に最新だったかを返す。
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static bool TryRegister(string executablePath)
    {
        var command = $"\"{executablePath}\" \"%1\"";
        try
        {
            using var existing = Registry.CurrentUser.OpenSubKey($@"{KeyPath}\shell\open\command");
            if (existing?.GetValue(null) as string == command)
            {
                return false; // 既に最新
            }

            using var key = Registry.CurrentUser.CreateSubKey(KeyPath);
            key.SetValue(null, "URL:mikura Protocol");
            // この空値が「URL の scheme である」ことを Windows に伝える印。
            key.SetValue("URL Protocol", string.Empty);

            using var commandKey = key.CreateSubKey(@"shell\open\command");
            commandKey.SetValue(null, command);

            System.Diagnostics.Trace.WriteLine(
                $"[UriScheme] registered {EnrollmentInvitation.UriScheme}:// handler");
            return true;
        }
        catch (Exception ex)
        {
            // グループポリシーで HKCU への書き込みが制限されている等。
            System.Diagnostics.Trace.WriteLine(
                $"[UriScheme] registration skipped: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }
}
