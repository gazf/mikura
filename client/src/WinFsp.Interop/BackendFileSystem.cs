using System.Buffers;
using System.Collections;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;
using Fsp;
using FileInfo = Fsp.Interop.FileInfo;
using VolumeInfo = Fsp.Interop.VolumeInfo;
using DomainFileEntry = Mikura.Core.Models.FileEntry;

namespace WinFsp.Interop;

/// <summary>
/// WinFsp <see cref="FileSystemBase"/> adapter that translates kernel callbacks
/// into <see cref="IFileSystemBackend"/> calls. The body of every callback is
/// (1) check the <see cref="OnlineGate"/>, (2) delegate to the backend,
/// (3) translate the result into NTSTATUS / FileInfo (ADR-021).
///
/// <para>The backend is async; we block here because WinFsp's contract is
/// synchronous. The blocking happens on WinFsp worker threads dedicated to IRP
/// dispatch, so it does not stall any application thread.</para>
/// </summary>
public sealed class BackendFileSystem : FileSystemBase
{
    private const int AllocationUnit = 4096;

    /// <summary>STATUS_NETWORK_UNREACHABLE — analog to SMB session loss.</summary>
    private const int StatusNetworkUnreachable = unchecked((int)0xC000023C);

    /// <summary>STATUS_UNEXPECTED_IO_ERROR — backend exception の汎用フォールバック。</summary>
    private const int StatusUnexpectedIoError = unchecked((int)0xC00000E9);

    /// <summary>STATUS_OBJECT_NAME_NOT_FOUND の数値定数。Open での 404 マッピング用。</summary>
    private const int StatusObjectNotFound = unchecked((int)0xC0000034);

    /// <summary>
    /// STATUS_FILE_DELETED — handle に紐づくファイルが I/O 中に削除された。
    /// Read 中に path が消えた場合(例: Excel save dance の temp rename)に返す。
    /// kernel は handle を invalidate して retry をやめる。
    /// </summary>
    private const int StatusFileDeleted = unchecked((int)0xC0000123);

    /// <summary>STATUS_PENDING — async response パターンで callback を保留する。</summary>
    private const int StatusPending = 0x00000103;

    private readonly IFileSystemBackend _backend;
    private readonly OnlineGate _gate;
    private readonly DateTime _createdAt = DateTime.UtcNow;

    /// <summary>
    /// SendReadResponse / SendWriteResponse / Notify を呼ぶための host 参照。
    /// Mount 完了後でないと kernel 側 API は使えないので Mounted callback で取得。
    /// </summary>
    private FileSystemHost? _host;

    public BackendFileSystem(IFileSystemBackend backend, OnlineGate gate)
    {
        _backend = backend;
        _gate = gate;
    }

    public override int Init(object host0)
    {
        var host = (FileSystemHost)host0;
        host.SectorSize = AllocationUnit;
        host.SectorsPerAllocationUnit = 1;
        host.MaxComponentLength = 255;
        host.FileInfoTimeout = 1500;
        host.CaseSensitiveSearch = false;
        host.CasePreservedNames = true;
        host.UnicodeOnDisk = true;
        host.PersistentAcls = false;
        // false で固定: Cleanup callback で lock release を行うので、modify
        // 無し handle のときも必ず Cleanup を post してもらう必要がある。
        // true (= modify あり時だけ Cleanup) だと、Excel が rename 後に
        // Book1.xlsx を write open + 何も書かず close するパターンで lock が
        // Cleanup を経由せず孤児化する (実機: 1 個残る現象)。
        host.PostCleanupWhenModifiedOnly = false;
        host.PassQueryDirectoryPattern = true;
        // false にすると最後の handle が閉じても kernel cache を保持 → shell の
        // "右クリックの度に icon/version handler が file を open しなおす" 系の
        // 反復アクセスが cache hit で消える。trade-off: 他端末での mutation を
        // broadcast で知った直後でも、こちら側 kernel cache に古い byte が
        // 残り得る (FileInfoTimeout=1000 の memo data lag と同じオーダー)。
        host.FlushAndPurgeOnCleanup = false;
        host.VolumeCreationTime = (ulong)_createdAt.ToFileTimeUtc();
        host.VolumeSerialNumber = 0xCAF5;
        host.FileSystemName = "NTFS";

        // NOTE: do NOT call _backend.InitializeAsync().GetResult() here — Init
        // runs on the thread that invoked Mount (typically the UI thread). Any
        // captured SynchronizationContext inside the backend's async chain would
        // deadlock against the GetResult on that same thread. The host
        // (TrayAppContext.StartAsync) is responsible for awaiting initialization
        // before calling Mount.
        return STATUS_SUCCESS;
    }

