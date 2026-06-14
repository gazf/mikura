using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace WinFsp.Interop.Tests.Fakes;

/// <summary>
/// <see cref="BackendFileSystem"/> テスト用の手書き <see cref="IFileSystemBackend"/>
/// fake。Moq だと open / cleanup / write の組合せが stateful になって setup が読みにくいので、
/// state + call counter + toggle を素直に持つ実体クラスにする
/// (既存 <c>FakeServerApi</c> と同じパターン)。
/// </summary>
/// <remarks>
/// fake が表現する世界:
///   - 各 path に対する <see cref="FileEntry"/> の dict (server tree 相当)
///   - 開いた handle の List (Open / Create で append、Cleanup/Close は handle に状態を残す)
///   - Open/Create/Read/Write/Cleanup/Close 等の呼出回数 counter
///   - 振る舞いを切り替える toggle (例: <see cref="DenyOpen"/>, <see cref="OnlineGateOff"/> 等)
/// </remarks>
internal sealed class FakeFileSystemBackend : IFileSystemBackend
{
    public Dictionary<string, FileEntry> Tree { get; } = new(StringComparer.OrdinalIgnoreCase);
    public List<FakeHandle> OpenedHandles { get; } = new();

    public int OpenCalls;
    public int CreateCalls;
    public int ReadCalls;
    public int WriteCalls;
    public int CleanupCalls;
    public int CloseCalls;
    public int SetSizeCalls;
    public int SetBasicInfoCalls;
    public int CanDeleteCalls;
    public int RenameCalls;
    public int EnumerateCalls;

    public List<(string Path, FileAccessIntent Intent)> OpenLog { get; } = new();
    public List<(string Path, CleanupFlags Flags)> CleanupLog { get; } = new();
    public List<(string Path, long Offset, int Length)> WriteLog { get; } = new();

    /// <summary>true にすると OpenAsync が null を返す (= ObjectNameNotFound 経路)。</summary>
    public bool DenyOpen { get; set; }

    /// <summary>true にすると OpenAsync が UnauthorizedAccessException (= lock 衝突) を投げる。</summary>
    public bool ThrowOpenAsUnauthorized { get; set; }

    /// <summary>true にすると CreateAsync が null を返す (= AccessDenied 経路)。</summary>
    public bool DenyCreate { get; set; }

    /// <summary>ReadAsync が常に 0 を返す (EOF 模擬)。</summary>
    public bool ReadReturnsEof { get; set; }

    /// <summary>VolumeStats getter で返す値。</summary>
    public VolumeStats VolumeStats { get; set; } =
        new(TotalSize: 100L * 1024 * 1024 * 1024, FreeSize: 50L * 1024 * 1024 * 1024);

    // ───────────────────────────── lifecycle ────
    public Task InitializeAsync(CancellationToken ct = default) => Task.CompletedTask;

    // ───────────────────────────── lookup / enumerate ────
    public Task<FileEntry?> GetEntryAsync(string path, CancellationToken ct = default)
    {
        Tree.TryGetValue(path, out var entry);
        return Task.FromResult<FileEntry?>(entry);
    }

    public Task<IReadOnlyList<FileEntry>> EnumerateAsync(string parentPath, CancellationToken ct = default)
    {
        Interlocked.Increment(ref EnumerateCalls);
        var prefix = parentPath.EndsWith('/') ? parentPath : parentPath + "/";
        var children = Tree.Values
            .Where(e => e.Path != parentPath
                && e.Path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                && !e.Path.AsSpan(prefix.Length).Contains('/'))
            .OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return Task.FromResult<IReadOnlyList<FileEntry>>(children);
    }

    // ───────────────────────────── open / create ────
    public Task<IFileHandle?> OpenAsync(string path, FileAccessIntent intent, CancellationToken ct = default)
    {
        Interlocked.Increment(ref OpenCalls);
        OpenLog.Add((path, intent));
        if (ThrowOpenAsUnauthorized)
            throw new UnauthorizedAccessException("fake: lock conflict");
        if (DenyOpen || !Tree.TryGetValue(path, out var entry))
            return Task.FromResult<IFileHandle?>(null);
        var handle = new FakeHandle(path, entry, hasLock: intent == FileAccessIntent.Write);
        OpenedHandles.Add(handle);
        return Task.FromResult<IFileHandle?>(handle);
    }

    public Task<IFileHandle?> CreateAsync(string path, bool isDirectory, CancellationToken ct = default)
    {
        Interlocked.Increment(ref CreateCalls);
        if (DenyCreate) return Task.FromResult<IFileHandle?>(null);
        var entry = new FileEntry(
            Path: path, IsDirectory: isDirectory, Size: 0,
            CreationTimeUtc: DateTime.UtcNow, LastWriteTimeUtc: DateTime.UtcNow);
        Tree[path] = entry;
        var handle = new FakeHandle(path, entry, hasLock: true) { FreshlyCreated = true };
        OpenedHandles.Add(handle);
        return Task.FromResult<IFileHandle?>(handle);
    }

