using System.Diagnostics;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;
using WinFsp.Native;
using WinFsp.Native.Native;
using DomainFileEntry = Mikura.Core.Models.FileEntry;
// CleanupFlags は WinFsp.Native (kernel flags) と Mikura.Core.Abstractions (domain) で
// 同名なので、Cleanup callback の引数型は明示的に WinFsp.Native 側を指定する。
using NativeCleanupFlags = WinFsp.Native.CleanupFlags;
using DomainCleanupFlags = Mikura.Core.Abstractions.CleanupFlags;

namespace WinFsp.Interop;

/// <summary>
/// mikura の <see cref="IFileSystemBackend"/> を WinFsp の <see cref="IFileSystem"/> +
/// <see cref="IAsyncFileIo"/> 表現に変換する adapter。<see cref="FileSystemHost"/>
/// が WinFsp dispatcher から受けた IRP callback をここに dispatch し、domain async API
/// (Mikura.Core) に橋渡しする。
/// </summary>
/// <remarks>
/// <para>設計:
///   - <see cref="IAsyncFileIo"/> 経由で Read / Write は <see cref="ValueTask{TResult}"/>
///     を返す。<see cref="FileSystemHost"/> 側で即完了なら sync 経路、非同期 (HTTP I/O 等)
///     なら <c>STATUS_PENDING</c> + <c>FspFileSystemSendResponse</c> で完了通知。
///   - <see cref="ReadDirectory"/> は 1 callback 内で <see cref="DirectoryBuffer"/> に全
///     entry を積む。buffer 不足は marker で続きを kernel が要求してくる。
///   - <see cref="OnlineGate"/> off の間は全 callback が <see cref="NtStatus.NetworkUnreachable"/>
///     を返し、SMB 相当の "session lost" semantics を実現 (ADR-021)。
///   - Cleanup フラグ → domain <c>CleanupFlags</c> の mapping、HasWriteAccess の
///     intent 分類等の責務は <c>WinFsp.Interop.Tests.BackendFileSystemTests</c> で固定。
/// </para>
/// </remarks>
public sealed class BackendFileSystem : IFileSystem, IAsyncFileIo
{
    private const int AllocationUnit = 4096;

    // FILE_DIRECTORY_FILE: kernel/CreateOptions の bit。createOptions に立っていれば
    // ディレクトリ作成と判定 (Windows DDK 定義値)。
    private const uint FileDirectoryFile = 0x00000001;

    private readonly IFileSystemBackend _backend;
    private readonly OnlineGate _gate;
    private readonly DateTime _createdAt = DateTime.UtcNow;
    private FileSystemHost? _host;

    // OS 層 (Explorer / Shell) に返す security descriptor の placeholder。
    // mikura の本物の認可は server `checkPermission` 経由で実施するので、
    // ここでは「誰でも Full Access」な SDDL を 1 回だけ binary 化して全 entry
    // で共有する。これが無いと Explorer の AccessCheck が `ERROR_INVALID_SECURITY_DESCR`
    // (1338) を吐き、「新規作成」メニューが folder 1 項目に退化したり UAC 盾が
    // 貼られる (PowerShell `Get-Acl Z:\` も同 1338 で失敗する)。
    //
    // Lazy 化の理由: SDDL→byte[] 変換は advapi32 (Windows 専用)。BackendFileSystem は
    // Linux 上の dotnet test でも instantiate される (Offline gate / Cleanup flag
    // mapping 等の純 managed テスト) ため、static field eager init にすると Linux で
    // 全テストが TypeInitializationException で爆死する。実際に GetSecurity が
    // 呼ばれるのは WinFsp host 経由の Windows 上だけなので、最初の callback で
    // 評価して以後 cache する。
    private static readonly Lazy<byte[]> _defaultSd = new(
        () => SecurityDescriptors.FromSddl(SecurityDescriptors.EveryoneFullAccessSddl),
        LazyThreadSafetyMode.ExecutionAndPublication);

    // race 切り分け用の詳細ログ。env MIKURA_NATIVE_TRACE=1 で有効化。
    // Open / Cleanup / Close の入口で thread + handle path + flags を打つ。
    private static readonly bool _trace =
        string.Equals(Environment.GetEnvironmentVariable("MIKURA_NATIVE_TRACE"), "1",
            StringComparison.Ordinal);

