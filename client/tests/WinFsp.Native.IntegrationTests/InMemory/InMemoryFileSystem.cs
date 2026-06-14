using System.Collections.Concurrent;
using WinFsp.Native;
using WinFsp.Native.Native;

namespace WinFsp.Native.IntegrationTests.InMemory;

/// <summary>
/// integration test 用の最小限 in-memory <see cref="IFileSystem"/>。
/// 1 つの root "\" + flat な file map (FileName → bytes) のみサポート。
/// directory tree / rename / security / attribute は test に必要な分だけ実装。
/// </summary>
/// <remarks>
/// production の mikura backend を mount するのは設定 (server / device id 等) が要るので、
/// 検証目的には重い。in-memory FS で「WinFsp.Native binding が IRP → callback まで
/// 正しく通せる」最低保証を取る。
/// </remarks>
internal sealed class InMemoryFileSystem : IFileSystem, IAsyncFileIo
{
    private readonly ConcurrentDictionary<string, InMemoryEntry> _entries = new(StringComparer.OrdinalIgnoreCase);
    private long _nextHandleId;

    public InMemoryFileSystem()
    {
        _entries["\\"] = new InMemoryEntry(IsDirectory: true);
    }

    public void Init(FileSystemHost host)
    {
        host.SectorSize = 4096;
        host.SectorsPerAllocationUnit = 1;
        host.MaxComponentLength = 255;
        host.CaseSensitiveSearch = false;
        host.CasePreservedNames = true;
        host.UnicodeOnDisk = true;
        host.PostCleanupWhenModifiedOnly = false;
        host.FlushAndPurgeOnCleanup = true; // integration test 中の read を必ず callback 経由にして、Bug #4 regression を検出可能に
        host.PassQueryDirectoryPattern = true;
        host.FileSystemName = "INMEM";
    }

    public int GetVolumeInfo(out ulong totalSize, out ulong freeSize, out string label)
    {
        totalSize = 1_000_000_000;
        freeSize = 500_000_000;
        label = "INMEM";
        return NtStatus.Success;
    }

    public int GetSecurityByName(string fileName, out uint fileAttributes, out byte[]? securityDescriptor)
    {
        fileAttributes = 0;
        securityDescriptor = null;
        var name = Normalize(fileName);
        if (!_entries.TryGetValue(name, out var entry)) return NtStatus.ObjectNameNotFound;
        fileAttributes = entry.IsDirectory ? 0x10u : 0x20u; // DIRECTORY / ARCHIVE
        return NtStatus.Success;
    }

    public int Create(string fileName, uint createOptions, uint grantedAccess,
        uint fileAttributes, byte[]? securityDescriptor, ulong allocationSize,
        out object? fileContext, out NativeFileInfo fileInfo)
    {
        var name = Normalize(fileName);
        var isDir = (createOptions & 0x00000001) != 0; // FILE_DIRECTORY_FILE
        var entry = _entries.GetOrAdd(name, _ => new InMemoryEntry(IsDirectory: isDir));
        fileContext = NewHandle(name, entry);
        FillFileInfo(entry, out fileInfo);
        return NtStatus.Success;
    }

    public int Open(string fileName, uint createOptions, uint grantedAccess,
        out object? fileContext, out NativeFileInfo fileInfo)
    {
        var name = Normalize(fileName);
        if (!_entries.TryGetValue(name, out var entry))
        {
            fileContext = null;
            fileInfo = default;
            return NtStatus.ObjectNameNotFound;
        }
        fileContext = NewHandle(name, entry);
        FillFileInfo(entry, out fileInfo);
        return NtStatus.Success;
    }

    public int Overwrite(object fileContext, uint fileAttributes, bool replaceFileAttributes,
        ulong allocationSize, out NativeFileInfo fileInfo)
    {
        var h = (Handle)fileContext;
        h.Entry.Data = Array.Empty<byte>();
        FillFileInfo(h.Entry, out fileInfo);
        return NtStatus.Success;
    }

    // sync I/O は never called (IAsyncFileIo を実装してるので host が async 経路を使う)
    public int Read(object fileContext, Span<byte> buffer, ulong offset, out uint bytesTransferred)
    {
        bytesTransferred = 0;
        return NtStatus.NotImplemented;
    }

    public int Write(object fileContext, ReadOnlySpan<byte> buffer, ulong offset,
        bool writeToEndOfFile, bool constrainedIo,
        out uint bytesTransferred, out NativeFileInfo fileInfo)
    {
        bytesTransferred = 0;
        fileInfo = default;
        return NtStatus.NotImplemented;
    }

    public ValueTask<ReadResult> ReadAsync(object fileContext, Memory<byte> buffer, ulong offset, CancellationToken ct)
    {
        var h = (Handle)fileContext;
        var data = h.Entry.Data;
        if ((long)offset >= data.Length) return ValueTask.FromResult(new ReadResult(NtStatus.EndOfFile, 0));
        var avail = (int)Math.Min(buffer.Length, data.Length - (long)offset);
        data.AsSpan((int)offset, avail).CopyTo(buffer.Span);
        return ValueTask.FromResult(new ReadResult(NtStatus.Success, (uint)avail));
    }

    public ValueTask<WriteResult> WriteAsync(object fileContext, ReadOnlyMemory<byte> buffer, ulong offset,
        bool writeToEndOfFile, bool constrainedIo, CancellationToken ct)
    {
        var h = (Handle)fileContext;
        var off = writeToEndOfFile ? h.Entry.Data.Length : (int)offset;
        var newLen = Math.Max(h.Entry.Data.Length, off + buffer.Length);
        if (constrainedIo && off >= h.Entry.Data.Length)
            return ValueTask.FromResult(new WriteResult(NtStatus.Success, 0, BuildFileInfo(h.Entry)));
        var grown = new byte[newLen];
        h.Entry.Data.CopyTo(grown, 0);
        buffer.Span.CopyTo(grown.AsSpan(off));
        h.Entry.Data = grown;
        return ValueTask.FromResult(new WriteResult(NtStatus.Success, (uint)buffer.Length, BuildFileInfo(h.Entry)));
    }

