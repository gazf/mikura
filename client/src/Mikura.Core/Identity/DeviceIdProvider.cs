using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32;

namespace Mikura.Core.Identity;

/// <summary>
/// 「このマシンの、このユーザ」固有の Device ID を **毎起動 derive** する provider。
/// 旧実装は <c>device.json</c> に random UUID を永続化していたが、それは file を
/// コピーするだけで device identity が複製できてしまう問題があった。新実装は
/// 機械由来の安定値 (Windows MachineGuid) と user 識別子 (SID) を SHA256 で
/// 結合した結果から UUID 形式に整形する。<c>device.json</c> は廃止。
/// </summary>
/// <remarks>
/// <para><b>セキュリティ性質</b>: 本 derive 自体は obscurity 止まりで、
/// security barrier ではない (binary を逆アセンブルして MachineGuid と SID を
/// 知ってしまえば任意の host から spoof 可能)。実質的な防御は **bearer token の
/// DPAPI 暗号化**で行われる。derive は「file をコピーしただけで device identity が
/// 複製される」事態を避けるための baseline 設定であり、TPM ベースの sealed key
/// に比べると弱い。詳細は ADR-033 (multi-account auth、本 plan で執筆予定) 参照。</para>
///
/// <para><b>挙動</b>:
///   - 同 MachineGuid + 同 SID なら毎回同じ UUID を返す (deterministic)。
///   - Windows reinstall で MachineGuid が変わると新 ID = 旧 token 失効 = 再 enroll
///     必要 (= 正しい挙動、端末アイデンティティの一意性)。
///   - 別 Windows user として実行すると別 ID = 旧 token は使えない (= multi-user PC
///     共有時の隔離)。
/// </para>
///
/// <para><b>cross-platform</b>: Microsoft.Win32 / WindowsIdentity は Linux では
/// PlatformNotSupportedException を投げる。bench harness 等 Linux で本クラスを
/// **呼ばない** 設計を維持すれば問題なし。テストは <c>OperatingSystem.IsWindows()</c>
/// で guard する。</para>
/// </remarks>
public static class DeviceIdProvider
{
    /// <summary>
    /// derive アルゴリズムの version tag。将来 derive 規則を変える時 (= 過去 token と
    /// 切り離して新 binding にしたい時) は値を bump する。
    /// </summary>
    private const string AlgVersion = "mikura-device-v1";

    private static string? _cached;

    /// <summary>
    /// Device ID を derive して返す。process 寿命内で 1 回だけ計算、以後 cached。
    /// </summary>
    /// <exception cref="PlatformNotSupportedException">Windows 以外で呼ばれた場合。</exception>
    [SupportedOSPlatform("windows")]
    public static string Compute()
    {
        if (_cached is not null) return _cached;

        var machineGuid = ReadMachineGuid();
        var sid = ReadCurrentUserSid();

        // SHA256( algVersion + NUL + machineGuid + NUL + sid )
        // NUL 区切りで各 field が境界を持ち、衝突 (例: machineGuid 末尾が SID 先頭と
        // つながって同じ string になる) を防ぐ。
        var input = $"{AlgVersion}\0{machineGuid}\0{sid}";
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(input));

        // 先頭 16 byte を Guid に詰めて文字列化 (RFC 4122 風の UUID 表現)。
        // 残り 16 byte は捨てるが、衝突確率は 2^-64 で実用上問題なし。
        var guidBytes = new byte[16];
        Array.Copy(bytes, 0, guidBytes, 0, 16);
        _cached = new Guid(guidBytes).ToString();
        return _cached;
    }

    /// <summary>
    /// テスト用 reset。process 寿命 cache を捨てて、次回 Compute() で再計算させる。
    /// 本番コードからは呼ばない (= public visibility は test project (別 assembly) から
    /// 呼べるための便宜、InternalsVisibleTo を増やしたくない方針)。
    /// </summary>
    public static void _ResetCacheForTesting() => _cached = null;

    [SupportedOSPlatform("windows")]
    private static string ReadMachineGuid()
    {
        // HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid: Windows install 時に
        // 決まる UUID。reinstall まで不変。任意の user (admin 不要) から read 可。
        // x86 / x64 共に WOW64 redirect を経由せず同じ key を見る (HKLM の本物)。
        using var key = Registry.LocalMachine.OpenSubKey(
            @"SOFTWARE\Microsoft\Cryptography",
            writable: false);
        var v = key?.GetValue("MachineGuid") as string;
        if (string.IsNullOrEmpty(v))
        {
            throw new InvalidOperationException(
                "MachineGuid not readable from HKLM\\SOFTWARE\\Microsoft\\Cryptography. " +
                "This is unexpected on a standard Windows install.");
        }
        return v;
    }

    [SupportedOSPlatform("windows")]
    private static string ReadCurrentUserSid()
    {
        // WindowsIdentity.User は対話 user の SID。サービスとして動く場合は
        // SYSTEM 等になるが、mikura は tray app として user session で動く前提。
        var sid = WindowsIdentity.GetCurrent().User?.Value;
        if (string.IsNullOrEmpty(sid))
        {
            throw new InvalidOperationException(
                "Current user SID not available. " +
                "DeviceIdProvider requires an interactive Windows user session.");
        }
        return sid;
    }
}
