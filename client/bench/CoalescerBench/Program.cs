using System.Net;
using System.Net.Http.Headers;
using Mikura.Bench.Coalescer;
using Mikura.Core.Abstractions;
using Mikura.Transport;

// CLI:
//   --backend=fake|http (default fake)
//   --url=<base url>     (http mode)
//   --token=<bearer>     (http mode)
//   --device=<id>        (http mode, default "bench-dev01")
//   --scenario=seq1m|seq128k|rnd4kdeep|rnd4kshallow|all (default all)
//   --size-mb=<int>      per-file bytes (default 64 for SEQ, 16 for RND)
//   --warmup=<int>       skipped iterations (default 1)
//   --iters=<int>        measured iterations (default 3)

var argv = Args.Parse(args);
var backendKind = argv.Get("backend", "fake");
var scenarioArg = argv.Get("scenario", "all");
var warmup = int.Parse(argv.Get("warmup", "1"));
var iters = int.Parse(argv.Get("iters", "3"));
// --bypass-backend: ServerBackend / WriteCoalescer を経由しない harness baseline
// 計測。各シナリオの "[bypass]" 行を追加で出力して per-IO alloc の harness 寄与を
// 分離する。
var bypassBackend = argv.Get("bypass-backend", "false") == "true";

IServerApi BuildApi()
{
    switch (backendKind)
    {
        case "fake":
            return new NoOpServerApi();

        case "http":
            var url = argv.Get("url", "http://localhost:8700");
            var token = argv.Get("token", "")
                ?? throw new InvalidOperationException("--token required for http backend");
            if (string.IsNullOrWhiteSpace(token))
                throw new InvalidOperationException("--token required for http backend");
            var deviceId = argv.Get("device", "bench-device-coalescer-01");
            var handler = new SocketsHttpHandler
            {
                AllowAutoRedirect = false,
                AutomaticDecompression = DecompressionMethods.None,
                MaxConnectionsPerServer = 16,
            };
            var http = new HttpClient(handler)
            {
                BaseAddress = new Uri(url),
                Timeout = TimeSpan.FromMinutes(5),
            };
            http.DefaultRequestHeaders.Authorization =
                new AuthenticationHeaderValue("Bearer", token);
            http.DefaultRequestHeaders.Add("X-Device-Id", deviceId);
            return new HttpServerApi(http, url);

        default:
            throw new ArgumentException($"unknown backend: {backendKind}");
    }
}

var kinds = scenarioArg switch
{
    "all" => new[]
    {
        ScenarioKind.Seq1M, ScenarioKind.Seq128K,
        ScenarioKind.Rnd4KDeep, ScenarioKind.Rnd4KShallow,
    },
    "seq1m" => new[] { ScenarioKind.Seq1M },
    "seq128k" => new[] { ScenarioKind.Seq128K },
    "rnd4kdeep" => new[] { ScenarioKind.Rnd4KDeep },
    "rnd4kshallow" => new[] { ScenarioKind.Rnd4KShallow },
    // alloc/op の (Q, T) 依存を直交分解する scaling sweep。
    "rnd4k-scaling" => new[]
    {
        ScenarioKind.Rnd4KQ1T1, ScenarioKind.Rnd4KQ32T1,
        ScenarioKind.Rnd4KQ1T16, ScenarioKind.Rnd4KQ32T16,
    },
    _ => throw new ArgumentException($"unknown scenario: {scenarioArg}"),
};

Console.WriteLine($"# CoalescerBench backend={backendKind} warmup={warmup} iters={iters}");
Console.WriteLine($"# {DateTime.UtcNow:o}  runtime={Environment.Version}  cores={Environment.ProcessorCount}");
Console.WriteLine();
Console.WriteLine("scenario             |   MB/s |   iops | elapsed | alloc/op (work+clean) | cleanup tot");
Console.WriteLine("--------------------- -------- -------- --------- ---------------------- -------------");

foreach (var kind in kinds)
{
    // SEQ 系は 64MB、RND 系 (Q/T scaling 含む) は 16MB をデフォルトとする
    // (RND は IOPS 観点で 16MB あれば十分大量に IRP が走る)。
    var sizeMb = int.Parse(argv.Get("size-mb",
        kind is ScenarioKind.Seq1M or ScenarioKind.Seq128K ? "64" : "16"));
    var plan = ScenarioPlan.ForKind(kind, (long)sizeMb * 1024 * 1024);

    for (int w = 0; w < warmup; w++)
    {
        var api = BuildApi();
        try { await new Harness(api, bypassBackend).RunAsync(plan); }
        finally { (api as IDisposable)?.Dispose(); }
    }

    var samples = new List<BenchResult>(iters);
    for (int i = 0; i < iters; i++)
    {
        var api = BuildApi();
        try { samples.Add(await new Harness(api, bypassBackend).RunAsync(plan)); }
        finally { (api as IDisposable)?.Dispose(); }
    }

    // 中央値 (sort して mid index) — 平均より外れ値耐性が高い。
    samples.Sort((a, b) => a.MBps.CompareTo(b.MBps));
    var med = samples[samples.Count / 2];
    Console.WriteLine(
        $"{plan.Name,-20} | {med.MBps,6:F1} | {med.Iops,6:F0} | {med.Elapsed.TotalMilliseconds,6:F1}ms | {med.BytesPerOp,5:F0}B ({med.WorkerBytesPerOp,5:F0}+{med.BytesPerOp - med.WorkerBytesPerOp,4:F0}) | {FormatBytes(med.CleanupBytesTotal),11}");
}

static string FormatBytes(long b)
{
    if (b < 1024) return $"{b} B";
    if (b < 1024 * 1024) return $"{b / 1024.0:F1} KiB";
    if (b < 1024L * 1024 * 1024) return $"{b / (1024.0 * 1024):F1} MiB";
    return $"{b / (1024.0 * 1024 * 1024):F2} GiB";
}

internal sealed class Args
{
    private readonly Dictionary<string, string> _map;
    private Args(Dictionary<string, string> map) { _map = map; }

    public static Args Parse(string[] argv)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var a in argv)
        {
            if (!a.StartsWith("--")) continue;
            var eq = a.IndexOf('=');
            if (eq < 0) { map[a[2..]] = "true"; continue; }
            map[a[2..eq]] = a[(eq + 1)..];
        }
        return new Args(map);
    }

    public string Get(string key, string fallback) =>
        _map.TryGetValue(key, out var v) ? v : fallback;
}
