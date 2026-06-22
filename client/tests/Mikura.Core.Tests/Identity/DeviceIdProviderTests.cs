using System;
using Mikura.Core.Identity;
using Xunit;

namespace Mikura.Core.Tests.Identity;

/// <summary>
/// 新 <see cref="DeviceIdProvider"/> の責務:
///   - MachineGuid + 現 user SID から derive した安定 UUID を返す。
///   - process 寿命内で同じ ID を返す (cache)。
///   - 再計算でも同じ値 (deterministic)。
///
/// Windows 以外では Microsoft.Win32 / WindowsIdentity が
/// PlatformNotSupportedException を投げるので、OS guard で early return。
/// Test project は net10.0-windows TFM だが、`dotnet test` を Linux で走らせると
/// runtime が Linux 扱いになり、Win32 API が落ちる。
/// </summary>
public class DeviceIdProviderTests
{
    private static bool IsWindows => OperatingSystem.IsWindows();

    public DeviceIdProviderTests()
    {
        // 各テスト前に static cache を reset (Compute() の cache が前 test の
        // 結果を引きずらないように)。
        DeviceIdProvider._ResetCacheForTesting();
    }

    [Fact]
    public void Compute_ReturnsValidGuidFormat()
    {
        if (!IsWindows) return;

        var id = DeviceIdProvider.Compute();
        Assert.True(Guid.TryParse(id, out _), $"derived ID is not GUID format: {id}");
    }

    [Fact]
    public void Compute_IsDeterministic()
    {
        if (!IsWindows) return;

        var first = DeviceIdProvider.Compute();
        DeviceIdProvider._ResetCacheForTesting();
        var second = DeviceIdProvider.Compute();
        Assert.Equal(first, second);
    }

    [Fact]
    public void Compute_CachedAcrossCalls()
    {
        if (!IsWindows) return;

        // Reset せずに 2 回呼ぶと、内部 cache 経由で同じ参照値が返る (= deterministic
        // の subset だが、cache の存在を明示的に固定)。
        var first = DeviceIdProvider.Compute();
        var second = DeviceIdProvider.Compute();
        Assert.Equal(first, second);
    }
}
