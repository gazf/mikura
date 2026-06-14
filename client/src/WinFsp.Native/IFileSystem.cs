using WinFsp.Native.Native;

namespace WinFsp.Native;

/// <summary>
/// User-mode file system 実装が override する callback 集合。<see cref="FileSystemHost"/>
/// が WinFsp dispatcher からの IRP を marshaling して各 method に分配する。
/// </summary>
/// <remarks>
/// <para>本 interface は同期 (return NTSTATUS、out 経由で結果) を提供。非同期
/// (STATUS_PENDING + <c>FspFileSystemSendResponse</c>) を使いたい backend は
/// <see cref="IAsyncFileIo"/> を併せて実装すると、Read/Write が <see cref="ValueTask{TResult}"/>
/// 経由で dispatch される。mikura の <c>BackendFileSystem</c> は HTTP backed なので
/// async path を使用。</para>
/// <para>FileContext は WinFsp side では <c>PVOID</c>、我々は <c>object?</c> として保持
/// (実装が任意の per-handle state を返してよい)。<see cref="FileSystemHost"/> が
/// GCHandle で IntPtr 化して native に渡し、Close で release する。</para>
/// </remarks>
public interface IFileSystem
{
    // ─────────────────────────────────────────────────── lifecycle hooks ────
    /// <summary>Mount 直前。VolumeParams の最終調整に使える。</summary>
    void Init(FileSystemHost host) { }
    /// <summary>Mount 完了直後。kernel-side API (Notify 等) が使えるようになる。</summary>
    void Mounted(FileSystemHost host) { }
    /// <summary>Unmount 完了後。host references の最終 cleanup 等。</summary>
    void Unmounted(FileSystemHost host) { }

    // ─────────────────────────────────────────────────── volume info ────
    int GetVolumeInfo(out ulong totalSize, out ulong freeSize, out string label);
    int SetVolumeLabel(string label, out ulong totalSize, out ulong freeSize) =>
        GetVolumeInfo(out totalSize, out freeSize, out _);

    // ─────────────────────────────────────────────────── lookup ────
    /// <summary>
    /// path → attributes + security descriptor。Create/Open 前に kernel が呼ぶ。
    /// SD は無くてもよい (mikura は null を返す)、attribute は最低 FILE_ATTRIBUTE_DIRECTORY や
    /// NORMAL の判別が必要。
    /// </summary>
    int GetSecurityByName(string fileName, out uint fileAttributes, out byte[]? securityDescriptor);

    // ─────────────────────────────────────────────────── create / open ────
    int Create(string fileName, uint createOptions, uint grantedAccess,
        uint fileAttributes, byte[]? securityDescriptor, ulong allocationSize,
        out object? fileContext, out NativeFileInfo fileInfo);
    int Open(string fileName, uint createOptions, uint grantedAccess,
        out object? fileContext, out NativeFileInfo fileInfo);
    int Overwrite(object fileContext, uint fileAttributes, bool replaceFileAttributes,
        ulong allocationSize, out NativeFileInfo fileInfo);

    // ─────────────────────────────────────────────────── I/O ────
    /// <summary>
    /// 同期 Read。buffer は kernel 提供領域への直接 Span (zero-copy)。
    /// 非同期版 (ValueTask + STATUS_PENDING) は将来別 interface で提供。
    /// </summary>
    int Read(object fileContext, Span<byte> buffer, ulong offset, out uint bytesTransferred);
    int Write(object fileContext, ReadOnlySpan<byte> buffer, ulong offset,
        bool writeToEndOfFile, bool constrainedIo,
        out uint bytesTransferred, out NativeFileInfo fileInfo);
    int Flush(object? fileContext, out NativeFileInfo fileInfo);

    // ─────────────────────────────────────────────────── metadata ────
    int GetFileInfo(object fileContext, out NativeFileInfo fileInfo);
    int SetBasicInfo(object fileContext, uint fileAttributes,
        ulong creationTime, ulong lastAccessTime, ulong lastWriteTime, ulong changeTime,
        out NativeFileInfo fileInfo);
    int SetFileSize(object fileContext, ulong newSize, bool setAllocationSize,
        out NativeFileInfo fileInfo);

    // ─────────────────────────────────────────────────── lifecycle ────
    void Cleanup(object? fileContext, string? fileName, CleanupFlags flags);
    void Close(object fileContext);

    // ─────────────────────────────────────────────────── delete / rename ────
    int CanDelete(object fileContext, string fileName);
    int Rename(object fileContext, string fileName, string newFileName, bool replaceIfExists);

    // ─────────────────────────────────────────────────── security ────
    int GetSecurity(object fileContext, out byte[]? securityDescriptor);
    int SetSecurity(object fileContext, uint securityInformation, byte[] modificationDescriptor);

    // ─────────────────────────────────────────────────── directory ────
    /// <summary>
    /// directory enumeration。pattern/marker は WinFsp が事前フィルタした結果。
    /// 各 entry は <see cref="WinFsp.Native.DirInfo"/> 形式で buffer に詰める
    /// 出力 buffer への積み込みは <see cref="DirectoryBuffer"/> ヘルパが
    /// <c>FspFileSystemAddDirInfo</c> を介して行う。
    /// </summary>
    int ReadDirectory(object fileContext, string? pattern, string? marker,
        nint buffer, uint length, out uint bytesTransferred);
}
