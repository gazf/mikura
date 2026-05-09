using System.Text.Json;

namespace Mikura.App.Config;

public class AppSettings
{
    // 既定は IPv4 直指定。`localhost` だと Windows が IPv6 (`::1`) を先に
    // 試すが、WSL2 は Windows 側の `::1` を VM 内へフォワードしないため、
    // SYN リトライで ~21 秒のスタートアップ遅延を踏む。
    public string ServerUrl { get; set; } = "http://127.0.0.1:8700";
    public string BearerToken { get; set; } = "";
    public string SyncRootPath { get; set; } = "";
    public int SyncIntervalSeconds { get; set; } = 300;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    public static string ConfigPath =>
        Path.Combine(AppContext.BaseDirectory, "appsettings.json");

    public static AppSettings Load(string[] args)
    {
        var settings = new AppSettings();

        if (File.Exists(ConfigPath))
        {
            try
            {
                var json = File.ReadAllText(ConfigPath);
                var loaded = JsonSerializer.Deserialize<AppSettings>(json);
                if (loaded != null) settings = loaded;
            }
            catch { /* use defaults on parse error */ }
        }

        if (string.IsNullOrWhiteSpace(settings.SyncRootPath))
        {
            settings.SyncRootPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "MIKURA");
        }

        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--server": settings.ServerUrl = args[++i]; break;
                case "--token": settings.BearerToken = args[++i]; break;
                case "--sync-root": settings.SyncRootPath = args[++i]; break;
                case "--sync-interval": settings.SyncIntervalSeconds = int.Parse(args[++i]); break;
            }
        }

        return settings;
    }

    public void Save()
    {
        var json = JsonSerializer.Serialize(this, JsonOptions);
        File.WriteAllText(ConfigPath, json);
    }

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(ServerUrl) &&
        !string.IsNullOrWhiteSpace(BearerToken) &&
        !string.IsNullOrWhiteSpace(SyncRootPath);
}