    /// <summary>
    /// Mount 成功後 = kernel 側 API (NotifyBegin 等) を呼べる状態。Init は VolumeParams
    /// 設定専用で kernel 側 API は未稼働なので、host 参照はここで取る。
    /// </summary>
    public override int Mounted(object host0)
    {
        _host = (FileSystemHost)host0;
        return STATUS_SUCCESS;
    }

    public override void Unmounted(object host0)
    {
        _host = null;
    }

    public override int GetVolumeInfo(out VolumeInfo info)
    {
        info = default;
        // backend が cache + 背景 refresh で server statfs を反映している。
        // 高頻度呼出 (explorer の status bar 更新等) でもブロックしない。
        var stats = _backend.VolumeStats;
        info.TotalSize = (ulong)Math.Max(0, stats.TotalSize);
        info.FreeSize = (ulong)Math.Max(0, stats.FreeSize);
        return STATUS_SUCCESS;
    }

    public override int GetSecurityByName(string fileName, out uint fileAttributes, ref byte[] securityDescriptor)
    {
        fileAttributes = 0;
        if (!_gate.IsOnline) return StatusNetworkUnreachable;

        var entry = AwaitOrNull(_backend.GetEntryAsync(ToBackendPath(fileName)));
        if (entry is null) return STATUS_OBJECT_NAME_NOT_FOUND;

        fileAttributes = ToWindowsAttributes(entry);
        return STATUS_SUCCESS;
    }

    public override int Open(
        string fileName,
        uint createOptions,
        uint grantedAccess,
        out object? fileNode,
        out object? fileDesc0,
        out FileInfo fileInfo,
        out string? normalizedName)
    {
        fileNode = null;
        fileDesc0 = null;
        normalizedName = null;
        fileInfo = default;

        if (!_gate.IsOnline) return StatusNetworkUnreachable;

        var path = ToBackendPath(fileName);
        var intent = HasWriteAccess(grantedAccess) ? FileAccessIntent.Write : FileAccessIntent.Read;

        try
        {
            var handle = _backend.OpenAsync(path, intent).GetAwaiter().GetResult();
            if (handle is null) return STATUS_OBJECT_NAME_NOT_FOUND;
            fileDesc0 = handle;
            FillFileInfo(handle.Entry, out fileInfo);
            return STATUS_SUCCESS;
        }
        catch (UnauthorizedAccessException ex)
        {
            // ADR-016: lock held by another holder — surface as ACCESS_DENIED so
            // the caller's app sees "another user is editing" instead of
            // "file not found".
            System.Diagnostics.Trace.WriteLine($"[INFO] Open denied (lock conflict): {fileName}: {ex.Message}");
            return STATUS_ACCESS_DENIED;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.WriteLine($"[WARN] Open failed: {fileName}: {ex.Message}");
            return STATUS_OBJECT_NAME_NOT_FOUND;
        }
    }

    public override int Create(
        string fileName,
        uint createOptions,
        uint grantedAccess,
        uint fileAttributes,
        byte[] securityDescriptor,
        ulong allocationSize,
        out object? fileNode,
        out object? fileDesc0,
        out FileInfo fileInfo,
        out string? normalizedName)
    {
        fileNode = null;
        fileDesc0 = null;
        normalizedName = null;
        fileInfo = default;

        if (!_gate.IsOnline) return StatusNetworkUnreachable;

        var path = ToBackendPath(fileName);
        var isDir = (createOptions & FILE_DIRECTORY_FILE) != 0;

        var handle = AwaitOrNull(_backend.CreateAsync(path, isDir));
        if (handle is null) return STATUS_ACCESS_DENIED;

        fileDesc0 = handle;
        FillFileInfo(handle.Entry, out fileInfo);
        return STATUS_SUCCESS;
    }

