using WinFsp.Native.Native;

namespace WinFsp.Native;

/// <summary>
/// IFileSystem 実装が GetSecurityByName / GetSecurity callback で返す
/// self-relative SECURITY_DESCRIPTOR を生成するためのユーティリティ。
/// </summary>
/// <remarks>
/// WinFsp は callback に <c>byte[]?</c> を要求し、その値を kernel に渡す。
/// <c>null</c> を返すと shell の AccessCheck 経路が "SD 不明" として
/// <c>ERROR_INVALID_SECURITY_DESCR</c> (1338) を吐き、Explorer の
/// 「新規作成」メニューが folder 1 項目だけに退化したり、UAC 盾アイコンが
/// 貼られる原因になる。最低でも有効な空 DACL を持つ SD を返す必要がある。
///
/// <para>mikura の認可は server 側 <c>checkPermission</c> (REST 401/403) で
/// 行う設計なので、OS 層では「Authenticated Users に Full Access」を返すのが
/// 適切。SD を Windows AccessCheck の意味で正確に再現するのではなく、
/// 「Explorer に怒られない最小限の SD」として機能する placeholder。</para>
/// </remarks>
public static class SecurityDescriptors
{
    /// <summary>
    /// 典型的な「誰でも Full Access」SDDL。
    /// <para>O:BA = Owner BUILTIN\Administrators、G:BA = Group も同様。</para>
    /// <para>D:P = Protected DACL (継承無効)。</para>
    /// <para>(A;;FA;;;SY) = SYSTEM 全権、(A;;FA;;;BA) = Administrators 全権、
    /// (A;;FA;;;WD) = Everyone 全権 (= AccessCheck 通過、Explorer 表示用)。</para>
    /// </summary>
    public const string EveryoneFullAccessSddl =
        "O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;WD)";

    /// <summary>
    /// SDDL 文字列を self-relative SECURITY_DESCRIPTOR の byte[] に変換する。
    /// 変換 cost は無視できないので、callback の戻り値として使う場合は呼び出し側で
    /// static field に cache すること。
    /// </summary>
    /// <exception cref="System.ComponentModel.Win32Exception">SDDL parse 失敗。</exception>
    public static byte[] FromSddl(string sddl) => Sddl.FromString(sddl);
}