    public int Flush(object? fileContext, out NativeFileInfo fileInfo)
    {
        fileInfo = default;
        if (fileContext is Handle h) FillFileInfo(h.Entry, out fileInfo);
        return NtStatus.Success;
    }

    public int GetFileInfo(object fileContext, out NativeFileInfo fileInfo)
    {
        var h = (Handle)fileContext;
        FillFileInfo(h.Entry, out fileInfo);
        return NtStatus.Success;
    }

    public int SetBasicInfo(object fileContext, uint fileAttributes,
        ulong creationTime, ulong lastAccessTime, ulong lastWriteTime, ulong changeTime,
        out NativeFileInfo fileInfo)
    {
        var h = (Handle)fileContext;
        FillFileInfo(h.Entry, out fileInfo);
        return NtStatus.Success;
    }

    public int SetFileSize(object fileContext, ulong newSize, bool setAllocationSize, out NativeFileInfo fileInfo)
    {
        var h = (Handle)fileContext;
        if (!setAllocationSize)
        {
            var grown = new byte[newSize];
            var copyLen = Math.Min(h.Entry.Data.Length, (int)newSize);
            h.Entry.Data.AsSpan(0, copyLen).CopyTo(grown);
            h.Entry.Data = grown;
        }
        FillFileInfo(h.Entry, out fileInfo);
        return NtStatus.Success;
    }

    public void Cleanup(object? fileContext, string? fileName, CleanupFlags flags)
    {
        if (fileContext is not Handle h) return;
        if ((flags & CleanupFlags.Delete) != 0)
            _entries.TryRemove(h.Name, out _);
    }

    public void Close(object fileContext) { /* nothing to drop */ }

    public int CanDelete(object fileContext, string fileName) => NtStatus.Success;

    public int Rename(object fileContext, string fileName, string newFileName, bool replaceIfExists)
    {
        var src = Normalize(fileName);
        var dst = Normalize(newFileName);
        if (!_entries.TryRemove(src, out var entry)) return NtStatus.ObjectNameNotFound;
        _entries[dst] = entry;
        if (fileContext is Handle h) h.Name = dst;
        return NtStatus.Success;
    }

    public int GetSecurity(object fileContext, out byte[]? securityDescriptor)
    {
        securityDescriptor = null;
        return NtStatus.Success;
    }

    public int SetSecurity(object fileContext, uint securityInformation, byte[] modificationDescriptor)
        => NtStatus.Success;

    public int ReadDirectory(object fileContext, string? pattern, string? marker,
        nint buffer, uint length, out uint bytesTransferred)
    {
        var h = (Handle)fileContext;
        var prefix = h.Name.EndsWith('\\') ? h.Name : h.Name + "\\";
        var children = _entries.Keys
            .Where(k => k != h.Name
                && k.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                && !k.AsSpan(prefix.Length).Contains('\\'))
            .OrderBy(k => k, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var db = new DirectoryBuffer(buffer, length);
        var skipUntilMarker = !string.IsNullOrEmpty(marker);
        foreach (var key in children)
        {
            var childName = key[prefix.Length..];
            if (skipUntilMarker)
            {
                if (string.Equals(childName, marker, StringComparison.OrdinalIgnoreCase))
                    skipUntilMarker = false;
                continue;
            }
            FillFileInfo(_entries[key], out var info);
            if (!db.TryAdd(childName, in info))
            {
                bytesTransferred = db.BytesTransferred;
                return NtStatus.Success;
            }
        }
        db.MarkEnd();
        bytesTransferred = db.BytesTransferred;
        return NtStatus.Success;
    }

    private Handle NewHandle(string name, InMemoryEntry entry) =>
        new(Interlocked.Increment(ref _nextHandleId), name, entry);

    private static string Normalize(string p) =>
        string.IsNullOrEmpty(p) ? "\\" : (p.StartsWith('\\') ? p : "\\" + p);

    private static NativeFileInfo BuildFileInfo(InMemoryEntry entry)
    {
        FillFileInfo(entry, out var info);
        return info;
    }

    private static void FillFileInfo(InMemoryEntry entry, out NativeFileInfo info)
    {
        info = default;
        info.FileAttributes = entry.IsDirectory ? 0x10u : 0x20u;
        info.FileSize = entry.IsDirectory ? 0 : (ulong)entry.Data.Length;
        info.AllocationSize = (info.FileSize + 4095) / 4096 * 4096;
        info.CreationTime = (ulong)entry.CreatedAt.ToFileTimeUtc();
        info.LastAccessTime = (ulong)entry.CreatedAt.ToFileTimeUtc();
        info.LastWriteTime = (ulong)entry.CreatedAt.ToFileTimeUtc();
        info.ChangeTime = info.LastWriteTime;
        info.IndexNumber = 0;
        info.HardLinks = 1;
    }

    internal sealed class InMemoryEntry
    {
        public bool IsDirectory { get; }
        public byte[] Data { get; set; } = Array.Empty<byte>();
        public DateTime CreatedAt { get; } = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        public InMemoryEntry(bool IsDirectory) { this.IsDirectory = IsDirectory; }
    }

    internal sealed class Handle
    {
        public long Id { get; }
        public string Name { get; set; }
        public InMemoryEntry Entry { get; }
        public Handle(long id, string name, InMemoryEntry entry)
        {
            Id = id; Name = name; Entry = entry;
        }
    }
}