    public BackendFileSystem(IFileSystemBackend backend, OnlineGate gate)
    {
        _backend = backend;
        _gate = gate;
    }

    /// <summary>Mount 後に <see cref="FileSystemHost.Notify"/> 等の kernel-side API を使うために露出。</summary>
    public FileSystemHost? Host => _host;

    // ─────────────────────────────────────── lifecycle ────
    public void Init(FileSystemHost host)
    {
        host.SectorSize = AllocationUnit;
        host.SectorsPerAllocationUnit = 1;
        host.MaxComponentLength = 255;
        host.FileInfoTimeout = 1500;
        host.CaseSensitiveSearch = false;
        host.CasePreservedNames = true;
        host.UnicodeOnDisk = true;
        host.PersistentAcls = false;
        // false で固定: Cleanup callback で lock release を行うので、modify
        // 無し handle のときも必ず Cleanup を post してもらう必要がある (旧版コメント踏襲)。
        host.PostCleanupWhenModifiedOnly = false;
        host.PassQueryDirectoryPattern = true;
        // false で kernel cache を保持。shell の反復アクセスが cache hit で消える
        // (旧版コメント踏襲)。
        host.FlushAndPurgeOnCleanup = false;
        host.VolumeCreationTime = (ulong)_createdAt.ToFileTimeUtc();
        host.VolumeSerialNumber = 0xCAF5;
        host.FileSystemName = "NTFS";
    }

    public void Mounted(FileSystemHost host) => _host = host;
    public void Unmounted(FileSystemHost host) => _host = null;

    // ─────────────────────────────────────── volume ────
    public int GetVolumeInfo(out ulong totalSize, out ulong freeSize, out string label)
    {
        var stats = _backend.VolumeStats;
        totalSize = (ulong)Math.Max(0, stats.TotalSize);
        freeSize = (ulong)Math.Max(0, stats.FreeSize);
        label = "";
        return NtStatus.Success;
    }

    // ─────────────────────────────────────── lookup ────
    public int GetSecurityByName(string fileName, out uint fileAttributes, out byte[]? securityDescriptor)
    {
        fileAttributes = 0;
        securityDescriptor = null;
        if (!_gate.IsOnline) return NtStatus.NetworkUnreachable;

        var entry = AwaitOrNull(_backend.GetEntryAsync(ToBackendPath(fileName)));
        if (entry is null) return NtStatus.ObjectNameNotFound;

        fileAttributes = ToWindowsAttributes(entry);
        securityDescriptor = _defaultSd.Value;
        return NtStatus.Success;
    }

    // ─────────────────────────────────────── create / open ────
    public int Open(string fileName, uint createOptions, uint grantedAccess,
        out object? fileContext, out NativeFileInfo fileInfo)
    {
        fileContext = null;
        fileInfo = default;
        if (!_gate.IsOnline) return NtStatus.NetworkUnreachable;

        var path = ToBackendPath(fileName);
        var intent = HasWriteAccess(grantedAccess) ? FileAccessIntent.Write : FileAccessIntent.Read;
        if (_trace)
            Trace.WriteLine($"[trace] Open tid={Environment.CurrentManagedThreadId} path={path} access=0x{grantedAccess:X8} intent={intent}");

        try
        {
            var handle = _backend.OpenAsync(path, intent).GetAwaiter().GetResult();
            if (handle is null) return NtStatus.ObjectNameNotFound;
            fileContext = handle;
            FillFileInfo(handle.Entry, out fileInfo);
            return NtStatus.Success;
        }
        catch (UnauthorizedAccessException ex)
        {
            Trace.WriteLine($"[INFO] Open denied (lock conflict): {fileName}: {ex.Message}");
            return NtStatus.AccessDenied;
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[WARN] Open failed: {fileName}: {ex.Message}");
            return NtStatus.ObjectNameNotFound;
        }
    }

    public int Create(string fileName, uint createOptions, uint grantedAccess,
        uint fileAttributes, byte[]? securityDescriptor, ulong allocationSize,
        out object? fileContext, out NativeFileInfo fileInfo)
    {
        fileContext = null;
        fileInfo = default;
        if (!_gate.IsOnline) return NtStatus.NetworkUnreachable;

        var path = ToBackendPath(fileName);
        var isDir = (createOptions & FileDirectoryFile) != 0;

        var handle = AwaitOrNull(_backend.CreateAsync(path, isDir));
        if (handle is null) return NtStatus.AccessDenied;
        fileContext = handle;
        FillFileInfo(handle.Entry, out fileInfo);
        return NtStatus.Success;
    }

