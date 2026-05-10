using System.Diagnostics;
using Mikura.Core.Abstractions;

namespace Mikura.Core.Sync;

/// <summary>
/// Orchestrates initial tree hydration and applies WSS-pushed events to the
/// projection backend (ADR-021).
///
/// <para>Replaces the CfApi-driven flow: no more <c>SyncProvider</c>/
/// <c>SyncRootRegistrar</c>/local placeholder files. The "filesystem state"
/// is the in-memory tree owned by <see cref="ServerBackend"/>; this class
/// just keeps it in sync with the server.</para>
/// </summary>
public sealed class SyncEngine
{
    private readonly ServerBackend _backend;
    private readonly string _mountPoint;
    private readonly string _deviceId;
    private readonly Action<string, ExternalChangeKind>? _notifyKernelCache;

    public SyncEngine(
        ServerBackend backend,
        string mountPoint,
        string deviceId,
        Action<string, ExternalChangeKind>? notifyKernelCache = null)
    {
        _backend = backend;
        _mountPoint = mountPoint;
        _deviceId = deviceId;
        _notifyKernelCache = notifyKernelCache;
    }

    /// <summary>
    /// Re-pull /tree into the backend cache. Called at startup and from the
    /// "Sync now" tray action.
    /// </summary>
    public Task FullSyncAsync(CancellationToken ct = default) => _backend.InitializeAsync(ct);

    public async Task RunEventLoopAsync(IEventStream events, CancellationToken ct)
    {
        await foreach (var evt in events.ReadEventsAsync(ct).ConfigureAwait(false))
        {
            try
            {
                HandleEvent(evt);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"EventLoop error: {ex.Message}");
            }
        }
    }

    private void HandleEvent(ServerEvent evt)
    {
        // Defense-in-depth: server should already exclude the originator, but
        // if a regression slips through, drop self-issued file events here so
        // we don't redundantly ApplyExternalEvent + nudge the Shell.
        if (evt.OriginatorDeviceId is not null && IsSelfDevice(evt.OriginatorDeviceId)) return;

        Trace.WriteLine($"Event: {evt.Event} {evt.Path}");

        switch (evt.Event)
        {
            case "created":
            case "modified":
            {
                if (evt.Type is null) break;
                var lastModified = evt.LastModified ?? DateTime.UtcNow;
                var isDirectory = evt.Type == "directory";
                _backend.ApplyExternalEvent(evt.Event, evt.Path, evt.Size, lastModified, isDirectory);

                // FlushAndPurgeOnCleanup=false で温存している kernel data cache を、
                // 他端末由来の mutation の通知を機に明示 invalidate する。これを
                // 入れないと、別 client が同 path を書き換えても自端末の Explorer
                // が古い byte を返し続ける可能性がある。
                _notifyKernelCache?.Invoke(
                    evt.Path,
                    evt.Event == "created" ? ExternalChangeKind.Created : ExternalChangeKind.Modified);

                // Nudge Explorer to re-enumerate the affected directory so the
                // change appears without F5. WinFsp itself flushes its file info
                // cache (FileInfoTimeout=0), but the Shell view is independent.
                var localPath = ToLocalPath(evt.Path);
                if (evt.Event == "created") Shell.NotifyCreate(localPath, isDirectory);
                else Shell.NotifyUpdate(localPath);
                break;
            }

            case "deleted":
            {
                var existed = _backend.ApplyExternalEvent(
                    "deleted", evt.Path, size: 0, DateTime.UtcNow, isDirectory: false);
                if (!existed) break;
                _notifyKernelCache?.Invoke(evt.Path, ExternalChangeKind.Deleted);
                Shell.NotifyDelete(ToLocalPath(evt.Path), isDirectory: false);
                break;
            }

            case "lock_acquired":
            case "lock_released":
            {
                // Self-issued lock changes do not flip our own RO view.
                if (evt.Holder is null) break;
                if (IsSelfDevice(evt.Holder.DeviceId)) break;
                _backend.ApplyLockEvent(evt.Path, locked: evt.Event == "lock_acquired");
                Shell.NotifyUpdate(ToLocalPath(evt.Path));
                break;
            }
        }
    }

    private bool IsSelfDevice(string deviceId)
        => string.Equals(deviceId, _deviceId, StringComparison.Ordinal);

    private string ToLocalPath(string serverPath) =>
        serverPath == "/"
            ? _mountPoint
            : Path.Combine(_mountPoint, serverPath.TrimStart('/').Replace('/', Path.DirectorySeparatorChar));
}