    public override int Overwrite(
        object fileNode,
        object fileDesc0,
        uint fileAttributes,
        bool replaceFileAttributes,
        ulong allocationSize,
        out FileInfo fileInfo)
    {
        fileInfo = default;
        if (!_gate.IsOnline) return StatusNetworkUnreachable;

        var handle = (IFileHandle)fileDesc0;
        if (handle.IsDirectory) return STATUS_INVALID_DEVICE_REQUEST;

        _backend.SetSizeAsync(handle, 0, false).GetAwaiter().GetResult();
        FillFileInfo(handle.Entry, out fileInfo);
        return STATUS_SUCCESS;
    }

    public override int SetFileSize(
        object fileNode,
        object fileDesc0,
        ulong newSize,
        bool setAllocationSize,
        out FileInfo fileInfo)
    {
        fileInfo = default;
        if (!_gate.IsOnline) return StatusNetworkUnreachable;

        var handle = (IFileHandle)fileDesc0;
        if (handle.IsDirectory) return STATUS_INVALID_DEVICE_REQUEST;

        _backend.SetSizeAsync(handle, (long)newSize, setAllocationSize).GetAwaiter().GetResult();
        FillFileInfo(handle.Entry, out fileInfo);
        return STATUS_SUCCESS;
    }

    public override int Read(
        object fileNode,
        object fileDesc0,
        IntPtr buffer,
        ulong offset,
        uint length,
        out uint pBytesTransferred)
    {
        pBytesTransferred = 0;
        if (!_gate.IsOnline) return StatusNetworkUnreachable;

        var handle = (IFileHandle)fileDesc0;
        if (handle.IsDirectory) return STATUS_INVALID_DEVICE_REQUEST;

        // async response: callback は hint を取って即 StatusPending を返す。実 I/O は
        // ProcessReadAsync で進行、完了時に SendReadResponse で kernel に通知。
        // race fix: handle.EnterIo() で in-flight counter を上げ、Cleanup は
        // DrainInFlightAsync で counter ゼロまで待ち合わせる。
        var hint = _host!.GetOperationRequestHint();
        var ioToken = handle.EnterIo();
        _ = ProcessReadAsync(hint, buffer, (int)length, (long)offset, handle, ioToken);
        return StatusPending;
    }

    /// <summary>
    /// IRP buffer (unmanaged IntPtr) を UnmanagedMemoryManager で Memory&lt;byte&gt; に
    /// wrap して FileSystemBackend.ReadAsync が直接書き込む(中間 byte[] と Marshal.Copy
    /// 廃止)。寿命: SendReadResponse 呼び出しまでに mgr を Dispose する順序を厳守。
    /// ioToken は SendResponse 直後 finally で Dispose して in-flight counter を戻す。
    /// </summary>
    private async Task ProcessReadAsync(
        ulong hint, IntPtr buffer, int length, long offset,
        IFileHandle handle, IDisposable ioToken)
    {
        int status = STATUS_SUCCESS;
        int bytesRead = 0;
        try
        {
            using var mgr = new UnmanagedMemoryManager(buffer, length);
            try
            {
                bytesRead = await _backend.ReadAsync(handle, offset, mgr.Memory)
                    .ConfigureAwait(false);
            }
            catch (FileNotFoundException ex)
            {
                System.Diagnostics.Trace.WriteLine($"[INFO] Read on deleted path: {handle.Path}: {ex.Message}");
                status = StatusFileDeleted;
                bytesRead = 0;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine(
                    $"[ERROR] Read failed: {handle.Path} @{offset}+{length}: {ex.GetType().Name}: {ex.Message}");
                status = StatusUnexpectedIoError;
            }

            if (status == STATUS_SUCCESS && bytesRead <= 0)
            {
                status = STATUS_END_OF_FILE;
                bytesRead = 0;
            }
        }
        finally
        {
            // mgr の Dispose は using により completed。SendReadResponse → ioToken Dispose
            // の順で「kernel に応答 → Cleanup に handle 解放」を表現する。
            _host!.SendReadResponse(hint, status, status == STATUS_SUCCESS ? (uint)bytesRead : 0);
            ioToken.Dispose();
        }
    }

