using System.Text.Json;
using System.Text.Json.Serialization;

namespace Mikura.Core.Identity;

/// <summary>
/// ADR-018 の Device ID を取得・永続化するプロバイダ。
/// 実行ファイルと同ディレクトリの device.json に保存し、ID は「インストール単位」で
/// 不変。再起動・再ログインでも同じ ID を返す。
/// </summary>
public static class DeviceIdProvider
{
    private const string FileName = "device.json";

    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public static string GetOrCreate()
    {
        var path = Path.Combine(AppContext.BaseDirectory, FileName);

        if (File.Exists(path))
        {
            try
            {
                var json = File.ReadAllText(path);
                var existing = JsonSerializer.Deserialize<DeviceFile>(json);
                if (existing is not null && !string.IsNullOrWhiteSpace(existing.DeviceId))
                    return existing.DeviceId;
            }
            catch
            {
                // 壊れた device.json は再生成する。
            }
        }

        var id = Guid.NewGuid().ToString();
        var file = new DeviceFile(id, DateTime.UtcNow);
        File.WriteAllText(path, JsonSerializer.Serialize(file, JsonOptions));
        return id;
    }

    private sealed record DeviceFile(
        [property: JsonPropertyName("deviceId")] string DeviceId,
        [property: JsonPropertyName("createdAt")] DateTime CreatedAt);
}
