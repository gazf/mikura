using Mikura.Core.Abstractions;
using Fsp;

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
