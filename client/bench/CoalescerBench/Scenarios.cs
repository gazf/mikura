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
    // RND 4K に対する (Q, T) scaling sweep。1251 B/op の正体が gate contention か
    // file-level fan-out か worker Task.Run か、(Q, T) を直交 split して見極める。
    Rnd4KQ1T1,
    Rnd4KQ32T1,
    Rnd4KQ1T16,
    Rnd4KQ32T16,
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

        // ── scaling sweep: alloc/op の (Q, T) 依存を切り分ける ─────────
        // Q=1 T=1: シングルワーカ・gate 非競合 = pure pipeline overhead 床値
        // Q=32 T=1: 同一 file への gate contention の影響 (Coalescer 1 個に 32 await)
        // Q=1 T=16: file 別 Coalescer 16 個 × 1 worker = file-fanout のみ (各 gate 非競合)
        // Q=32 T=16: 全部入り = 現 Rnd4KDeep と同等
        ScenarioKind.Rnd4KQ1T1 => new("RND 4K Q=1 T=1",
            IoSize: 4 * 1024, QueueDepth: 1, Threads: 1,
            Sequential: false, FileSize: bytesPerFile, FileCount: 1),

        ScenarioKind.Rnd4KQ32T1 => new("RND 4K Q=32 T=1",
            IoSize: 4 * 1024, QueueDepth: 32, Threads: 1,
            Sequential: false, FileSize: bytesPerFile, FileCount: 1),

        ScenarioKind.Rnd4KQ1T16 => new("RND 4K Q=1 T=16",
            IoSize: 4 * 1024, QueueDepth: 1, Threads: 16,
            Sequential: false, FileSize: bytesPerFile, FileCount: 16),

        ScenarioKind.Rnd4KQ32T16 => new("RND 4K Q=32 T=16",
            IoSize: 4 * 1024, QueueDepth: 32, Threads: 16,
            Sequential: false, FileSize: bytesPerFile, FileCount: 16),

        _ => throw new ArgumentOutOfRangeException(nameof(kind)),
    };
}
