namespace Mikura.Core.Abstractions;

/// <summary>
/// 他端末由来の WSS broadcast を kernel cache invalidation 等に伝える際の
/// 操作種別。WinFsp 層 (BackendFileSystemHost.NotifyExternalChange) で
/// FILE_ACTION_* / FILE_NOTIFY_CHANGE_* にマッピングされる。
/// </summary>
public enum ExternalChangeKind
{
    Created,
    Modified,
    Deleted,
}
