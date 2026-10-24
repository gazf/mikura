using Mikura.Core.Enrollment;
using Xunit;

namespace Mikura.Core.Tests.Enrollment;

/// <summary>
/// <para>DriveLetters の責務: 「使用中のレターを除いた候補を、決まった優先順で返す」。</para>
///
/// <para>mikura は 1 クライアントが複数ホストへ同時接続する構成なので、profile が
/// 増えるほどレターの衝突が起きやすい。とくに **未マウントの profile が確保して
/// いるレター** は OS からは空きに見えるため、呼び出し側が予約集合として渡す
/// 必要がある。ここではその除外が効くことを主張する。</para>
///
/// <para>OS 問い合わせを含む <c>ListFree</c> / <c>PickFree</c> は Windows 依存なので、
/// 純関数の <c>SelectFree</c> に対して検証する。</para>
/// </summary>
public class DriveLettersTests
{
    [Fact]
    public void SelectFree_使用中を除いた候補をZから降順に返す()
    {
        var free = DriveLetters.SelectFree(["C:"]);

        Assert.Equal("Z:", free[0]);
        Assert.Equal("Y:", free[1]);
        Assert.DoesNotContain("C:", free);
    }

    [Fact]
    public void SelectFree_予約済みのレターを候補から外す()
    {
        // profile #1 が Z: を確保している状況。まだマウントされていなくても
        // 次の profile に Z: を渡してはいけない。
        var free = DriveLetters.SelectFree(["C:", "Z:"]);

        Assert.Equal("Y:", free[0]);
        Assert.DoesNotContain("Z:", free);
    }

    [Theory]
    [InlineData("Z:")]
    [InlineData(@"Z:\")]
    [InlineData("z")]
    [InlineData("z:")]
    public void SelectFree_レターの表記ゆれを先頭1文字で畳む(string taken)
    {
        // DriveInfo.Name は "Z:\"、profile.MountLetter は "Z:" と形が違う。
        // どちらで来ても同じレターとして扱えないと予約が漏れる。
        var free = DriveLetters.SelectFree([taken]);

        Assert.DoesNotContain("Z:", free);
    }

    [Fact]
    public void SelectFree_空文字は無視する()
    {
        // MountLetter が未設定の profile が混ざっても、候補を削らない。
        var free = DriveLetters.SelectFree(["", "C:"]);

        Assert.Equal("Z:", free[0]);
    }

    [Fact]
    public void SelectFree_全て埋まっていれば空を返す()
    {
        var all = Enumerable.Range('A', 26).Select(c => $"{(char)c}:");

        Assert.Empty(DriveLetters.SelectFree(all));
    }

    [Fact]
    public void SelectFree_候補はA_B_Cを含まない()
    {
        // A/B はフロッピー、C はシステムドライブ。空いていても割り当てない。
        var free = DriveLetters.SelectFree([]);

        Assert.DoesNotContain("A:", free);
        Assert.DoesNotContain("B:", free);
        Assert.DoesNotContain("C:", free);
    }

    [Fact]
    public void SelectFree_複数プロファイルの予約を積み上げても衝突しない()
    {
        // 「3 ホストへ順に接続していく」ときの実際の使われ方。
        var reserved = new List<string> { "C:" };
        var assigned = new List<string>();

        for (var i = 0; i < 3; i++)
        {
            var letter = DriveLetters.SelectFree(reserved)[0];
            assigned.Add(letter);
            reserved.Add(letter);
        }

        Assert.Equal(["Z:", "Y:", "X:"], assigned);
        Assert.Equal(assigned.Count, assigned.Distinct().Count());
    }
}