    public int Overwrite(object fileContext, uint fileAttributes, bool replaceFileAttributes,
        ulong allocationSize, out NativeFileInfo fileInfo)
    {
        fileInfo = default;
        if (!_gate.IsOnline) return NtStatus.NetworkUnreachable;

        var handle = (IFileHandle)fileContext;
        if (handle.IsDirectory) return NtStatus.InvalidDeviceRequest;

        _backend.SetSizeAsync(handle, 0, false).GetAwaiter().GetResult();
        FillFileInfo(handle.Entry, out fileInfo);
        return NtStatus.Success;
    }

    // ─────────────────────────────────────── I/O (async) ────
    /// <summary>sync Read は IAsyncFileIo 経路に dispatch されるはずなので呼ばれない。</summary>
    public int Read(object fileContext, Span<byte> buffer, ulong offset, out uint bytesTransferred)
    {
        bytesTransferred = 0;
        return NtStatus.NotImplemented;
    }

    /// <summary>sync Write も同上、async path を使う。</summary>
    public int Write(object fileContext, ReadOnlySpan<byte> buffer, ulong offset,
        bool writeToEndOfFile, bool constrainedIo,
        out uint bytesTransferred, out NativeFileInfo fileInfo)
    {
        bytesTransferred = 0;
        fileInfo = default;
        return NtStatus.NotImplemented;
    }

    public async ValueTask<ReadResult> ReadAsync(object fileContext, Memory<byte> buffer, ulong offset, CancellationToken ct)
    {
        if (!_gate.IsOnline) return new ReadResult(NtStatus.NetworkUnreachable, 0);

        var handle = (IFileHandle)fileContext;
        if (handle.IsDirectory) return new ReadResult(NtStatus.InvalidDeviceRequest, 0);

        using var ioToken = handle.EnterIo();
        try
        {
            var bytesRead = await _backend.ReadAsync(handle, (long)offset, buffer, ct).ConfigureAwait(false);
            if (bytesRead <= 0) return new ReadResult(NtStatus.EndOfFile, 0);
            return new ReadResult(NtStatus.Success, (uint)bytesRead);
        }
        catch (FileNotFoundException ex)
        {
            Trace.WriteLine($"[INFO] Read on deleted path: {handle.Path}: {ex.Message}");
            return new ReadResult(NtStatus.FileDeleted, 0);
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[ERROR] Read failed: {handle.Path} @{offset}+{buffer.Length}: {ex.GetType().Name}: {ex.Message}");
            return new ReadResult(NtStatus.Unsuccessful, 0);
        }
    }

    public async ValueTask<WriteResult> WriteAsync(object fileContext, ReadOnlyMemory<byte> buffer, ulong offset,
        bool writeToEndOfFile, bool constrainedIo, CancellationToken ct)
    {
        if (!_gate.IsOnline) return new WriteResult(NtStatus.NetworkUnreachable, 0, default);

        var handle = (IFileHandle)fileContext;
        if (handle.IsDirectory) return new WriteResult(NtStatus.InvalidDeviceRequest, 0, default);

        using var ioToken = handle.EnterIo();
        try
        {
            await _backend.WriteAsync(handle, (long)offset, buffer, writeToEndOfFile, constrainedIo, ct)
                .ConfigureAwait(false);
            FillFileInfo(handle.Entry, out var info);
            return new WriteResult(NtStatus.Success, (uint)buffer.Length, info);
        }
        catch (UnauthorizedAccessException ex)
        {
            Trace.WriteLine($"[ERROR] Write denied: {handle.Path}: {ex.Message}");
            return new WriteResult(NtStatus.AccessDenied, 0, default);
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[ERROR] Write failed: {handle.Path} @{offset}+{buffer.Length}: {ex.GetType().Name}: {ex.Message}");
            return new WriteResult(NtStatus.Unsuccessful, 0, default);
        }
    }

    public int Flush(object? fileContext, out NativeFileInfo fileInfo)
    {
        if (!_gate.IsOnline) { fileInfo = default; return NtStatus.NetworkUnreachable; }
        if (fileContext is null) { fileInfo = default; return NtStatus.Success; }
        FillFileInfo(((IFileHandle)fileContext).Entry, out fileInfo);
        return NtStatus.Success;
    }