    public override int Write(
        object fileNode,
        object fileDesc0,
        IntPtr buffer,
        ulong offset,
        uint length,
        bool writeToEndOfFile,
        bool constrainedIo,
        out uint pBytesTransferred,
        out FileInfo fileInfo)
    {
        pBytesTransferred = 0;
        fileInfo = default;
        if (!_gate.IsOnline) return StatusNetworkUnreachable;

        var handle = (IFileHandle)fileDesc0;
        if (handle.IsDirectory) return STATUS_INVALID_DEVICE_REQUEST;

        // Read と同じ async response パターン。EnterIo で in-flight tracker に登録。
        var hint = _host!.GetOperationRequestHint();
        var ioToken = handle.EnterIo();
        _ = ProcessWriteAsync(hint, buffer, (int)length, (long)offset,
            writeToEndOfFile, constrainedIo, handle, ioToken);
        return StatusPending;
    }

    /// <summary>
    /// IRP buffer を ReadOnlyMemory&lt;byte&gt; として wrap して FileSystemBackend.WriteAsync に
    /// 直接読ませる。完了経路で SendWriteResponse(成功時は新 FileInfo を ref で返す)
    /// → ioToken Dispose の順で WinFsp 応答と in-flight 解放を行う。
    /// </summary>
    private async Task ProcessWriteAsync(
        ulong hint, IntPtr buffer, int length, long offset,
        bool writeToEnd, bool constrainedIo, IFileHandle handle, IDisposable ioToken)
    {
        int status = STATUS_SUCCESS;
        FileInfo infoOut = default;
        try
        {
            using var mgr = new UnmanagedMemoryManager(buffer, length);
            try
            {
                await _backend.WriteAsync(
                    handle, offset, mgr.Memory, writeToEnd, constrainedIo)
                    .ConfigureAwait(false);
                FillFileInfo(handle.Entry, out infoOut);
            }
            catch (UnauthorizedAccessException ex)
            {
                System.Diagnostics.Trace.WriteLine($"[ERROR] Write denied: {handle.Path}: {ex.Message}");
                status = STATUS_ACCESS_DENIED;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine(
                    $"[ERROR] Write failed: {handle.Path} @{offset}+{length}: {ex.GetType().Name}: {ex.Message}");
                status = StatusUnexpectedIoError;
            }
        }
        finally
        {
            _host!.SendWriteResponse(hint, status,
                status == STATUS_SUCCESS ? (uint)length : 0, ref infoOut);
            ioToken.Dispose();
        }
    }

    public override int GetFileInfo(object fileNode, object fileDesc0, out FileInfo fileInfo)
    {
        fileInfo = default;
        if (!_gate.IsOnline) return StatusNetworkUnreachable;
        FillFileInfo(((IFileHandle)fileDesc0).Entry, out fileInfo);
        return STATUS_SUCCESS;
    }

    public override int Flush(object fileNode, object fileDesc0, out FileInfo fileInfo)
    {
        if (!_gate.IsOnline)
        {
            fileInfo = default;
            return StatusNetworkUnreachable;
        }
        if (fileDesc0 is null)
        {
            fileInfo = default;
            return STATUS_SUCCESS;
        }
        FillFileInfo(((IFileHandle)fileDesc0).Entry, out fileInfo);
        return STATUS_SUCCESS;
    }

    public override int CanDelete(object fileNode, object fileDesc0, string fileName)
    {
        if (!_gate.IsOnline) return StatusNetworkUnreachable;
        var handle = (IFileHandle)fileDesc0;
        var ok = _backend.CanDeleteAsync(handle).GetAwaiter().GetResult();
        return ok ? STATUS_SUCCESS : STATUS_ACCESS_DENIED;
    }

    public override int Rename(
        object fileNode,
        object fileDesc0,
        string fileName,
        string newFileName,
        bool replaceIfExists)
    {
        if (!_gate.IsOnline) return StatusNetworkUnreachable;
        try
        {
            _backend.RenameAsync(ToBackendPath(fileName), ToBackendPath(newFileName), replaceIfExists)
                .GetAwaiter().GetResult();
            return STATUS_SUCCESS;
        }
        catch (FileNotFoundException) { return STATUS_OBJECT_NAME_NOT_FOUND; }
        catch (IOException) { return STATUS_OBJECT_NAME_COLLISION; }
    }

