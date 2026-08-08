using System.Net.Http;
using System.Windows.Forms;
using Mikura.App.Config;
using Mikura.App.Enrollment;
using Mikura.App.Ui;
using Mikura.App.Util;
using Mikura.Core.Enrollment;

namespace Mikura.App;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // ADR-034: mikura:// リンクのクリックはそのたびに新しいプロセスを起動する。
        // tray アプリはドライブをマウントするので、二重起動を許すと同じレターを
        // 取り合って壊れる。後発プロセスは引数を先発に渡して即座に終了する。
        using var instance = SingleInstance.Acquire();
        var invitationArg = FindInvitationArgument(args);

        if (!instance.IsPrimary)
        {
            if (invitationArg is not null)
            {
                SingleInstance.TrySendToPrimary(invitationArg);
            }
            return;
        }

        FileLogger.Initialize();

        ApplicationConfiguration.Initialize();

        // 起動時に inits/*.init.json を scan して enrollment を試みる (ヘッドレス /
        // 大量展開用の経路)。既存 profile はそのまま、新規があれば追加される。
        var globalSettings = GlobalSettings.Load();
        var store = new ProfileStore();
        TryEnrollFromInits(store);

        if (OperatingSystem.IsWindows())
        {
            UriSchemeRegistrar.TryRegister(Environment.ProcessPath ?? Application.ExecutablePath);
        }

        using var context = new TrayAppContext(store, globalSettings)
        {
            PendingInvitationText = invitationArg,
        };
        instance.StartListening(context.HandleActivationPayload);
        Application.Run(context);
    }

    /// <summary>
    /// argv から招待リンクを拾う。
    /// </summary>
    /// <remarks>
    /// protocol handler 経由では argv[0] に URI が入るが、位置に依存させない —
    /// ショートカットに他の引数が付いている環境で壊れないようにする。
    /// ここでは形式検証まではせず、scheme 一致だけを見る (中身の妥当性は
    /// ダイアログ側で判定して、理由を user に見せる)。
    /// </remarks>
    private static string? FindInvitationArgument(string[] args)
    {
        var prefix = $"{EnrollmentInvitation.UriScheme}:";
        return args.FirstOrDefault(a =>
            a.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }

    private static void TryEnrollFromInits(ProfileStore store)
    {
        if (!OperatingSystem.IsWindows()) return;
        try
        {
            using var http = new HttpClient
            {
                Timeout = TimeSpan.FromSeconds(15),
            };
            var scanner = new EnrollmentScanner(store, http);
            // 同期 wait: 起動直後の bootstrap path なので、scan 完了まで block しても
            // tray icon の表示が遅れるだけで害なし (= profile が揃ってからの方が
            // TrayAppContext 側の状態整合が取りやすい)。
            scanner.ScanAndEnrollAsync().GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            // enrollment 失敗は致命的ではない (= 既存 profile があれば普通に起動できる)。
            System.Diagnostics.Trace.WriteLine(
                $"[Program] enrollment scan failed: {ex.Message}");
        }
    }
}
