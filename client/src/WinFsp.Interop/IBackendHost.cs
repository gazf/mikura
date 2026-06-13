using Mikura.Core.Abstractions;

namespace WinFsp.Interop;

/// <summary>
/// Mikura.App 側から旧 <see cref="BackendFileSystemHost"/> と新
/// <see cref="BackendFileSystemHostNative"/> を統一的に扱うための interface。
/// PoC 期間中の toggle 切替えを差し替え 1 行で済ませる目的。最終的に旧 binding
/// が削除されれば本 interface も縮約 / 削除予定。
/// </summary>
public interface IBackendHost : IDisposable
{
    /// <summary>WinFsp drive を指定 mount point に bind。成功時は実 mount point を返す。</summary>
    string Mount(string mountPoint);

    /// <summary>
    /// kernel cache invalidation を発火 (WSS broadcast 受信時に呼ぶ)。
    /// 詳細は <see cref="BackendFileSystemHost.NotifyExternalChange"/> 参照。
    /// </summary>
    void NotifyExternalChange(string serverPath, ExternalChangeKind kind);

    void Unmount();
}
