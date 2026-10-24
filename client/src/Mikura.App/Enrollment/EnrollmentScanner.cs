using System.Net.Http;
using System.Runtime.Versioning;
using Mikura.App.Config;
using Mikura.Core.Enrollment;

namespace Mikura.App.Enrollment;

/// <summary>
/// <c>&lt;exe-dir&gt;/inits/*.init.json</c> を scan して、未消費の enrollment
/// secret を server に登録する。成功したら init.json を削除、失敗したら
/// <c>inits/failed/</c> に move + Trace log。
/// </summary>
/// <remarks>
/// <para>ADR-034 で対話的な入口は貼り付け方式 (<c>AddProfileForm</c>) に移った。
/// この scanner は **ヘッドレス / 大量展開用** として残る — 多数の端末に配る
/// ときに、ファイルを置くだけで設定が済む経路には依然として価値がある。</para>
///
/// <para>enrollment の実処理は <see cref="EnrollmentClient"/> に委譲する。
/// UI 経路と同じコードを通るので、片方だけ挙動がずれることがない。</para>
///
/// <para>admin が配布する init.json の shape (= <c>deno task admin issue-init
/// --out</c> の出力):</para>
/// <code>
/// {
///   "ServerUrl": "https://server.example.com:8700",
///   "EnrollmentSecret": "abc-...uuid",
///   "ExpiresAt": "...",
///   "UserName": "alice"
/// }
/// </code>
/// <para>MountLetter は init.json には**含めない** (= drive letter は user 側が
/// 選ぶ情報。admin が固定すると共有 PC で衝突する)。空きレターを自動選択する。</para>
/// </remarks>
public sealed class EnrollmentScanner
{
    private readonly EnrollmentClient _client;
    private readonly string _initsDir;
    private readonly string _failedDir;

    public EnrollmentScanner(
        ProfileStore store,
        HttpClient http,
        string? initsDir = null)
    {
        _client = new EnrollmentClient(store, http);
        _initsDir = initsDir ?? Path.Combine(AppContext.BaseDirectory, "inits");
        _failedDir = Path.Combine(_initsDir, "failed");
    }

    public string InitsDir => _initsDir;

    /// <summary>
    /// inits/ 配下の *.init.json を全て処理する。新規 profile 数を返す。
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
                if (await TryEnrollOneAsync(path, ct).ConfigureAwait(false))
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
        var json = await File.ReadAllTextAsync(initPath, ct).ConfigureAwait(false);
        if (!EnrollmentInvitation.TryParse(json, out var invitation, out var error))
        {
            throw new InvalidDataException(error ?? "init.json を解釈できませんでした。");
        }

        await _client.EnrollAsync(invitation!, mountLetter: null, ct).ConfigureAwait(false);

        // secret は consume 済みで再利用不可なので、痕跡を残さず消す。
        File.Delete(initPath);
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
}
