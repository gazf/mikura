using System;
using System.Text;
using Mikura.Core.Crypto;
using Xunit;

namespace Mikura.Core.Tests.Crypto;

/// <summary>
/// <see cref="DataProtection"/> の責務:
///   - DPAPI(CurrentUser) で plaintext byte[] → ciphertext byte[] に変換できる。
///   - 暗号化 → 復号で元の byte 列が完全に一致する (loss なし)。
///   - 復号は ciphertext が壊れている場合 Win32Exception を投げる。
///
/// crypt32.dll は Windows のみ。Linux test 経路では OS guard で early return。
/// </summary>
public class DataProtectionTests
{
    private static bool IsWindows => OperatingSystem.IsWindows();

    [Fact]
    public void RoundTrip_AsciiToken_RestoresExactBytes()
    {
        if (!IsWindows) return;

        var original = Encoding.UTF8.GetBytes("mikura-test-token-0123456789abcdef");
        var cipher = DataProtection.Protect(original);
        Assert.NotEmpty(cipher);
        Assert.NotEqual(original, cipher); // 暗号化されているので異なる

        var restored = DataProtection.Unprotect(cipher);
        Assert.Equal(original, restored);
    }

    [Fact]
    public void RoundTrip_NonAsciiBytes_PreservesAllBytes()
    {
        if (!IsWindows) return;

        // 全 byte 値を含むバッファ (= UTF-8 invalid な byte パターンも含む) で
        // round-trip の bit-精度を確認する。
        var original = new byte[256];
        for (int i = 0; i < original.Length; i++) original[i] = (byte)i;

        var cipher = DataProtection.Protect(original);
        var restored = DataProtection.Unprotect(cipher);
        Assert.Equal(original, restored);
    }

    [Fact]
    public void Unprotect_GarbageInput_ThrowsWin32Exception()
    {
        if (!IsWindows) return;

        var garbage = new byte[] { 0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE };
        Assert.Throws<System.ComponentModel.Win32Exception>(
            () => DataProtection.Unprotect(garbage));
    }

    [Fact]
    public void Unprotect_EmptyInput_ThrowsArgumentException()
    {
        if (!IsWindows) return;

        Assert.Throws<ArgumentException>(
            () => DataProtection.Unprotect(Array.Empty<byte>()));
    }

    [Fact]
    public void Protect_EmptyInput_AllowedAndRoundTrips()
    {
        if (!IsWindows) return;

        var cipher = DataProtection.Protect(Array.Empty<byte>());
        Assert.NotEmpty(cipher); // 空でも DPAPI header があるので 0 ではない
        var restored = DataProtection.Unprotect(cipher);
        Assert.Empty(restored);
    }
}
