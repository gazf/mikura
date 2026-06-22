using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using Mikura.App.Config;
using Mikura.Core.Identity;

namespace Mikura.App.Enrollment;

/// <summary>
/// `<exe-dir>/inits/*.init.json` を scan して、未消費の enrollment secret を
/// server に POST /enroll する。成功したら profile を生成 + token を secret.bin
/// に保存 + init.json を削除。失敗したら `inits/failed/` に move + Trace log。
/// </summary>
/// <remarks>
/// admin が user に配布する init.json の典型 shape (= server の `deno task admin
/// issue-init --out` 出力):
/// <code>
/// {
///   "ServerUrl": "https://server.example.com:8700",
///   "EnrollmentSecret": "abc-...uuid",
///   "ExpiresAt": "...",
///   "UserName": "alice"
/// }
/// </code>
/// MountLetter は init.json には**含めない**設計 (= drive letter は user 側で
/// 選ぶべき情報、admin が決めて固定するのは windows-shared PC で衝突する)。
/// 現状は固定 letter (Z:) を入れて、Phase D の UI で対話的に変更させる。
/// </remarks>
public sealed class EnrollmentScanner
{
    private readonly ProfileStore _store;
    private readonly HttpClient _http;
    private readonly string _initsDir;
    private readonly string _failedDir;

    public EnrollmentScanner(
        ProfileStore store,
        HttpClient http,
        string? initsDir = null)
    {
        _store = store;
        _http = http;
        _initsDir = initsDir ?? Path.Combine(AppContext.BaseDirectory, "inits");
        _failedDir = Path.Combine(_initsDir, "failed");
    }

    public string InitsDir => _initsDir;

    /// <summary>
    /// inits/ 配下の *.init.json を全て処理する。新規 profile 数を返す。
    /// Linux test 等で Windows API を呼びたくない場合は `dryRun=true`。
    /// </summary>
    [SupportedOSPlatform("windows")]
    public async Task<int> ScanAndEnrollAsync(CancellationToken ct = default)
    {
        if (!Directory.Exists(_initsDir)) return 0;
        int created = 0;
        foreach (var path in Directory.GetFiles(_initsDir, "*.init.json"))
        {
            if (ct.IsCancellationRequested) break;
            try
            {
                if (await TryEnrollOneAsync(path, ct))
                {
                    created++;
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine(
                    $"[Enrollment] failed {Path.GetFileName(path)}: {ex.GetType().Name}: {ex.Message}");
                MoveToFailed(path);
            }
        }
        return created;
    }

    [SupportedOSPlatform("windows")]
    private async Task<bool> TryEnrollOneAsync(string initPath, CancellationToken ct)
    {
        var json = await File.ReadAllTextAsync(initPath, ct);
        var init = JsonSerializer.Deserialize<InitFile>(json) ??
            throw new InvalidDataException("init.json parse returned null");
        if (string.IsNullOrWhiteSpace(init.ServerUrl) ||
            string.IsNullOrWhiteSpace(init.EnrollmentSecret))
        {
            throw new InvalidDataException(
                "init.json must contain ServerUrl and EnrollmentSecret");
        }

        var deviceId = DeviceIdProvider.Compute();

        // Server に POST /enroll
        var enrollUrl = init.ServerUrl.TrimEnd('/') + "/enroll";
        var req = new HttpRequestMessage(HttpMethod.Post, enrollUrl)
        {
            Content = JsonContent.Create(new EnrollRequest(
                init.EnrollmentSecret, deviceId)),
        };
        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            throw new InvalidOperationException(
                $"POST /enroll failed: {(int)res.StatusCode} {body}");
        }
        var payload = await res.Content.ReadFromJsonAsync<EnrollResponse>(ct) ??
            throw new InvalidDataException("enroll response parse returned null");
        if (string.IsNullOrEmpty(payload.BearerToken))
        {
            throw new InvalidDataException("enroll response missing bearerToken");
        }

        // Profile 名 = userName 優先、無ければ "default" の連番。同名 profile が
        // 既にあれば suffix で衝突回避 (例 alice → alice-2)。
        var baseName = SanitizeName(init.UserName ?? payload.UserName ?? "profile");
        var name = baseName;
        var suffix = 2;
        while (_store.Exists(name))
        {
            name = $"{baseName}-{suffix++}";
            if (suffix > 100)
            {
                throw new InvalidOperationException(
                    "too many profiles with similar name; remove unused ones first");
            }
        }

        // MountLetter は admin が指定しない設計 (= user 側で選ぶ)。default は Z:。
        // Phase D で UI から対話的に変更可能にする。
        var profile = new Profile(
            Name: name,
            ServerUrl: init.ServerUrl,
            MountLetter: "Z:",
            EnrolledAt: DateTime.UtcNow);

        _store.SaveProfile(profile);
        _store.SaveSecret(name, payload.BearerToken);

        // Init file を消す (= secret は consume 済み、再利用不可なので痕跡を残さない)
        File.Delete(initPath);

        System.Diagnostics.Trace.WriteLine(
            $"[Enrollment] success: profile={name} serverUrl={init.ServerUrl}");
        return true;
    }

    private void MoveToFailed(string path)
    {
        try
        {
            Directory.CreateDirectory(_failedDir);
            var dest = Path.Combine(_failedDir, Path.GetFileName(path));
            File.Move(path, dest, overwrite: true);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.WriteLine(
                $"[Enrollment] could not move to failed dir: {ex.Message}");
        }
    }

    private static string SanitizeName(string raw)
    {
        var chars = raw.Where(ch =>
            (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
            (ch >= '0' && ch <= '9') || ch == '_' || ch == '-').ToArray();
        var s = new string(chars);
        return string.IsNullOrEmpty(s) ? "profile" : s[..Math.Min(s.Length, 32)];
    }

    private sealed record InitFile(
        [property: JsonPropertyName("ServerUrl")] string ServerUrl,
        [property: JsonPropertyName("EnrollmentSecret")] string EnrollmentSecret,
        [property: JsonPropertyName("ExpiresAt")] string? ExpiresAt,
        [property: JsonPropertyName("UserName")] string? UserName);

    private sealed record EnrollRequest(
        [property: JsonPropertyName("secret")] string Secret,
        [property: JsonPropertyName("deviceId")] string DeviceId);

    private sealed record EnrollResponse(
        [property: JsonPropertyName("bearerToken")] string BearerToken,
        [property: JsonPropertyName("userId")] int UserId,
        [property: JsonPropertyName("userName")] string? UserName);
}
