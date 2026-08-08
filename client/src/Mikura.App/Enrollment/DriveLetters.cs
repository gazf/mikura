using System.Runtime.Versioning;

namespace Mikura.App.Enrollment;

/// <summary>
/// マウント先ドライブレターの選定。
/// </summary>
/// <remarks>
/// 従来は新規 profile を必ず <c>Z:</c> にしていたが、2 つ目の profile を
/// 追加した瞬間に衝突する。ドライブレターは admin ではなく user 側が持つ
/// 情報なので招待には含まれず (ADR-034)、クライアントが決める。
/// </remarks>
public static class DriveLetters
{
    /// <summary>候補レター。Z: から降順に見る (慣習的にネットワークドライブは後ろ)。</summary>
    private const string Candidates = "ZYXWVUTSRQPONMLKJIHGFED";

    /// <summary>
    /// 現在使われていないドライブレターを列挙する (例 <c>"Z:"</c>)。
    /// </summary>
    /// <param name="alsoReserved">
    /// OS 的には空いているが、既存 profile が使う予定のレター。
    /// UI では「未マウントの profile が確保しているレター」を除きたい。
    /// </param>
    [SupportedOSPlatform("windows")]
    public static IReadOnlyList<string> ListFree(IEnumerable<string>? alsoReserved = null)
    {
        var taken = new HashSet<char>(
            DriveInfo.GetDrives()
                .Select(d => char.ToUpperInvariant(d.Name[0])));

        if (alsoReserved is not null)
        {
            foreach (var letter in alsoReserved)
            {
                if (!string.IsNullOrEmpty(letter))
                {
                    taken.Add(char.ToUpperInvariant(letter[0]));
                }
            }
        }

        return Candidates
            .Where(ch => !taken.Contains(ch))
            .Select(ch => $"{ch}:")
            .ToArray();
    }

    /// <summary>
    /// 空きレターを 1 つ選ぶ。全て埋まっていれば <c>"Z:"</c> にフォールバックする
    /// (マウント時にエラーとして表面化させる — ここで例外を投げると enrollment
    /// 自体が失敗し、消費済みの招待だけが失われる)。
    /// </summary>
    [SupportedOSPlatform("windows")]
    public static string PickFree(IEnumerable<string>? alsoReserved = null)
    {
        var free = ListFree(alsoReserved);
        return free.Count > 0 ? free[0] : "Z:";
    }
}
