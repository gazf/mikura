using System;
using System.IO;
using System.Reflection;
using System.Text.Json;
using Mikura.Core.Identity;
using Xunit;

namespace Mikura.Core.Tests.Identity;

/// <summary>
/// DeviceIdProvider の責務:
///   - 実行ファイル同ディレクトリの device.json を読み書きし、
///     起動間で同じ deviceId を返す (= 「インストール単位」の永続 ID)。
///   - 未存在なら新規 UUID を生成して保存する。
///   - 壊れた JSON は再生成する (例外で落ちない)。
///
/// 注意: AppContext.BaseDirectory は固定なので、テスト用に書き換えできない。
/// テストでは「実 BaseDirectory に居る device.json を退避 → テスト → 復元」
/// で隔離する。
/// </summary>
public class DeviceIdProviderTests : IDisposable
{
    private const string FileName = "device.json";
    private readonly string _path;
    private readonly string? _backup;

    public DeviceIdProviderTests()
    {
        _path = Path.Combine(AppContext.BaseDirectory, FileName);
        if (File.Exists(_path))
        {
            _backup = _path + ".test-backup";
            File.Move(_path, _backup, overwrite: true);
        }
    }

    public void Dispose()
    {
        if (File.Exists(_path)) File.Delete(_path);
        if (_backup is not null && File.Exists(_backup))
            File.Move(_backup, _path, overwrite: true);
    }

    [Fact]
    public void GetOrCreate_FirstCall_GeneratesAndPersistsUuid()
    {
        Assert.False(File.Exists(_path));

        var id = DeviceIdProvider.GetOrCreate();

        Assert.True(File.Exists(_path), "device.json は生成されるべき");
        Assert.True(Guid.TryParse(id, out _), "deviceId は UUID 形式であるべき");
    }

    [Fact]
    public void GetOrCreate_SubsequentCall_ReturnsSamePersistedId()
    {
        var first = DeviceIdProvider.GetOrCreate();
        var second = DeviceIdProvider.GetOrCreate();
        Assert.Equal(first, second);
    }

    [Fact]
    public void GetOrCreate_AcrossDifferentProcessRuns_ReadsExistingFile()
    {
        // プロセス再起動を模擬: 直接 device.json を書き、Provider が読み出すこと。
        var preset = Guid.NewGuid().ToString();
        var json = JsonSerializer.Serialize(new { deviceId = preset, createdAt = DateTime.UtcNow });
        File.WriteAllText(_path, json);

        var id = DeviceIdProvider.GetOrCreate();
        Assert.Equal(preset, id);
    }

    [Fact]
    public void GetOrCreate_CorruptFile_RegeneratesNewId()
    {
        File.WriteAllText(_path, "this is not valid JSON ::");

        var id = DeviceIdProvider.GetOrCreate();
        Assert.True(Guid.TryParse(id, out _), "壊れた JSON でも新 UUID を返すべき");

        // 再生成の結果がディスクにも反映されている
        var second = DeviceIdProvider.GetOrCreate();
        Assert.Equal(id, second);
    }

    [Fact]
    public void GetOrCreate_EmptyDeviceId_TreatsAsCorruptAndRegenerates()
    {
        var json = JsonSerializer.Serialize(new { deviceId = "", createdAt = DateTime.UtcNow });
        File.WriteAllText(_path, json);

        var id = DeviceIdProvider.GetOrCreate();
        Assert.False(string.IsNullOrWhiteSpace(id));
        Assert.True(Guid.TryParse(id, out _));
    }
}