    public override int SetBasicInfo(
        object fileNode,
        object fileDesc0,
        uint fileAttributes,
        ulong creationTime,
        ulong lastAccessTime,
        ulong lastWriteTime,
        ulong changeTime,
        out FileInfo fileInfo)
    {
        fileInfo = default;
        if (!_gate.IsOnline) return StatusNetworkUnreachable;

        var handle = (IFileHandle)fileDesc0;
        var info = new FileBasicInfo(
            CreationTimeUtc: creationTime != 0 ? DateTime.FromFileTimeUtc((long)creationTime) : null,
            LastAccessTimeUtc: lastAccessTime != 0 ? DateTime.FromFileTimeUtc((long)lastAccessTime) : null,
            LastWriteTimeUtc: lastWriteTime != 0 ? DateTime.FromFileTimeUtc((long)lastWriteTime) : null);
        _backend.SetBasicInfoAsync(handle, info).GetAwaiter().GetResult();
        FillFileInfo(handle.Entry, out fileInfo);
        return STATUS_SUCCESS;
    }

    public override void Cleanup(object fileNode, object fileDesc0, string fileName, uint flags)
    {
        var handle = (IFileHandle)fileDesc0;
        var cleanupFlags = CleanupFlags.None;
        if ((flags & CleanupSetLastWriteTime) != 0) cleanupFlags |= CleanupFlags.Modified;
        if ((flags & CleanupSetAllocationSize) != 0) cleanupFlags |= CleanupFlags.Modified;
        if ((flags & CleanupSetArchiveBit) != 0) cleanupFlags |= CleanupFlags.Modified;
        if ((flags & CleanupDelete) != 0) cleanupFlags |= CleanupFlags.Delete;
        try
        {
            _backend.CleanupAsync(handle, cleanupFlags).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            // WinFsp Cleanup has no return path; log and swallow.
            System.Diagnostics.Trace.WriteLine($"[WARN] Cleanup failed: {handle.Path}: {ex.Message}");
        }
    }

    public override void Close(object fileNode, object fileDesc0)
    {
        var handle = (IFileHandle)fileDesc0;
        try
        {
            _backend.CloseAsync(handle).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.WriteLine($"[WARN] Close failed: {handle.Path}: {ex.Message}");
        }
        finally
        {
            handle.Dispose();
        }
    }

    public override bool ReadDirectoryEntry(
        object fileNode,
        object fileDesc0,
        string pattern,
        string marker,
        ref object? context,
        out string? fileName,
        out FileInfo fileInfo)
    {
        fileName = null;
        fileInfo = default;
        if (!_gate.IsOnline) return false;

        var handle = (IFileHandle)fileDesc0;
        if (!handle.IsDirectory) return false;

        // Cache the enumeration on the handle to give WinFsp stable continuation.
        var bag = (DirectoryEnumeration?)context;
        if (bag is null)
        {
            var children = _backend.EnumerateAsync(handle.Path).GetAwaiter().GetResult();
            bag = new DirectoryEnumeration(children);
            if (marker is not null) bag.SeekAfter(marker);
            context = bag;
        }

        if (!bag.TryAdvance(out var entry)) return false;
        fileName = entry.Name;
        FillFileInfo(entry, out fileInfo);
        return true;
    }

    /// <summary>
    /// Distinguishes write-intent opens from metadata-only / read-only opens.
    /// Windows fires <c>CreateFile</c> many times per user-visible open
    /// (shell preview, AV scan, indexer, icon overlays, properties dialog, ...);
    /// without this filter we would call <c>AcquireLockAsync</c> on every one
    /// of them. ADR-016 only requires locking against concurrent writes —
    /// readers do not need a server-side lock.
    /// </summary>
    private static bool HasWriteAccess(uint grantedAccess)
    {
        const uint FILE_WRITE_DATA = 0x0002;
        const uint FILE_APPEND_DATA = 0x0004;
        const uint FILE_WRITE_EA = 0x0010;
        const uint FILE_DELETE_CHILD = 0x0040;
        const uint FILE_WRITE_ATTRIBUTES = 0x0100;
        const uint DELETE = 0x00010000;
        const uint WRITE_DAC = 0x00040000;
        const uint WRITE_OWNER = 0x00080000;
        const uint MAXIMUM_ALLOWED = 0x02000000;
        const uint GENERIC_ALL = 0x10000000;
        const uint GENERIC_WRITE = 0x40000000;

        const uint writeMask =
            FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA |
            FILE_DELETE_CHILD | FILE_WRITE_ATTRIBUTES |
            DELETE | WRITE_DAC | WRITE_OWNER |
            MAXIMUM_ALLOWED | GENERIC_ALL | GENERIC_WRITE;

        return (grantedAccess & writeMask) != 0;
    }

