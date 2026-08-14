using System.Text.Json;

namespace Mikura.Core.Enrollment;

/// <summary>
/// admin から配られた「招待」。server URL と enrollment secret の組。
/// </summary>
/// <remarks>
/// ADR-034: 配布物は `mikura://enroll?u=..&amp;s=..` の 1 本の URI が正。
/// ただし旧来の init.json をテキストとして貼り付けられても同じ形に落とせる
/// ようにしてある — 経路を 2 本持つのではなく、入口を 1 つに畳むための措置。
/// </remarks>
public sealed record EnrollmentInvitation(
    string ServerUrl,
    string Secret,
    string? UserName)
{
    /// <summary>ADR-034 で固定した scheme + host 部。</summary>
    public const string UriScheme = "mikura";

    private const string EnrollHost = "enroll";

    /// <summary>
    /// 貼り付けられたテキストを招待として解釈する。
    /// `mikura://enroll?...` URI か、init.json の中身をそのまま貼ったものの
    /// どちらでも受け付ける。
    /// </summary>
    /// <param name="text">クリップボード等から得た生テキスト。</param>
    /// <param name="invitation">成功時のみ非 null。</param>
    /// <param name="error">失敗時のみ非 null。UI にそのまま出せる日本語。</param>
    public static bool TryParse(
        string? text,
        out EnrollmentInvitation? invitation,
        out string? error)
    {
        invitation = null;
        error = null;

        var trimmed = text?.Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            error = "招待リンクを貼り付けてください。";
            return false;
        }

        // init.json をそのまま貼った場合。'{' 始まりで判別できるので、
        // URI parse を試して失敗してから JSON を試す、という順序依存を避ける。
        if (trimmed[0] == '{')
        {
            return TryParseInitJson(trimmed, out invitation, out error);
        }

        return TryParseUri(trimmed, out invitation, out error);
    }

    private static bool TryParseUri(
        string text,
        out EnrollmentInvitation? invitation,
        out string? error)
    {
        invitation = null;
        error = null;

        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, UriScheme, StringComparison.OrdinalIgnoreCase))
        {
            error = $"招待リンクの形式が違います ({UriScheme}://{EnrollHost}?... で始まる必要があります)。";
            return false;
        }

        if (!string.Equals(uri.Host, EnrollHost, StringComparison.OrdinalIgnoreCase))
        {
            error = $"未対応の招待リンクです (mikura://{uri.Host})。";
            return false;
        }

        var query = ParseQuery(uri.Query);
        query.TryGetValue("u", out var serverUrl);
        query.TryGetValue("s", out var secret);

        if (string.IsNullOrWhiteSpace(serverUrl) || string.IsNullOrWhiteSpace(secret))
        {
            error = "招待リンクにサーバー URL またはシークレットが含まれていません。";
            return false;
        }

        if (!TryNormalizeServerUrl(serverUrl, out var normalized, out error))
        {
            return false;
        }

        // 未知のパラメータは黙って無視する。将来パラメータを足したときに、
        // 配布済みの古いクライアントが弾かないようにするため (ADR-034)。
        invitation = new EnrollmentInvitation(normalized!, secret, null);
        return true;
    }

    private static bool TryParseInitJson(
        string text,
        out EnrollmentInvitation? invitation,
        out string? error)
    {
        invitation = null;
        error = null;

        InitJson? init;
        try
        {
            init = JsonSerializer.Deserialize<InitJson>(text);
        }
        catch (JsonException)
        {
            error = "JSON として読み取れませんでした。";
            return false;
        }

        if (init is null ||
            string.IsNullOrWhiteSpace(init.ServerUrl) ||
            string.IsNullOrWhiteSpace(init.EnrollmentSecret))
        {
            error = "init.json に ServerUrl と EnrollmentSecret が必要です。";
            return false;
        }

        if (!TryNormalizeServerUrl(init.ServerUrl, out var normalized, out error))
        {
            return false;
        }

        invitation = new EnrollmentInvitation(
            normalized!, init.EnrollmentSecret, init.UserName);
        return true;
    }

    /// <summary>
    /// server URL を http/https に限定し、末尾 slash を落として正規化する。
    /// 末尾 slash を残すと `/enroll` を連結したときに二重 slash になる。
    /// </summary>
    /// <summary>
    /// サーバーが <c>MIKURA_PUBLIC_URL</c> 未設定時に host の位置へ置く差し込み語
    /// (ADR-034)。server 側の <c>HOST_PLACEHOLDER</c> と対でなければならない。
    /// </summary>
    private const string HostPlaceholder = "HOST";

    private static bool TryNormalizeServerUrl(
        string raw,
        out string? normalized,
        out string? error)
    {
        normalized = null;
        error = null;

        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            error = $"サーバー URL が http/https ではありません ({raw})。";
            return false;
        }

        // サーバー側が MIKURA_PUBLIC_URL 未設定のとき、host を差し込み語にした
        // 雛形を発行する (ADR-034)。置き換え忘れをここで止めないと、DNS 解決
        // 失敗という原因の分からないエラーになって利用者が詰まる。
        // DNS 名は大小文字を区別しないので、比較も区別しない (Uri.Host は
        // 小文字に正規化されるため Ordinal では素通りする)。副作用として
        // 実際に "host" という名前のマシンは直接指定できないが、その場合は
        // FQDN か IP を使えばよく、置き換え忘れを見逃す方が高くつく。
        if (string.Equals(uri.Host, HostPlaceholder, StringComparison.OrdinalIgnoreCase))
        {
            error =
                $"招待リンクの {HostPlaceholder} が実際のサーバー名のまま置き換えられていません。" +
                "発行した管理者に、置き換え済みのリンクを聞いてください。";
            return false;
        }

        normalized = uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        return true;
    }

    /// <summary>
    /// query string を decode する。<c>Uri.Query</c> は生のままなので自前で割る。
    /// WinForms 側で <c>System.Web</c> を引きたくないので最小実装。
    /// </summary>
    private static Dictionary<string, string> ParseQuery(string query)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (string.IsNullOrEmpty(query)) return result;

        foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var eq = pair.IndexOf('=');
            if (eq <= 0) continue;
            var key = Uri.UnescapeDataString(pair[..eq]);
            var value = Uri.UnescapeDataString(pair[(eq + 1)..]);
            // 同じキーが 2 度来たら先勝ち (後勝ちにすると、末尾に付け足すだけで
            // 前段の値を上書きできてしまう)。
            result.TryAdd(key, value);
        }
        return result;
    }

    /// <summary>`POST /enroll` の宛先。</summary>
    public string EnrollEndpoint => $"{ServerUrl}/enroll";

    private sealed record InitJson(
        string? ServerUrl,
        string? EnrollmentSecret,
        string? ExpiresAt,
        string? UserName);
}
