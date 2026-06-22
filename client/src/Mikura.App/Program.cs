using System.Net.Http;
using System.Windows.Forms;
using Mikura.App.Config;
using Mikura.App.Enrollment;
using Mikura.App.Ui;
using Mikura.App.Util;

namespace Mikura.App;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        FileLogger.Initialize();

        ApplicationConfiguration.Initialize();

        // Phase B: 起動時に inits/*.init.json を scan して enrollment を試みる。
        // 既存 profile はそのまま、新規 profile があれば profiles/ 配下に追加される。
        // ProfileStore + GlobalSettings は新 layout (= profile per dir) を使う。
        var globalSettings = GlobalSettings.Load();
        var store = new ProfileStore();
        TryEnrollFromInits(store);

        var profiles = store.LoadProfiles();
        // Phase B では「単一 profile (一覧の先頭)」で従来通り動かす compat 経路。
        // Phase C で ProfileManager + ProfileSession を導入し、Phase D で多重 mount に
        // 拡張する。
        var profile = profiles.FirstOrDefault();

        using var context = new TrayAppContext(store, globalSettings, profile);
        Application.Run(context);
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
