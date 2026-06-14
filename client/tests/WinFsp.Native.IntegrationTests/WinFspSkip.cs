using Microsoft.Win32;
using Xunit;

namespace WinFsp.Native.IntegrationTests;

/// <summary>
/// WinFsp driver / DLL の有無を判定して、未 install 環境では integration test 全体を skip。
/// CI hosted runner や Linux で <c>dotnet test</c> が呼ばれた時に「失敗」ではなく「skip」に
/// 落とすことで、本来の単体テストの green を保つ。
/// </summary>
internal static class WinFspSkip
{
    private static readonly Lazy<bool> _installed = new(DetectInstalled);

    public static void IfMissing()
    {
        Skip.IfNot(_installed.Value, "WinFsp not installed on this machine — integration tests skipped");
    }

    private static bool DetectInstalled()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            using var key = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32)
                .OpenSubKey(@"SOFTWARE\WinFsp");
            var installDir = key?.GetValue("InstallDir") as string;
            if (string.IsNullOrEmpty(installDir)) return false;
            return File.Exists(Path.Combine(installDir, "bin", "winfsp-x64.dll"));
        }
        catch { return false; }
    }
}
