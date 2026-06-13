using System.Diagnostics;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;
using Mikura.Core.Sync;

namespace Mikura.Bench.Coalescer;

/// <summary>
/// 1 scenario を回して MB/s / IOPS / alloc / p95-p99 latency をまとめて返す
/// 簡易 harness。BenchmarkDotNet は使わない (server を起動する E2E モードで
/// fixture が複雑になるため自前 Stopwatch + GC.GetTotalAllocatedBytes に統一)。
///
/// <para>計測対象: <see cref="IFileSystemBackend.WriteAsync"/> 呼出をひと束として
/// 受け、それを target throughput / queue-depth に従って fan-out して
/// 完了まで待つ。Cleanup (=finalize) は計測の外で 1 回行う。</para>
/// </summary>
internal sealed class Harness
{
    private readonly IServerApi _api;
    private readonly bool _bypassBackend;

    public Harness(IServerApi api, bool bypassBackend = false)
    {
        _api = api;
        _bypassBackend = bypassBackend;
    }

    public async Task<BenchResult> RunAsync(ScenarioPlan plan, CancellationToken ct = default)
    {
        if (_bypassBackend)
        {
            // pure harness baseline: FileSystemBackend / WriteCoalescer を一切経由せず、
            // worker の Task.Run + await loop だけ走らせる。bypass モード - bench モード
            // の差分 = FileSystemBackend + Coalescer の per-IO alloc。
            return await RunBypassAsync(plan, ct).ConfigureAwait(false);
        }

        // 各 file ごとに backend を 1 つ用意。CDM の T=16 は実体としても 16 file 同時。
        var backend = new FileSystemBackend(_api);
        await backend.InitializeAsync(ct).ConfigureAwait(false);

        // Note: data buffer は 1 つを使い回す (pure path 計測なので payload の内容は
        // 関係ない)。固定パターンで埋めて memcmp 等の dead-code elimination を防ぐ。
        var data = new byte[plan.IoSize];
        for (int i = 0; i < data.Length; i++) data[i] = (byte)(i * 31);

        // 進行中の handle (close は計測 outside で実施)。
        var handles = new IFileHandle[plan.FileCount];
        for (int i = 0; i < plan.FileCount; i++)
        {
            var path = $"/bench-{Guid.NewGuid():N}.bin";
            handles[i] = (await backend.CreateAsync(path, isDirectory: false, ct).ConfigureAwait(false))
                ?? throw new InvalidOperationException("CreateAsync returned null");
        }

        // RND 用 offset 列。固定 seed で reproducible。各 file 内で重複しない offset
        // を予め流す (実 RND 4K は重複あり得るが、固定 seed で全 run 共通にした方が
        // 比較がきれい)。
        var rng = new Random(0xBEEF);
        var ioPerFile = (int)(plan.FileSize / plan.IoSize);
        var offsets = new long[plan.FileCount][];
        for (int f = 0; f < plan.FileCount; f++)
        {
            offsets[f] = new long[ioPerFile];
            if (plan.Sequential)
            {
                for (int i = 0; i < ioPerFile; i++) offsets[f][i] = (long)i * plan.IoSize;
            }
            else
            {
                // 4KB-aligned random offset 列。複数 file 横断はせず、各 file 内に閉じる。
                for (int i = 0; i < ioPerFile; i++)
                {
                    var slot = rng.NextInt64(0, ioPerFile);
                    offsets[f][i] = slot * plan.IoSize;
                }
            }
        }

        // ── 計測区間 ─────────────────────────────────────────────
        // Cleanup (=finalize) を含めて計測する。理由:
        //   - WriteCoalescer は background PATCH を kick したまま return する
        //     (最大 MaxInFlight=4 本まで pipeline)。WriteAsync 完了 ≠ HTTP 送出完了。
        //   - http backend で計測区間を WriteAsync だけにすると「coalescer の入口
        //     buffer に積み終わるまで」しか測らず、桁違いに楽観的な MB/s が出る。
        //   - fake backend では Cleanup も即時 return なので余計な overhead は無い。
        //
        // breakdown 用に 3 区間に分けて GC.GetTotalAllocatedBytes を取る:
        //   - workers fan-out → join: pure pipeline cost
        //   - cleanup: finalize / lock release / coalescer dispose
        //   - スケジューラ alloc (Task.Run × N) は workers 区間にカウントされる
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        var allocStart = GC.GetTotalAllocatedBytes(precise: true);
        var sw = Stopwatch.StartNew();

        // QD 制御: 各 file に対して QueueDepth 本の writer task を立て、その全てが
        // 各々 ioPerFile / QueueDepth 本の write を走らせる。Sequential では writer
        // 間で offset 列を stride 分担 (CDM の seq pattern と同じ)、Random では
        // 重複 OK。
        var workerCount = plan.FileCount * plan.QueueDepth;
        var tasks = new Task[workerCount];
        for (int f = 0; f < plan.FileCount; f++)
        {
            var handle = handles[f];
            var off = offsets[f];
            for (int q = 0; q < plan.QueueDepth; q++)
            {
                var startIdx = q;
                tasks[f * plan.QueueDepth + q] = Task.Run(async () =>
                {
                    for (int i = startIdx; i < off.Length; i += plan.QueueDepth)
                    {
                        await backend.WriteAsync(
                            handle,
                            off[i],
                            data,
                            appendToEnd: false,
                            constrainedIo: false,
                            ct).ConfigureAwait(false);
                    }
                }, ct);
            }
        }
        await Task.WhenAll(tasks).ConfigureAwait(false);
        var allocAfterWorkers = GC.GetTotalAllocatedBytes(precise: true);

        // Cleanup: drain coalescer in-flight + finalize upload. ここまで終わって
        // 初めて全 byte が server に到達した = E2E throughput が確定する。
        for (int i = 0; i < handles.Length; i++)
        {
            await backend.CleanupAsync(handles[i], CleanupFlags.Modified, ct).ConfigureAwait(false);
            await backend.CloseAsync(handles[i], ct).ConfigureAwait(false);
        }

        sw.Stop();
        var elapsed = sw.Elapsed;
        var allocEnd = GC.GetTotalAllocatedBytes(precise: true);
        // ─────────────────────────────────────────────────────────

        for (int i = 0; i < handles.Length; i++) handles[i].Dispose();

        var totalBytes = plan.TotalBytes;
        var mbps = totalBytes / 1_000_000.0 / elapsed.TotalSeconds;
        var iops = plan.IoCount / elapsed.TotalSeconds;

        var workerAlloc = allocAfterWorkers - allocStart;
        var cleanupAlloc = allocEnd - allocAfterWorkers;

        return new BenchResult(
            ScenarioName: plan.Name,
            Elapsed: elapsed,
            TotalBytes: totalBytes,
            IoCount: plan.IoCount,
            MBps: mbps,
            Iops: iops,
            AllocatedBytes: allocEnd - allocStart,
            BytesPerOp: (double)(allocEnd - allocStart) / plan.IoCount,
            WorkerBytesPerOp: (double)workerAlloc / plan.IoCount,
            CleanupBytesTotal: cleanupAlloc);
    }

