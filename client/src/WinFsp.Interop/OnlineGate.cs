namespace WinFsp.Interop;

/// <summary>
/// Thread-safe online/offline flag consulted by every <see cref="BackendFileSystem"/>
/// callback. When offline, all IO returns STATUS_NETWORK_UNREACHABLE so apps see
/// the SMB-equivalent "session lost" semantics that CfApi could not deliver
/// (ADR-021).
/// </summary>
public sealed class OnlineGate
{
    private volatile bool _online = true;

    public bool IsOnline => _online;

    public void Set(bool online) => _online = online;

    public void Toggle() => _online = !_online;
}