    // ─────────────────────────────────────── metadata ────
    public int GetFileInfo(object fileContext, out NativeFileInfo fileInfo)
    {
        if (!_gate.IsOnline) { fileInfo = default; return NtStatus.NetworkUnreachable; }
        FillFileInfo(((IFileHandle)fileContext).Entry, out fileInfo);
        return NtStatus.Success;
    }

    public int SetBasicInfo(object fileContext, uint fileAttributes,
        ulong creationTime, ulong lastAccessTime, ulong lastWriteTime, ulong changeTime,
        out NativeFileInfo fileInfo)
    {
        fileInfo = default;
        if (!_gate.IsOnline) return NtStatus.NetworkUnreachable;

        var handle = (IFileHandle)fileContext;
        var info = new FileBasicInfo(
            CreationTimeUtc: creationTime != 0 ? DateTime.FromFileTimeUtc((long)creationTime) : null,
            LastAccessTimeUtc: lastAccessTime != 0 ? DateTime.FromFileTimeUtc((long)lastAccessTime) : null,
            LastWriteTimeUtc: lastWriteTime != 0 ? DateTime.FromFileTimeUtc((long)lastWriteTime) : null);
        _backend.SetBasicInfoAsync(handle, info).GetAwaiter().GetResult();
        FillFileInfo(handle.Entry, out fileInfo);
        return NtStatus.Success;
    }

    public int SetFileSize(object fileContext, ulong newSize, bool setAllocationSize,
        out NativeFileInfo fileInfo)
    {
        fileInfo = default;
        if (!_gate.IsOnline) return NtStatus.NetworkUnreachable;

        var handle = (IFileHandle)fileContext;
        if (handle.IsDirectory) return NtStatus.InvalidDeviceRequest;

        _backend.SetSizeAsync(handle, (long)newSize, setAllocationSize).GetAwaiter().GetResult();
        FillFileInfo(handle.Entry, out fileInfo);
        return NtStatus.Success;
    }

    // ─────────────────────────────────────── lifecycle (file) ────
    public void Cleanup(object? fileContext, string? fileName, NativeCleanupFlags flags)
    {
        if (fileContext is not IFileHandle handle) return;

        var cf = DomainCleanupFlags.None;
        if ((flags & NativeCleanupFlags.SetLastWriteTime) != 0) cf |= DomainCleanupFlags.Modified;
        if ((flags & NativeCleanupFlags.SetAllocationSize) != 0) cf |= DomainCleanupFlags.Modified;
        if ((flags & NativeCleanupFlags.SetArchiveBit) != 0) cf |= DomainCleanupFlags.Modified;
        if ((flags & NativeCleanupFlags.Delete) != 0) cf |= DomainCleanupFlags.Delete;
        if (_trace)
            Trace.WriteLine($"[trace] Cleanup tid={Environment.CurrentManagedThreadId} path={handle.Path} winflags=0x{(uint)flags:X} cf={cf}");
        try
        {
            _backend.CleanupAsync(handle, cf).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[WARN] Cleanup failed: {handle.Path}: {ex.Message}");
        }
    }

    public void Close(object fileContext)
    {
        // GCHandle slot 再利用 defence: stale な fileContext で別 type が来たら静かに抜ける。
        // WinFsp が Close 後の遅延 callback で同じ nint を再送した場合、GCHandle 経由で別の
        // managed object (実機: System.Threading.Thread が観測された) が返ってくる事がある。
        // 直接 cast すると InvalidCastException → UnmanagedCallersOnly callback で例外 →
        // catch があっても native 側に伝播し最悪 process 終了。
        if (fileContext is not IFileHandle handle)
        {
            Trace.WriteLine($"[ERROR] Close got non-IFileHandle ({fileContext?.GetType().Name ?? "null"}) — stale fileContext, ignoring");
            return;
        }
        if (_trace)
            Trace.WriteLine($"[trace] Close tid={Environment.CurrentManagedThreadId} path={handle.Path}");
        try
        {
            _backend.CloseAsync(handle).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[WARN] Close failed: {handle.Path}: {ex.Message}");
        }
        finally
        {
            handle.Dispose();
        }
    }

