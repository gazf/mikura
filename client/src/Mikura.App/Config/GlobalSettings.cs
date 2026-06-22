using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mikura.App.Config;

/// <summary>
/// account 非依存の global preferences。`<exe-dir>/settings.json` に保存。
/// </summary>
/// <remarks>
/// 個別 profile に紐付くもの (ServerUrl, MountLetter, Token) は
/// <see cref="Profile"/> / <c>secret.bin</c> 側に置き、こちらは「全 profile に
/// 共通する設定」のみ持つ。
/// </remarks>
public sealed class GlobalSettings
{
    [JsonPropertyName("syncIntervalSeconds")]
    public int SyncIntervalSeconds { get; set; } = 300;

    /// <summary>
    /// 「現在 active な profile 名」を必要とするモード (= 単一 mount 切替式 UI) で
    /// 使う想定。多重 mount mode では参照されない。Phase D で profile 切替 UI を
    /// 入れる時のために field だけ用意しておく。
    /// </summary>
    [JsonPropertyName("activeProfile")]
    public string? ActiveProfile { get; set; }

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    public static string ConfigPath =>
        Path.Combine(AppContext.BaseDirectory, "settings.json");

    public static GlobalSettings Load()
    {
        if (!File.Exists(ConfigPath)) return new GlobalSettings();
        try
        {
            var json = File.ReadAllText(ConfigPath);
            return JsonSerializer.Deserialize<GlobalSettings>(json) ?? new GlobalSettings();
        }
        catch
        {
            // parse error は無視して default で続行 (= UI から再保存で復旧可能)。
            return new GlobalSettings();
        }
    }

    public void Save()
    {
        File.WriteAllText(ConfigPath, JsonSerializer.Serialize(this, JsonOptions));
    }
}
