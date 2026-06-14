using Mikura.Core.Abstractions;
using WinFsp.Native;
using WinFsp.Native.Native;

namespace WinFsp.Interop;

/// <summary>
/// <see cref="BackendFileSystem"/> を抱えて <see cref="FileSystemHost"/> のライフサイクル
/// (Mount / Notify / Unmount) を駆動する WinFsp adapter。WinFsp 上で動く mikura の
/// 「volume host」。
/// </summary>
public sealed class BackendFileSystemHost : IDisposable
{
    private readonly BackendFileSystem _fileSystem;
    private readonly FileSystemHost _host;
    private bool _mounted;
    private string? _mountPoint;

    public BackendFileSystemHost(IFileSystemBackend backend, OnlineGate gate)
    {
        _fileSystem = new BackendFileSystem(backend, gate);
        _host = new FileSystemHost(_fileSystem);
    }

    /// <summary>
    /// 指定 mount point に WinFsp drive を bind。drive letter ("Z:") か空ディレクトリ
    /// path を渡す。失敗時は例外を投げる。
    /// <para>
    /// 環境変数 <c>MIKURA_NATIVE_THREADCOUNT</c> で WinFsp dispatcher の thread 数を
    /// 制御できる。0 (既定) = WinFsp 既定 (typically 2*CPU)、1 = serialized callback
    /// (race / 並行性の切り分け用の escape hatch、通常は 0 で十分)。
    /// </para>
    /// </summary>
    public string Mount(string mountPoint)
    {
        // path 形式 (例: C:\mikura) の場合は dir が無いと WinFsp が失敗するので先に作る。
        if (LooksLikeDirectoryPath(mountPoint) && !Directory.Exists(mountPoint))
        {
            Directory.CreateDirectory(mountPoint);
        }

        var threadCount = ParseThreadCountEnv();
        if (threadCount > 0)
        {
            System.Diagnostics.Trace.WriteLine(
                $"[INFO] WinFsp dispatcher threadCount={threadCount} (MIKURA_NATIVE_THREADCOUNT)");
        }
        _host.Mount(mountPoint, threadCount);
        _mounted = true;
        _mountPoint = mountPoint;
        return mountPoint;
    }

    private static uint ParseThreadCountEnv()
    {
        var raw = Environment.GetEnvironmentVariable("MIKURA_NATIVE_THREADCOUNT");
        if (string.IsNullOrEmpty(raw)) return 0;
        return uint.TryParse(raw, out var v) ? v : 0;
    }

    private static bool LooksLikeDirectoryPath(string mountPoint)
    {
        if (string.IsNullOrEmpty(mountPoint)) return false;
        if (mountPoint == "*") return false;
        // Drive letter forms: "Z:", "Z:\"
        if (mountPoint.Length is >= 2 and <= 3
            && char.IsLetter(mountPoint[0]) && mountPoint[1] == ':')
            return false;
        return true;
    }

    /// <summary>
    /// kernel cache invalidation を発火。WSS broadcast (created / modified / deleted)
    /// を受信した時に呼ぶ。mount 前 / unmount 後は no-op。
    /// </summary>
    public void NotifyExternalChange(string serverPath, ExternalChangeKind kind)
    {
        if (!_mounted || string.IsNullOrEmpty(serverPath)) return;

        var (action, filter) = kind switch
        {
            ExternalChangeKind.Created => (NotifyAction.Added, NotifyFilter.FileName),
            ExternalChangeKind.Deleted => (NotifyAction.Removed, NotifyFilter.FileName),
            ExternalChangeKind.Modified => (NotifyAction.Modified, NotifyFilter.LastWrite | NotifyFilter.Size),
            _ => (NotifyAction.Modified, NotifyFilter.LastWrite),
        };

        try
        {
            _host.Notify(serverPath, filter, action, timeoutMs: 1000);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.WriteLine($"[WARN] WinFsp Notify failed for {serverPath} ({kind}): {ex.Message}");
        }
    }

    public void Unmount()
    {
        if (!_mounted) return;
        _host.Unmount();
        _mounted = false;
    }

    public void Dispose()
    {
        Unmount();
        _host.Dispose();
    }
}
