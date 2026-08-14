using System.Runtime.Versioning;

namespace Mikura.Core.Enrollment;

/// <summary>
/// マウント先ドライブレターの選定。
/// </summary>
/// <remarks>
/// <para>従来は新規 profile を必ず <c>Z:</c> にしていたが、2 つ目の profile を
/// 追加した瞬間に衝突する。ドライブレターは admin ではなく user 側が持つ
/// 情報なので招待には含まれず (ADR-034)、クライアントが決める。</para>
///
/// <para>OS への問い合わせ (<see cref="ListFree"/>) と選定そのもの
/// (<see cref="SelectFree"/>) を分けてある。前者は Windows 依存だが、後者は
/// 「使用中の集合を引いた残り」を返すだけの純関数で、mikura が複数ホストへ
/// 同時接続する構成ではここが唯一の衝突点になる。</para>
/// </remarks>
public static class DriveLetters
{
    /// <summary>候補レター。Z: から降順に見る (慣習的にネットワークドライブは後ろ)。</summary>
    private const string Candidates = "ZYXWVUTSRQPONMLKJIHGFED";

    /// <summary>
    /// 使用中のレターを除いた候補を返す。純関数。
    /// </summary>
    /// <param name="taken">
    /// 使用中のレター。<c>"Z:"</c> <c>"Z:\"</c> <c>"z"</c> のいずれの形でもよく、
    /// 先頭 1 文字だけを見て大文字に畳む。
    /// </param>
    public static IReadOnlyList<string> SelectFree(IEnumerable<string> taken)
    {
        var used = new HashSet<char>();
        foreach (var entry in taken)
        {
            if (!string.IsNullOrEmpty(entry))
            {
                used.Add(char.ToUpperInvariant(entry[0]));
            }
        }

        return Candidates
            .Where(ch => !used.Contains(ch))
            .Select(ch => $"{ch}:")
            .ToArray();
    }

    /// <summary>
    /// 現在使われていないドライブレターを列挙する (例 <c>"Z:"</c>)。
    /// </summary>
    /// <param name="alsoReserved">
    /// OS 的には空いているが、既存 profile が使う予定のレター。**必ず渡すこと** —
    /// 未マウントの profile (停止中 / 起動失敗 / 追加直後でまだマウント前) が
    /// 確保しているレターは OS からは見えないので、渡さないと二重に割り当てる。
    /// </param>
    [SupportedOSPlatform("windows")]
    public static IReadOnlyList<string> ListFree(IEnumerable<string>? alsoReserved = null)
    {
        var taken = DriveInfo.GetDrives().Select(d => d.Name);
        if (alsoReserved is not null) taken = taken.Concat(alsoReserved);
        return SelectFree(taken);
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
