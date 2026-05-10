using Mikura.Core.Abstractions;
using Fsp;
using Fsp.Interop;

namespace WinFsp.Interop;

/// <summary>
/// Owns a <see cref="FileSystemHost"/> and a <see cref="BackendFileSystem"/>;
/// the WinFsp counterpart to <c>SyncProvider</c>/<c>SyncRootRegistrar</c> in
/// the legacy CfApi stack (ADR-021).
/// </summary>
public sealed class BackendFileSystemHost : IDisposable
{
    private readonly FileSystemHost _host;
    private readonly BackendFileSystem _fileSystem;
    private bool _mounted;

    public BackendFileSystemHost(IFileSystemBackend backend, OnlineGate gate)
    {
        _fileSystem = new BackendFileSystem(backend, gate);
        _host = new FileSystemHost(_fileSystem);
    }

    /// <summary>
    /// Mounts the WinFsp drive at <paramref name="mountPoint"/>. Accepts:
    /// <list type="bullet">
    ///   <item>A drive letter like <c>"Z:"</c></item>
    ///   <item>A full path to an empty directory like <c>"C:\\mikura"</c> (created if missing)</item>
    ///   <item><c>"*"</c> for the next available drive letter</item>
    /// </list>
    /// Throws if mount fails.
    /// </summary>
    public string Mount(string mountPoint, uint debugFlags = 0)
    {
        // If the mount point looks like a directory path, make sure it exists
        // before handing it to WinFsp — the driver requires an empty existing
        // directory for path-style mounts. (Previous CfApi-era runs may have
        // deleted this directory on shutdown, see ADR-021 transition notes.)
        if (LooksLikeDirectoryPath(mountPoint) && !Directory.Exists(mountPoint))
        {
            Directory.CreateDirectory(mountPoint);
        }

        var status = _host.Mount(mountPoint, null, true, debugFlags);
        if (status < 0)
            throw new IOException($"WinFsp mount failed at {mountPoint}: 0x{status:X8}");
        _mounted = true;
        return _host.MountPoint();
    }

    private static bool LooksLikeDirectoryPath(string mountPoint)
    {
        if (string.IsNullOrEmpty(mountPoint)) return false;
        if (mountPoint == "*") return false;
        // Drive letter forms: "Z:", "Z:\"
        if (mountPoint.Length <= 3 && mountPoint.Length >= 2
            && char.IsLetter(mountPoint[0]) && mountPoint[1] == ':')
            return false;
        return true;
    }

    /// <summary>
    /// kernel cache invalidation を WinFsp 経由で kernel に伝える。WSS broadcast で
    /// 他端末由来の created / modified / deleted を受け取った時に呼ぶことで、
    /// FlushAndPurgeOnCleanup=false で温存している data cache を明示的に捨てて
    /// stale read を防ぐ。
    ///
    /// <para>WinFsp 仕様: NotifyBegin → 0..N Notify(...) → NotifyEnd の 3 段。
    /// FileName は server canonical な絶対 path (先頭スラッシュ付き) を渡す。
    /// mount 前 / unmount 後に呼ばれてしまっても安全に no-op で抜ける。</para>
    /// </summary>
    public void NotifyExternalChange(string serverPath, Mikura.Core.Abstractions.ExternalChangeKind kind)
    {
        if (!_mounted || string.IsNullOrEmpty(serverPath)) return;

        var (action, filter) = kind switch
        {
            Mikura.Core.Abstractions.ExternalChangeKind.Created => (NotifyAction.Added, NotifyFilter.ChangeFileName),
            Mikura.Core.Abstractions.ExternalChangeKind.Deleted => (NotifyAction.Removed, NotifyFilter.ChangeFileName),
            Mikura.Core.Abstractions.ExternalChangeKind.Modified => (NotifyAction.Modified, NotifyFilter.ChangeLastWrite | NotifyFilter.ChangeSize),
            _ => (NotifyAction.Modified, NotifyFilter.ChangeLastWrite),
        };

        var info = new NotifyInfo
        {
            FileName = serverPath,
            Action = action,
            Filter = filter,
        };

        try
        {
            // タイムアウトは 1 秒に設定。NotifyBegin は rename 競合があると待たされる
            // が、broadcast の流量で長時間 block されては困るので短めに切る。
            // 失敗しても一貫性が「キャッシュ寿命だけ stale」レベルに退化するだけで
            // クラッシュにはならないので、catch して握りつぶす。
            if (_host.NotifyBegin(1000) < 0) return;
            try { _host.Notify(new[] { info }); }
            finally { _host.NotifyEnd(); }
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
