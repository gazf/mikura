using System.Text.Json;

namespace Mikura.App.Config;

public class AppSettings
{
    public string ServerUrl { get; set; } = "http://localhost:8700";
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