    // ───────────────────────────── I/O ────
    public Task<int> ReadAsync(IFileHandle handle, long offset, Memory<byte> buffer, CancellationToken ct = default)
    {
        Interlocked.Increment(ref ReadCalls);
        if (ReadReturnsEof) return Task.FromResult(0);
        // 単純に offset 範囲を 0xAB で埋めて「読み出した」事にする (内容検証不要なテスト用)。
        buffer.Span.Fill(0xAB);
        return Task.FromResult(buffer.Length);
    }

    public Task<long> WriteAsync(IFileHandle handle, long offset, ReadOnlyMemory<byte> data,
        bool appendToEnd, bool constrainedIo, CancellationToken ct = default)
    {
        Interlocked.Increment(ref WriteCalls);
        WriteLog.Add((handle.Path, offset, data.Length));
        var h = (FakeHandle)handle;
        var newLen = Math.Max(h.SetEntry(h.Entry with { Size = offset + data.Length }).Size, h.Entry.Size);
        return Task.FromResult(newLen);
    }

    public Task SetSizeAsync(IFileHandle handle, long newSize, bool isAllocationHint, CancellationToken ct = default)
    {
        Interlocked.Increment(ref SetSizeCalls);
        if (!isAllocationHint)
        {
            var h = (FakeHandle)handle;
            h.SetEntry(h.Entry with { Size = newSize });
        }
        return Task.CompletedTask;
    }

    public Task SetBasicInfoAsync(IFileHandle handle, FileBasicInfo info, CancellationToken ct = default)
    {
        Interlocked.Increment(ref SetBasicInfoCalls);
        return Task.CompletedTask;
    }

    public Task<bool> CanDeleteAsync(IFileHandle handle, CancellationToken ct = default)
    {
        Interlocked.Increment(ref CanDeleteCalls);
        return Task.FromResult(handle.Path != "/");
    }

    public Task RenameAsync(string from, string to, bool replaceIfExists, CancellationToken ct = default)
    {
        Interlocked.Increment(ref RenameCalls);
        if (Tree.TryGetValue(from, out var entry))
        {
            Tree.Remove(from);
            Tree[to] = entry with { Path = to };
        }
        return Task.CompletedTask;
    }

    public Task CleanupAsync(IFileHandle handle, CleanupFlags flags, CancellationToken ct = default)
    {
        Interlocked.Increment(ref CleanupCalls);
        CleanupLog.Add((handle.Path, flags));
        var h = (FakeHandle)handle;
        h.CleanupFlags = flags;
        h.WasCleanedUp = true;
        return Task.CompletedTask;
    }

    public Task CloseAsync(IFileHandle handle, CancellationToken ct = default)
    {
        Interlocked.Increment(ref CloseCalls);
        var h = (FakeHandle)handle;
        h.WasClosed = true;
        return Task.CompletedTask;
    }

    // ───────────────────────────── seed helpers ────
    public FileEntry SeedFile(string path, long size = 0)
    {
        var entry = new FileEntry(
            Path: path, IsDirectory: false, Size: size,
            CreationTimeUtc: new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            LastWriteTimeUtc: new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        Tree[path] = entry;
        return entry;
    }

    public FileEntry SeedDirectory(string path)
    {
        var entry = new FileEntry(
            Path: path, IsDirectory: true, Size: 0,
            CreationTimeUtc: new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
            LastWriteTimeUtc: new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        Tree[path] = entry;
        return entry;
    }
}

/// <summary>
/// fake <see cref="IFileHandle"/>。<see cref="BackendFileSystem"/> が触る最低限の
/// API + テストから観測したい状態 (<see cref="WasCleanedUp"/>, <see cref="WasClosed"/>,
/// <see cref="HasLock"/>, <see cref="FreshlyCreated"/>) を expose する。
/// </summary>
internal sealed class FakeHandle : IFileHandle
{
    private FileEntry _entry;
    private int _disposed;

    public FakeHandle(string path, FileEntry entry, bool hasLock)
    {
        Path = path;
        _entry = entry;
        HasLock = hasLock;
    }

    public string Path { get; }
    public bool IsDirectory => _entry.IsDirectory;
    public FileEntry Entry => _entry;

    // BackendFileSystem が直接読まない (cast 経由でも) フィールド。テスト assert 用。
    public bool HasLock { get; set; }
    public bool FreshlyCreated { get; init; }
    public CleanupFlags CleanupFlags { get; set; }
    public bool WasCleanedUp { get; set; }
    public bool WasClosed { get; set; }
    public bool WasDisposed => Volatile.Read(ref _disposed) != 0;

    internal FileEntry SetEntry(FileEntry newEntry) => _entry = newEntry;

    public IDisposable EnterIo() => NullIoToken.Instance;

    public Task DrainInFlightAsync(CancellationToken ct = default) => Task.CompletedTask;

    public void Dispose() => Interlocked.Exchange(ref _disposed, 1);

    private sealed class NullIoToken : IDisposable
    {
        public static readonly NullIoToken Instance = new();
        public void Dispose() { }
    }
}
