namespace Mikura.Bench.Coalescer;

/// <summary>
/// IRP generator のレシピ。CDM の主要 4 パターンに対応。
/// <list type="bullet">
///   <item>SEQ 1M Q=8 : 1MB 連続書き、深度 8 (CDM SEQ1M Q8T1 模倣)。</item>
///   <item>SEQ 128K Q=32: 128KB 連続書き、深度 32 (CDM SEQ128K Q32T1)。</item>
///   <item>RND 4K Q=32 T=16: 4KB 散布書き、深度 32 × thread 16 (CDM RND4K Q32T16)。</item>
///   <item>RND 4K Q=1 : 4KB 散布書き、単一直列 (CDM RND4K Q1T1)。</item>
/// </list>
/// </summary>
internal enum ScenarioKind
{
    Seq1M,
    Seq128K,
    Rnd4KDeep,
    Rnd4KShallow,
}

internal sealed record ScenarioPlan(
    string Name,
    int IoSize,
    int QueueDepth,
    int Threads,
    bool Sequential,
    long FileSize,
    int FileCount)
{
    public long TotalBytes => (long)IoSize * IoCount;
    public int IoCount => (int)(FileSize / IoSize) * FileCount;

    public static ScenarioPlan ForKind(ScenarioKind kind, long bytesPerFile) => kind switch
    {
        ScenarioKind.Seq1M => new("SEQ 1M Q=8",
            IoSize: 1 * 1024 * 1024, QueueDepth: 8, Threads: 1,
            Sequential: true, FileSize: bytesPerFile, FileCount: 1),

        ScenarioKind.Seq128K => new("SEQ 128K Q=32",
            IoSize: 128 * 1024, QueueDepth: 32, Threads: 1,
            Sequential: true, FileSize: bytesPerFile, FileCount: 1),

        ScenarioKind.Rnd4KDeep => new("RND 4K Q=32 T=16",
            IoSize: 4 * 1024, QueueDepth: 32, Threads: 16,
            Sequential: false, FileSize: bytesPerFile, FileCount: 16),

        ScenarioKind.Rnd4KShallow => new("RND 4K Q=1",
            IoSize: 4 * 1024, QueueDepth: 1, Threads: 1,
            Sequential: false, FileSize: bytesPerFile, FileCount: 1),

        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };
}