    // ─────────────────────────────────────── delete / rename ────
    public int CanDelete(object fileContext, string fileName)
    {
        if (!_gate.IsOnline) return NtStatus.NetworkUnreachable;
        var handle = (IFileHandle)fileContext;
        var ok = _backend.CanDeleteAsync(handle).GetAwaiter().GetResult();
        return ok ? NtStatus.Success : NtStatus.AccessDenied;
    }

    public int Rename(object fileContext, string fileName, string newFileName, bool replaceIfExists)
    {
        if (!_gate.IsOnline) return NtStatus.NetworkUnreachable;
        try
        {
            _backend.RenameAsync(ToBackendPath(fileName), ToBackendPath(newFileName), replaceIfExists)
                .GetAwaiter().GetResult();
            return NtStatus.Success;
        }
        catch (FileNotFoundException) { return NtStatus.ObjectNameNotFound; }
        catch (IOException) { return NtStatus.ObjectNameCollision; }
    }

    // ─────────────────────────────────────── security ────
    public int GetSecurity(object fileContext, out byte[]? securityDescriptor)
    {
        // mikura の認可は server 側 (REST 401/403) で行うので、ここは Explorer の
        // AccessCheck を通すための placeholder SD を返す (null は無効扱いで
        // ERROR_INVALID_SECURITY_DESCR の原因)。詳細は _defaultSd の comment 参照。
        securityDescriptor = _defaultSd.Value;
        return NtStatus.Success;
    }

    public int SetSecurity(object fileContext, uint securityInformation, byte[] modificationDescriptor)
    {
        // 同上、no-op で success (kernel 側 cache 反映を妨げないため)。
        return NtStatus.Success;
    }

    // ─────────────────────────────────────── directory enumeration ────
    public int ReadDirectory(object fileContext, string? pattern, string? marker,
        nint buffer, uint length, out uint bytesTransferred)
    {
        bytesTransferred = 0;
        if (!_gate.IsOnline) return NtStatus.NetworkUnreachable;

        var handle = (IFileHandle)fileContext;
        if (!handle.IsDirectory) return NtStatus.InvalidDeviceRequest;

        // 旧版は ReadDirectoryEntry の per-entry override で、call 間の context を
        // ref object? に貯める形だったが、新版は 1 call で全 entry を積むので
        // enumeration を都度 backend から取り直す (1 directory open あたり数回程度)。
        IReadOnlyList<DomainFileEntry> children;
        try
        {
            children = _backend.EnumerateAsync(handle.Path).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[WARN] Enumerate failed: {handle.Path}: {ex.Message}");
            return NtStatus.Unsuccessful;
        }

        var db = new DirectoryBuffer(buffer, length);
        var skipUntilMarker = !string.IsNullOrEmpty(marker);
        foreach (var entry in children)
        {
            if (skipUntilMarker)
            {
                if (string.Equals(entry.Name, marker, StringComparison.OrdinalIgnoreCase))
                    skipUntilMarker = false;
                continue;
            }
            FillFileInfo(entry, out var info);
            if (!db.TryAdd(entry.Name, in info))
            {
                // buffer 容量切れ。caller (kernel) は次回 marker 付きで続きを取りに来る。
                bytesTransferred = db.BytesTransferred;
                return NtStatus.Success;
            }
        }
        db.MarkEnd();
        bytesTransferred = db.BytesTransferred;
        return NtStatus.Success;
    }

    // ─────────────────────────────────────── helpers ────
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

    private static void FillFileInfo(DomainFileEntry entry, out NativeFileInfo info)
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
    /// 旧 BackendFileSystem.ComputeIndexNumber と同じハッシュ式 (path + creation time)。
    /// path 削除→再作成で異なる ID、通常編集では同 ID。
    /// </summary>
    private static ulong ComputeIndexNumber(ReadOnlySpan<char> path, ulong creationTime)
    {
        const ulong prime1 = 0x9E3779B185EBCA87UL;
        const ulong prime2 = 0xC2B2AE3D27D4EB4FUL;

        ReadOnlySpan<byte> data = MemoryMarshal.AsBytes(path);
        ref byte ptr = ref MemoryMarshal.GetReference(data);
        int len = data.Length;

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
            Trace.WriteLine($"[WARN] backend call failed: {ex.Message}");
            return null;
        }
    }
}
