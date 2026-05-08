using Mikura.Core.Models;

namespace Mikura.Core.Abstractions;

/// <summary>
/// Domain-shaped projection backend that <c>WinFsp.Interop.BackendFileSystem</c>
/// delegates to. Replaces the CfApi-shaped <c>ISyncCallbacks</c> (ADR-021).
///
/// <para>All callbacks are async even though WinFsp itself dispatches synchronously
/// — the adapter blocks on these tasks. This keeps the backend implementations
/// (HTTP-driven, with locks and uploads) naturally async without polluting them
/// with WinFsp constants.</para>
/// </summary>
public interface IFileSystemBackend
{
    /// <summary>Mount-time setup. Server backends typically pull /tree here.</summary>
    Task InitializeAsync(CancellationToken ct = default);

    /// <summary>
    /// 現在キャッシュされている volume stats (WinFsp GetVolumeInfo callback は
    /// 同期呼出なのでブロックしない sync getter として公開する)。値はバック
    /// グラウンドで定期更新される (実装側責務)。
    /// </summary>
    VolumeStats VolumeStats { get; }

    /// <summary>Look up metadata for <paramref name="path"/>. Null if not present.</summary>
    Task<FileEntry?> GetEntryAsync(string path, CancellationToken ct = default);

    /// <summary>Enumerate immediate children of a directory.</summary>
    Task<IReadOnlyList<FileEntry>> EnumerateAsync(string parentPath, CancellationToken ct = default);

    /// <summary>
    /// Open an existing entry. Returns null if not found. Per ADR-016, server
    /// backends acquire the per-file lock here and surface the result on the handle.
    /// </summary>
    Task<IFileHandle?> OpenAsync(string path, FileAccessIntent intent, CancellationToken ct = default);

    /// <summary>Create a new file. Returns null if denied by policy.</summary>
    Task<IFileHandle?> CreateAsync(string path, bool isDirectory, CancellationToken ct = default);

    /// <summary>
    /// Read into <paramref name="buffer"/>. Returns bytes read; 0 = EOF. Server
    /// backends fetch from the server on first read and cache per handle.
    /// </summary>
    Task<int> ReadAsync(IFileHandle handle, long offset, Memory<byte> buffer, CancellationToken ct = default);

    /// <summary>
    /// Write to the per-handle staging buffer. Returns the new file size.
    /// <paramref name="appendToEnd"/> mirrors WinFsp <c>WriteToEndOfFile</c>;
    /// <paramref name="constrainedIo"/> is the "do not extend file" hint.
    /// </summary>
    Task<long> WriteAsync(
        IFileHandle handle,
        long offset,
        ReadOnlyMemory<byte> data,
        bool appendToEnd,
        bool constrainedIo,
        CancellationToken ct = default);

    /// <summary>
    /// Resize. <paramref name="isAllocationHint"/> is true for preallocation hints
    /// that should not extend file content (mirrors WinFsp distinction).
    /// </summary>
    Task SetSizeAsync(IFileHandle handle, long newSize, bool isAllocationHint, CancellationToken ct = default);

    Task RenameAsync(string from, string to, bool replaceIfExists, CancellationToken ct = default);

    Task SetBasicInfoAsync(IFileHandle handle, FileBasicInfo info, CancellationToken ct = default);

    /// <summary>Permission check before deletion.</summary>
    Task<bool> CanDeleteAsync(IFileHandle handle, CancellationToken ct = default);

    /// <summary>
    /// Per ADR-020: write-back if <see cref="CleanupFlags.Modified"/>, release the
    /// ADR-016 lock acquired in <see cref="OpenAsync"/>. Always called before <see cref="CloseAsync"/>.
    /// </summary>
    Task CleanupAsync(IFileHandle handle, CleanupFlags flags, CancellationToken ct = default);

    /// <summary>Final handle disposal.</summary>
    Task CloseAsync(IFileHandle handle, CancellationToken ct = default);
}

/// <summary>
/// Backend-defined opaque token tying a WinFsp open to backend state
/// (lock ownership, staged write buffer, server etag, etc).
/// </summary>
public interface IFileHandle : IDisposable
{
    string Path { get; }
    bool IsDirectory { get; }

    /// <summary>Current authoritative metadata. Mutated by Write/SetSize/etc.</summary>
    FileEntry Entry { get; }
}

public enum FileAccessIntent
{
    Read,
    Write,
}

[Flags]
public enum CleanupFlags
{
    None = 0,
    Modified = 1 << 0,
    Delete = 1 << 1,
}
