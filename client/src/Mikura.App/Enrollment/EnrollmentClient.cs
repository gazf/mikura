using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.Versioning;
using System.Text.Json.Serialization;
using Mikura.App.Config;
using Mikura.Core.Enrollment;
using Mikura.Core.Identity;

namespace Mikura.App.Enrollment;

/// <summary>
/// 招待 1 件を消費して profile を作る。`POST /enroll` → token を DPAPI 保存。
/// </summary>
/// <remarks>
/// ADR-034 で入口が「ファイル」から「貼り付けたテキスト」に変わったので、
/// enrollment の実処理を <see cref="EnrollmentScanner"/> から切り出した。
/// scanner は inits/ を舐めてここに渡すだけの薄い殻になり、UI からの
/// 単発 enrollment と同じコードを通る。
/// </remarks>
public sealed class EnrollmentClient
{
    private readonly ProfileStore _store;
    private readonly HttpClient _http;

    public EnrollmentClient(ProfileStore store, HttpClient http)
    {
        _store = store;
        _http = http;
    }

    /// <summary>
    /// 招待を消費して profile を保存する。作成した profile を返す。
    /// </summary>
    /// <param name="invitation">解釈済みの招待。</param>
    /// <param name="mountLetter">
    /// 割り当てるドライブレター (例 <c>"Z:"</c>)。null なら空きレターを自動選択。
    /// admin ではなく user が決める情報なので、招待には含まれない。
    /// </param>
    [SupportedOSPlatform("windows")]
    public async Task<Profile> EnrollAsync(
        EnrollmentInvitation invitation,
        string? mountLetter = null,
        CancellationToken ct = default)
    {
        var deviceId = DeviceIdProvider.Compute();

        var request = new HttpRequestMessage(HttpMethod.Post, invitation.EnrollEndpoint)
        {
            Content = JsonContent.Create(new EnrollRequest(invitation.Secret, deviceId)),
        };

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException(
                await DescribeFailureAsync(response, ct).ConfigureAwait(false));
        }

        var payload = await response.Content
            .ReadFromJsonAsync<EnrollResponse>(ct).ConfigureAwait(false)
            ?? throw new InvalidDataException("サーバーの応答を解釈できませんでした。");
        if (string.IsNullOrEmpty(payload.BearerToken))
        {
            throw new InvalidDataException("サーバーの応答にトークンが含まれていません。");
        }

        var name = AllocateProfileName(invitation.UserName ?? payload.UserName);
        var profile = new Profile(
            Name: name,
            ServerUrl: invitation.ServerUrl,
            // 既存 profile が確保しているレターを必ず除外する。ここを渡さないと、
            // inits/*.init.json を 2 つ投入した時 (= headless で複数ホストを
            // 一括登録する経路) に、まだどちらもマウントされていないので
            // OS からは両方空きに見え、同じレターが 2 回割り当てられる。
            MountLetter: mountLetter ?? DriveLetters.PickFree(
                _store.LoadProfiles().Select(p => p.MountLetter)),
            EnrolledAt: DateTime.UtcNow);

        _store.SaveProfile(profile);
        _store.SaveSecret(name, payload.BearerToken);

        System.Diagnostics.Trace.WriteLine(
            $"[Enrollment] success: profile={name} mount={profile.MountLetter}");
        return profile;
    }

    /// <summary>
    /// 失敗レスポンスを、user がそのまま読める一文にする。
    /// </summary>
    /// <remarks>
    /// 従来は status code と生 body をそのまま投げていたが、user から見て
    /// 「招待が期限切れなのか」「サーバーが落ちているのか」が判らなかった。
    /// 410 は enrollment 固有の意味 (無効 / 消費済み) を持つので個別に訳す。
    /// </remarks>
    private static async Task<string> DescribeFailureAsync(
        HttpResponseMessage response,
        CancellationToken ct)
    {
        var status = (int)response.StatusCode;
        var hint = status switch
        {
            410 => "この招待は既に使用済みか、有効期限が切れています。管理者に再発行を依頼してください。",
            401 or 403 => "サーバーに拒否されました。招待リンクが正しいか確認してください。",
            404 => "サーバー URL が違うか、mikura サーバーではありません。",
            >= 500 => "サーバー側でエラーが発生しました。",
            _ => "登録に失敗しました。",
        };

        string body;
        try
        {
            body = (await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false)).Trim();
        }
        catch
        {
            body = string.Empty;
        }

        return body.Length == 0 ? $"{hint} (HTTP {status})" : $"{hint} (HTTP {status}: {body})";
    }

    /// <summary>
    /// profile 名を決める。同名があれば suffix で衝突回避 (alice → alice-2)。
    /// </summary>
    private string AllocateProfileName(string? preferred)
    {
        var baseName = SanitizeName(preferred ?? "profile");
        var name = baseName;
        var suffix = 2;
        while (_store.Exists(name))
        {
            name = $"{baseName}-{suffix++}";
            if (suffix > 100)
            {
                throw new InvalidOperationException(
                    "同名のプロファイルが多すぎます。使っていないものを削除してください。");
            }
        }
        return name;
    }

    private static string SanitizeName(string raw)
    {
        var chars = raw.Where(ch =>
            (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
            (ch >= '0' && ch <= '9') || ch == '_' || ch == '-').ToArray();
        var s = new string(chars);
        return string.IsNullOrEmpty(s) ? "profile" : s[..Math.Min(s.Length, 32)];
    }

    private sealed record EnrollRequest(
        [property: JsonPropertyName("secret")] string Secret,
        [property: JsonPropertyName("deviceId")] string DeviceId);

    private sealed record EnrollResponse(
        [property: JsonPropertyName("bearerToken")] string BearerToken,
        [property: JsonPropertyName("userId")] int UserId,
        [property: JsonPropertyName("userName")] string? UserName);
}
