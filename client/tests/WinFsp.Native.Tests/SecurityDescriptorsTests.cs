using Xunit;

namespace WinFsp.Native.Tests;

/// <summary>
/// <see cref="SecurityDescriptors"/> の責務:
///   - SDDL 文字列を Windows advapi32 経由で self-relative SECURITY_DESCRIPTOR の
///     binary 表現 (byte[]) に変換する。
///   - 失敗時 (= 不正 SDDL) は <see cref="System.ComponentModel.Win32Exception"/>。
///
/// 失敗 mode 固定: SD が null だと WinFsp host callback で Marshal.Copy 経路を
/// 通らず *pSdSize = 0 となり、shell の AccessCheck が
/// <c>ERROR_INVALID_SECURITY_DESCR</c> (1338) を吐いて Explorer 新規作成メニューが
/// folder 1 項目に退化する。BackendFileSystem.GetSecurity が _defaultSd を返す
/// ようになったことの安全網。
/// </summary>
public class SecurityDescriptorsTests
{
    // advapi32 (ConvertStringSecurityDescriptorToSecurityDescriptorW) は Windows
    // 専用 API。プロジェクト自体は net10.0-windows10.0.17763.0 だが、Linux 上で
    // `dotnet test` が起動できてしまうため、テスト本体は OS 判定で early return。
    // Windows 上では full assertion が走る。
    private static bool IsWindows => OperatingSystem.IsWindows();

    [Fact]
    public void FromSddl_EveryoneFullAccess_ReturnsNonEmpty()
    {
        if (!IsWindows) return;

        // 既定 SDDL は最低でも header (20 byte) + ACL + ACEs を含むので 30 byte 以上は確保される
        // (実測 ~60 byte、環境依存があるので >= 20 で gate)。
        var sd = SecurityDescriptors.FromSddl(SecurityDescriptors.EveryoneFullAccessSddl);

        Assert.NotNull(sd);
        Assert.True(sd.Length >= 20, $"SD too small: {sd.Length} bytes");
    }

    [Fact]
    public void FromSddl_SelfRelativeHeader_HasValidRevisionAndType()
    {
        if (!IsWindows) return;

        // self-relative SECURITY_DESCRIPTOR の先頭 layout:
        //   [0]: Revision (= 1)
        //   [1]: Sbz1 (reserved, 0)
        //   [2..3]: Control bits (LE u16) — bit 0x8000 (SE_SELF_RELATIVE) が立っている
        var sd = SecurityDescriptors.FromSddl(SecurityDescriptors.EveryoneFullAccessSddl);

        Assert.Equal(1, sd[0]);
        ushort control = (ushort)(sd[2] | (sd[3] << 8));
        Assert.True((control & 0x8000) != 0, "SE_SELF_RELATIVE flag missing");
    }

    [Fact]
    public void FromSddl_InvalidString_Throws()
    {
        if (!IsWindows) return;

        Assert.Throws<System.ComponentModel.Win32Exception>(
            () => SecurityDescriptors.FromSddl("not-a-valid-sddl"));
    }
}
