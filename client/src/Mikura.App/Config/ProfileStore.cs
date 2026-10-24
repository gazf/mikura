using System.Runtime.Versioning;
using System.Text.Json;
using Mikura.Core.Crypto;

namespace Mikura.App.Config;

/// <summary>
/// `<exe-dir>/profiles/<name>/` 配下の profile 群を読み書きする store。
/// 1 profile = 1 dir、含むのは <c>profile.json</c> (plaintext metadata) と
/// <c>secret.bin</c> (DPAPI 暗号化 token)。
/// </summary>
/// <remarks>
/// <para>本 store は **ファイル I/O だけ**を司り、profile の lifecycle 管理
/// (mount/unmount、HTTP client 構築) は <c>ProfileManager</c> (Phase C で追加) の
/// 責務。本クラスは pure な永続化レイヤ。</para>
///
/// <para>DPAPI 経路は Windows-only。non-Windows での `LoadSecret` / `SaveSecret` は
/// PlatformNotSupportedException を投げる。`LoadProfiles` / `SaveProfile` の
/// メタデータ部分は cross-platform で動く (テスト用)。</para>
/// </remarks>
public sealed class ProfileStore
{
    private readonly string _root;

    public ProfileStore(string? root = null)
    {
        _root = root ?? Path.Combine(AppContext.BaseDirectory, "profiles");
    }

    public string RootPath => _root;

    /// <summary>
    /// `profiles/` 配下の全 profile を読む。dir が存在しない (= 初回起動 / 未 enroll)
    /// なら空 list。`profile.json` が parse 失敗した dir は skip + Trace log。
    /// </summary>
    public IReadOnlyList<Profile> LoadProfiles()
    {
        var result = new List<Profile>();
        if (!Directory.Exists(_root)) return result;

        foreach (var dir in Directory.GetDirectories(_root))
        {
            var jsonPath = Path.Combine(dir, "profile.json");
            if (!File.Exists(jsonPath)) continue;
            try
            {
                var json = File.ReadAllText(jsonPath);
                var p = JsonSerializer.Deserialize<Profile>(json);
                if (p is not null && !string.IsNullOrWhiteSpace(p.Name))
                {
                    result.Add(p);
                }
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine(
                    $"[ProfileStore] skip {jsonPath}: {ex.GetType().Name}: {ex.Message}");
            }
        }
        return result;
    }

    /// <summary>
    /// 指定 profile を `profile.json` に保存。dir は無ければ作る。
    /// 既存 profile を上書きする場合は呼び出し側で意図的に上書きする (= 衝突
    /// validation は ProfileManager で実施)。
    /// </summary>
    public void SaveProfile(Profile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ValidateName(profile.Name);
        var dir = ProfileDir(profile.Name);
        Directory.CreateDirectory(dir);
        var jsonPath = Path.Combine(dir, "profile.json");
        var json = JsonSerializer.Serialize(profile, new JsonSerializerOptions
        {
            WriteIndented = true,
        });
        File.WriteAllText(jsonPath, json);
    }

    /// <summary>
    /// 指定 profile の token を DPAPI で復号して返す。`secret.bin` が無ければ null。
    /// </summary>
    [SupportedOSPlatform("windows")]
    public string? LoadSecret(string profileName)
    {
        ValidateName(profileName);
        var secretPath = SecretPath(profileName);
        if (!File.Exists(secretPath)) return null;
        var cipher = File.ReadAllBytes(secretPath);
        if (cipher.Length == 0) return null;
        var plain = DataProtection.Unprotect(cipher);
        return System.Text.Encoding.UTF8.GetString(plain);
    }

    /// <summary>
    /// 指定 profile の token を DPAPI で暗号化して `secret.bin` に保存。
    /// dir は無ければ作る (= SaveProfile より先に呼ばれても安全)。
    /// </summary>
    [SupportedOSPlatform("windows")]
    public void SaveSecret(string profileName, string token)
    {
        ValidateName(profileName);
        if (string.IsNullOrEmpty(token))
            throw new ArgumentException("token must not be empty", nameof(token));
        var dir = ProfileDir(profileName);
        Directory.CreateDirectory(dir);
        var cipher = DataProtection.Protect(System.Text.Encoding.UTF8.GetBytes(token));
        File.WriteAllBytes(SecretPath(profileName), cipher);
    }

    /// <summary>
    /// 指定 profile dir をまるごと削除 (profile.json + secret.bin 共に消える)。
    /// </summary>
    public void RemoveProfile(string profileName)
    {
        ValidateName(profileName);
        var dir = ProfileDir(profileName);
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }

    /// <summary>指定 name の profile が存在するか。</summary>
    public bool Exists(string profileName)
    {
        if (string.IsNullOrWhiteSpace(profileName)) return false;
        return File.Exists(Path.Combine(ProfileDir(profileName), "profile.json"));
    }

    private string ProfileDir(string name) => Path.Combine(_root, name);
    private string SecretPath(string name) =>
        Path.Combine(ProfileDir(name), "secret.bin");

    /// <summary>
    /// profile 名の validation: file system safe な ASCII subset のみ許可。
    /// dir 名としてそのまま使うので、`..` / slash / null byte / 制御文字を弾く。
    /// </summary>
    private static void ValidateName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            throw new ArgumentException("profile name must not be empty", nameof(name));
        if (name.Length > 64)
            throw new ArgumentException("profile name must be 1-64 chars", nameof(name));
        foreach (var ch in name)
        {
            // 許可: A-Z a-z 0-9 _ - (= dir name として安全)
            var ok = (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') ||
                (ch >= '0' && ch <= '9') || ch == '_' || ch == '-';
            if (!ok)
            {
                throw new ArgumentException(
                    $"profile name contains invalid char: '{ch}' (allowed: A-Z a-z 0-9 _ -)",
                    nameof(name));
            }
        }
    }
}
