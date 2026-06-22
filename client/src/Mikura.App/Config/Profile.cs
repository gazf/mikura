using System.Text.Json.Serialization;

namespace Mikura.App.Config;

/// <summary>
/// 1 つの mikura 接続 profile を表す。各 profile は独立した endpoint (server) と
/// drive letter を持ち、ProfileSession 単位で並列に mount される。
/// </summary>
/// <remarks>
/// File 上では `<exe-dir>/profiles/<Name>/profile.json` に plaintext で保存。
/// Bearer token は併存する `secret.bin` (DPAPI 暗号化) 側にあり、本 record には
/// 含まれない。
/// </remarks>
public sealed record Profile(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("serverUrl")] string ServerUrl,
    [property: JsonPropertyName("mountLetter")] string MountLetter,
    [property: JsonPropertyName("enrolledAt")] DateTime EnrolledAt);