    /// <summary>
    /// FileSystemBackend / WriteCoalescer を経由しない harness baseline。同じ
    /// FileCount × QueueDepth で Task.Run + await Task.CompletedTask の loop だけ
    /// 走らせて、harness 自体の Task.Run / await / Task.WhenAll が per-IO に
    /// どれだけ alloc を持ち込むかを測る。
    /// </summary>
    private async Task<BenchResult> RunBypassAsync(ScenarioPlan plan, CancellationToken ct)
    {
        var ioPerFile = (int)(plan.FileSize / plan.IoSize);

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        var allocStart = GC.GetTotalAllocatedBytes(precise: true);
        var sw = Stopwatch.StartNew();

        var workerCount = plan.FileCount * plan.QueueDepth;
        var tasks = new Task[workerCount];
        for (int f = 0; f < plan.FileCount; f++)
        {
            for (int q = 0; q < plan.QueueDepth; q++)
            {
                var startIdx = q;
                tasks[f * plan.QueueDepth + q] = Task.Run(async () =>
                {
                    for (int i = startIdx; i < ioPerFile; i += plan.QueueDepth)
                    {
                        await Task.CompletedTask.ConfigureAwait(false);
                    }
                }, ct);
            }
        }
        await Task.WhenAll(tasks).ConfigureAwait(false);
        var allocAfterWorkers = GC.GetTotalAllocatedBytes(precise: true);
        sw.Stop();
        var elapsed = sw.Elapsed;
        var allocEnd = allocAfterWorkers;

        var totalBytes = plan.TotalBytes;
        var mbps = totalBytes / 1_000_000.0 / elapsed.TotalSeconds;
        var iops = plan.IoCount / elapsed.TotalSeconds;
        var workerAlloc = allocAfterWorkers - allocStart;

        return new BenchResult(
            ScenarioName: plan.Name + " [bypass]",
            Elapsed: elapsed,
            TotalBytes: totalBytes,
            IoCount: plan.IoCount,
            MBps: mbps,
            Iops: iops,
            AllocatedBytes: allocEnd - allocStart,
            BytesPerOp: (double)(allocEnd - allocStart) / plan.IoCount,
            WorkerBytesPerOp: (double)workerAlloc / plan.IoCount,
            CleanupBytesTotal: 0);
    }
}

internal sealed record BenchResult(
    string ScenarioName,
    TimeSpan Elapsed,
    long TotalBytes,
    int IoCount,
    double MBps,
    double Iops,
    long AllocatedBytes,
    double BytesPerOp,
    double WorkerBytesPerOp,
    long CleanupBytesTotal);
