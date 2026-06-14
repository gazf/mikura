using WinFsp.Native;
using WinFsp.Native.IntegrationTests.InMemory;
using Xunit;
using Xunit.Abstractions;

namespace WinFsp.Native.IntegrationTests;

/// <summary>
/// hot path (per-IRP) で managed heap alloc を予算内に保つ regression test。
/// AsyncCompletion.SendResponseRead/Write を stackalloc 化した時点 (Bug #4 fix と同 commit)
/// で per-IRP の native heap alloc は 0、managed alloc は <see cref="UnmanagedMemoryManager"/>
/// (~24B) + async state machine box + <see cref="Task"/> ぶんに留まる。これに +
/// framework 側 (Stream.Read) の overhead を含めても 1 op あたり 1KiB を超えなければ
/// 「誰かが hot path に <c>new byte[]</c> や <c>.ToArray()</c> を入れた」regression は
/// catch できる粗さで budget を切る。
/// </summary>
/// <remarks>
/// <para>計測方針:
///   - <see cref="GC.GetTotalAllocatedBytes"/> (process 全体) を使う。dispatcher thread と
///     async 完了 thread が test thread と別なので <see cref="GC.GetAllocatedBytesForCurrentThread"/>
///     では拾えない。
///   - test thread 側の余計な alloc を切るため、read buffer を loop 外で 1 個 reuse、
///     <see cref="FileStream.Read(byte[],int,int)"/> で seek+read を回す。
///   - JIT warmup 100 iteration → GC.Collect で baseline 整地 → 1000 iteration 計測 →
///     1 op あたりに割って assert。
///   - 値はマシン状態と framework version で変動するので threshold は緩め (1024B/op)。
///     現実装 (stackalloc 後) で ~200B/op を想定。<c>new byte[]</c> 1 個 (例えば 4KiB IRP 用) の
///     混入は 4096B/op になって即 catch される。
/// </para>
/// <para>Windows + WinFsp 必須。Linux/CI で <see cref="WinFspSkip"/> 経由 skip。</para>
/// </remarks>
public class AllocationRegressionTests : IDisposable
{
    private readonly ITestOutputHelper _output;
    private readonly InMemoryFileSystem _fs = new();
    private readonly FileSystemHost _host;
    private readonly string _mountPoint;
    private bool _mounted;

    public AllocationRegressionTests(ITestOutputHelper output)
    {
        _output = output;
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
        throw new InvalidOperationException("no free drive letter");
    }

    [SkippableFact]
    public void ReadHotPath_StaysUnderAllocBudget()
    {
        WinFspSkip.IfMissing();
        _host.Mount(_mountPoint);
        _mounted = true;

        var path = $"{_mountPoint}\\alloc-read.bin";
        File.WriteAllBytes(path, new byte[64 * 1024]);

        using var fs = File.OpenRead(path);
        var buffer = new byte[4096];

        // warmup: JIT + tiered compilation 安定化
        for (var i = 0; i < 100; i++) { fs.Seek(0, SeekOrigin.Begin); fs.ReadExactly(buffer); }

        // baseline 整地
        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        var before = GC.GetTotalAllocatedBytes(precise: true);

        const int N = 1000;
        for (var i = 0; i < N; i++)
        {
            fs.Seek(0, SeekOrigin.Begin);
            fs.ReadExactly(buffer);
        }

        var totalAlloc = GC.GetTotalAllocatedBytes(precise: true) - before;
        var perOp = totalAlloc / N;
        _output.WriteLine($"read alloc/op = {perOp}B (total {totalAlloc}B over {N} iterations)");

        // 現実装 (stackalloc 後 + ID dict + UnmanagedMemoryManager class) で ~200B/op 想定。
        // 1024B threshold は 4 倍の余裕 = framework / GC 揺れ吸収 + regression 検出力両立。
        Assert.True(perOp < 1024, $"read alloc/op={perOp}B exceeds 1024B budget");
    }

    [SkippableFact]
    public void WriteHotPath_StaysUnderAllocBudget()
    {
        WinFspSkip.IfMissing();
        _host.Mount(_mountPoint);
        _mounted = true;

        var path = $"{_mountPoint}\\alloc-write.bin";
        using var fs = File.Create(path);
        var buffer = new byte[4096];
        new Random(42).NextBytes(buffer);

        for (var i = 0; i < 100; i++) { fs.Seek(0, SeekOrigin.Begin); fs.Write(buffer, 0, buffer.Length); fs.Flush(); }

        GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
        var before = GC.GetTotalAllocatedBytes(precise: true);

        const int N = 1000;
        for (var i = 0; i < N; i++)
        {
            fs.Seek(0, SeekOrigin.Begin);
            fs.Write(buffer, 0, buffer.Length);
            fs.Flush();
        }

        var totalAlloc = GC.GetTotalAllocatedBytes(precise: true) - before;
        var perOp = totalAlloc / N;
        _output.WriteLine($"write alloc/op = {perOp}B (total {totalAlloc}B over {N} iterations)");

        // write は flush + FileInfo 反映で read より少し多めに食う可能性、しかし同じ 1024B 枠で十分。
        Assert.True(perOp < 1024, $"write alloc/op={perOp}B exceeds 1024B budget");
    }
}
