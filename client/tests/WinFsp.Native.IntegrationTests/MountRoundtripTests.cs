using WinFsp.Native;
using WinFsp.Native.IntegrationTests.InMemory;
using Xunit;

namespace WinFsp.Native.IntegrationTests;

/// <summary>
/// 実 WinFsp driver + winfsp-x64.dll を経由した end-to-end test。
/// 責務:
///   - <see cref="FileSystemHost.Mount"/> が drive letter に bind できる
///     (VolumeParams + FspFileSystemCreate + SetMountPoint + StartDispatcher の一連が
///      動く = native binding の最低保証)。
///   - 書き出したバイトと読み戻したバイトが一致する (= async I/O callback が IRP buffer に
///     正しく書く)。
///   - Bug #4 regression: 同一 path への複数 Open/Close で内容が破壊されない
///     (UmFileContextIsUserContext2 が立ってないと Read open が Create handle に
///      ぶつかって 全部ゼロが返り、SequenceEqual が False になる)。
///
/// 実行条件: Windows + WinFsp 2.1+ install + Administrator (drive letter mount のため)。
/// 環境が満たさない場合は <see cref="WinFspSkip.IfMissing"/> で skip。
/// </summary>
public class MountRoundtripTests : IDisposable
{
    private readonly InMemoryFileSystem _fs;
    private readonly FileSystemHost _host;
    private readonly string _mountPoint;
    private bool _mounted;

    public MountRoundtripTests()
    {
        _fs = new InMemoryFileSystem();
        _host = new FileSystemHost(_fs);
        _mountPoint = FindFreeDriveLetter();
    }

    public void Dispose()
    {
        try { if (_mounted) _host.Unmount(); } catch { }
        _host.Dispose();
    }

    private static string FindFreeDriveLetter()
    {
        for (var letter = 'Y'; letter >= 'F'; letter--)
        {
            var drive = $"{letter}:";
            if (!Directory.Exists(drive + "\\")) return drive;
        }
        throw new InvalidOperationException("no free drive letter for integration mount");
    }

    [SkippableFact]
    public void Mount_DriveLetter_Succeeds()
    {
        WinFspSkip.IfMissing();

        _host.Mount(_mountPoint);
        _mounted = true;

        Assert.True(Directory.Exists(_mountPoint + "\\"));
    }

    [SkippableFact]
    public void WriteReadRoundtrip_64KiB_BytesMatch()
    {
        WinFspSkip.IfMissing();

        _host.Mount(_mountPoint);
        _mounted = true;

        var bytes = new byte[64 * 1024];
        new Random(42).NextBytes(bytes);
        var path = $"{_mountPoint}\\rt.bin";

        File.WriteAllBytes(path, bytes);
        var readback = File.ReadAllBytes(path);

        Assert.Equal(bytes.Length, readback.Length);
        Assert.Equal(bytes, readback);
    }

    [SkippableFact]
    public void WriteThenSeparateOpenForRead_BytesMatch_RegressionBug4()
    {
        // Bug #4 regression: UmFileContextIsUserContext2 を立てないと、Open(Read) で
        // 返す FileContext が Create handle の FileContext で上書きされ、Read IRP が
        // Create handle 経由で走る (在留中の FreshlyCreated=true 等で全部ゼロ返し)。
        // 実機 PowerShell scenario と同じ手順: write_all_bytes → 別ハンドルで read_all_bytes
        // → SequenceEqual。
        WinFspSkip.IfMissing();

        _host.Mount(_mountPoint);
        _mounted = true;

        var bytes = new byte[1024 * 1024]; // 1MiB
        new Random(7).NextBytes(bytes);
        var path = $"{_mountPoint}\\bug4.bin";

        // 別ハンドルで write/read を明示的に分ける (using で確実に close)。
        using (var fs = File.Create(path)) { fs.Write(bytes, 0, bytes.Length); }
        byte[] readback;
        using (var fs = File.OpenRead(path)) { readback = new byte[fs.Length]; fs.ReadExactly(readback); }

        Assert.Equal(bytes, readback);
    }

    [SkippableFact]
    public void Enumerate_AfterCreateFiles_ListsThem()
    {
        WinFspSkip.IfMissing();

        _host.Mount(_mountPoint);
        _mounted = true;

        File.WriteAllText($"{_mountPoint}\\a.txt", "alpha");
        File.WriteAllText($"{_mountPoint}\\b.txt", "beta");

        var names = Directory.GetFiles(_mountPoint + "\\").Select(Path.GetFileName).OrderBy(n => n).ToArray();

        Assert.Contains("a.txt", names);
        Assert.Contains("b.txt", names);
    }
}