    private static string ToBackendPath(string winfspPath)
    {
        if (string.IsNullOrEmpty(winfspPath) || winfspPath == "\\") return "/";
        return "/" + winfspPath.Replace('\\', '/').TrimStart('/');
    }

    private static uint ToWindowsAttributes(DomainFileEntry entry)
    {
        uint a = entry.IsDirectory
            ? (uint)System.IO.FileAttributes.Directory
            : (uint)System.IO.FileAttributes.Archive;
        if (entry.IsReadOnly) a |= (uint)System.IO.FileAttributes.ReadOnly;
        return a;
    }

    private static void FillFileInfo(DomainFileEntry entry, out FileInfo info)
    {
        info = default;
        info.FileAttributes = ToWindowsAttributes(entry);
        info.ReparseTag = 0;
        info.FileSize = entry.IsDirectory ? 0 : (ulong)Math.Max(0, entry.Size);
        info.AllocationSize = (info.FileSize + AllocationUnit - 1) / AllocationUnit * AllocationUnit;
        info.CreationTime = (ulong)entry.CreationTimeUtc.ToFileTimeUtc();
        info.LastAccessTime = (ulong)entry.LastWriteTimeUtc.ToFileTimeUtc();
        info.LastWriteTime = (ulong)entry.LastWriteTimeUtc.ToFileTimeUtc();
        info.ChangeTime = info.LastWriteTime;
        info.IndexNumber = ComputeIndexNumber(entry.Path, info.CreationTime);
        info.HardLinks = 1;
    }

    /// <summary>
    /// path と creation time を混ぜた 64-bit ID。content-based ではないが、
    /// 「同名で削除→再作成」を NTFS の MFT エントリ再割当てと同じく別 ID として扱う
    /// (creation time が変わるため)。mtime mix と違って通常の編集では ID が変わらない。
    /// rename で path が変われば ID も変わる(NTFS の MFT 永続性とは別物)が、
    /// 業務 app の path-based 操作には十分。
    /// </summary>
    private static ulong ComputeIndexNumber(ReadOnlySpan<char> path, ulong creationTime)
    {
        const ulong prime1 = 0x9E3779B185EBCA87UL;
        const ulong prime2 = 0xC2B2AE3D27D4EB4FUL;

        ReadOnlySpan<byte> data = MemoryMarshal.AsBytes(path);
        ref byte ptr = ref MemoryMarshal.GetReference(data);
        int len = data.Length;

        // path のサイズと creation time を初期値に混ぜる。同 path で生成時刻が
        // 違う(削除→再作成)場合に異なる hash 開始点になる。
        ulong hash = ((ulong)len * prime1) ^ (creationTime * prime2);
        int i = 0;

        while (i + 8 <= len)
        {
            ulong k = Unsafe.ReadUnaligned<ulong>(ref Unsafe.Add(ref ptr, i));
            hash ^= k * prime2;
            hash = BitOperations.RotateLeft(hash, 31) * prime1;
            i += 8;
        }

        while (i < len)
        {
            hash ^= (ulong)Unsafe.Add(ref ptr, i) * prime2;
            hash = BitOperations.RotateLeft(hash, 11) * prime1;
            i++;
        }

        hash ^= hash >> 33;
        hash *= prime2;
        hash ^= hash >> 29;
        return hash;
    }

    private static T? AwaitOrNull<T>(Task<T?> task) where T : class
    {
        try { return task.GetAwaiter().GetResult(); }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.WriteLine($"[WARN] backend call failed: {ex.Message}");
            return null;
        }
    }

    private sealed class DirectoryEnumeration
    {
        private readonly IReadOnlyList<DomainFileEntry> _entries;
        private int _index;

        public DirectoryEnumeration(IReadOnlyList<DomainFileEntry> entries)
        {
            _entries = entries;
            _index = 0;
        }

        public void SeekAfter(string marker)
        {
            for (var i = 0; i < _entries.Count; i++)
            {
                if (string.Equals(_entries[i].Name, marker, StringComparison.OrdinalIgnoreCase))
                {
                    _index = i + 1;
                    return;
                }
            }
            _index = _entries.Count;
        }

        public bool TryAdvance(out DomainFileEntry entry)
        {
            if (_index >= _entries.Count)
            {
                entry = null!;
                return false;
            }
            entry = _entries[_index++];
            return true;
        }
    }
}
