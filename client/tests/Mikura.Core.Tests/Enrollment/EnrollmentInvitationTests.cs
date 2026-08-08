using Mikura.Core.Enrollment;
using Xunit;

namespace Mikura.Core.Tests.Enrollment;

/// <summary>
/// EnrollmentInvitation の責務 (ADR-034):
///   - mikura:// URI と init.json テキストのどちらを貼られても同じ形に落とす
///   - サーバー URL を正規化し、http/https 以外は受け付けない
///   - 未知のパラメータは無視する (配布済みリンクを将来の追加で壊さない)
///   - 失敗時は UI にそのまま出せる理由を返す (黙って null にしない)
/// </summary>
public class EnrollmentInvitationTests
{
    private const string Secret = "11111111-2222-3333-4444-555555555555";

    [Fact]
    public void TryParse_MikuraUri_ServerUrlAndSecretを取り出す()
    {
        var text =
            $"mikura://enroll?u=https%3A%2F%2Ffiles.example.com%3A8700&s={Secret}";

        var ok = EnrollmentInvitation.TryParse(text, out var invitation, out var error);

        Assert.True(ok);
        Assert.Null(error);
        Assert.Equal("https://files.example.com:8700", invitation!.ServerUrl);
        Assert.Equal(Secret, invitation.Secret);
    }

    [Fact]
    public void TryParse_前後の空白は無視される()
    {
        var text =
            $"  \r\n mikura://enroll?u=https%3A%2F%2Ffiles.example.com&s={Secret}  \n";

        var ok = EnrollmentInvitation.TryParse(text, out var invitation, out _);

        Assert.True(ok);
        Assert.Equal("https://files.example.com", invitation!.ServerUrl);
    }

    [Fact]
    public void TryParse_未知のパラメータは無視される()
    {
        // 将来 server が新パラメータを足しても、配布済みリンクが壊れないこと
        var text =
            $"mikura://enroll?u=https%3A%2F%2Ffiles.example.com&s={Secret}&v=2&note=hello";

        var ok = EnrollmentInvitation.TryParse(text, out var invitation, out _);

        Assert.True(ok);
        Assert.Equal(Secret, invitation!.Secret);
    }

    [Fact]
    public void TryParse_同じキーが重複したら先勝ち()
    {
        // 末尾に付け足すだけで前段の値を差し替えられないこと
        var text =
            $"mikura://enroll?u=https%3A%2F%2Freal.example.com&s={Secret}" +
            "&u=https%3A%2F%2Fattacker.example.com";

        var ok = EnrollmentInvitation.TryParse(text, out var invitation, out _);

        Assert.True(ok);
        Assert.Equal("https://real.example.com", invitation!.ServerUrl);
    }

    [Fact]
    public void TryParse_末尾slashは落とされる()
    {
        var text =
            $"mikura://enroll?u=https%3A%2F%2Ffiles.example.com%3A8700%2F&s={Secret}";

        EnrollmentInvitation.TryParse(text, out var invitation, out _);

        Assert.Equal("https://files.example.com:8700", invitation!.ServerUrl);
        Assert.Equal("https://files.example.com:8700/enroll", invitation.EnrollEndpoint);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public void TryParse_空文字は理由付きで失敗する(string? text)
    {
        var ok = EnrollmentInvitation.TryParse(text, out var invitation, out var error);

        Assert.False(ok);
        Assert.Null(invitation);
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void TryParse_別schemeは拒否される()
    {
        var ok = EnrollmentInvitation.TryParse(
            $"https://files.example.com/enroll?s={Secret}", out var invitation, out var error);

        Assert.False(ok);
        Assert.Null(invitation);
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void TryParse_未対応のhost部は拒否される()
    {
        var ok = EnrollmentInvitation.TryParse(
            $"mikura://something?u=https%3A%2F%2Fa.example.com&s={Secret}",
            out _, out var error);

        Assert.False(ok);
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void TryParse_secretが無ければ失敗する()
    {
        var ok = EnrollmentInvitation.TryParse(
            "mikura://enroll?u=https%3A%2F%2Fa.example.com", out _, out var error);

        Assert.False(ok);
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void TryParse_serverUrlがhttp以外なら拒否される()
    {
        var ok = EnrollmentInvitation.TryParse(
            $"mikura://enroll?u=file%3A%2F%2F%2Fetc%2Fpasswd&s={Secret}",
            out _, out var error);

        Assert.False(ok);
        Assert.False(string.IsNullOrEmpty(error));
    }

    // ---- init.json 互換経路 ----

    [Fact]
    public void TryParse_initJsonテキストも受け付ける()
    {
        var json = $$"""
        {
          "ServerUrl": "https://files.example.com:8700",
          "EnrollmentSecret": "{{Secret}}",
          "ExpiresAt": "2026-01-01T00:00:00Z",
          "UserName": "alice"
        }
        """;

        var ok = EnrollmentInvitation.TryParse(json, out var invitation, out var error);

        Assert.True(ok);
        Assert.Null(error);
        Assert.Equal("https://files.example.com:8700", invitation!.ServerUrl);
        Assert.Equal(Secret, invitation.Secret);
        Assert.Equal("alice", invitation.UserName);
    }

    [Fact]
    public void TryParse_壊れたJSONは理由付きで失敗する()
    {
        var ok = EnrollmentInvitation.TryParse("{ not json", out _, out var error);

        Assert.False(ok);
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void TryParse_必須項目を欠いたinitJsonは失敗する()
    {
        var ok = EnrollmentInvitation.TryParse(
            """{ "ServerUrl": "https://files.example.com" }""", out _, out var error);

        Assert.False(ok);
        Assert.False(string.IsNullOrEmpty(error));
    }
}
