using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace WinFsp.Interop.Backends;

/// <summary>
/// In-memory <see cref="IFileSystemBackend"/> for development, demos, and the
/// pre-server-integration phase. Holds a flat namespace under "/" with two
/// seeded files. Phase B.2's <c>ServerBackend</c> replaces this for production.
/// </summary>
public sealed class InMemoryFileSystemBackend : IFileSystemBackend
{
    private readonly Dictionary<string, Node> _nodes;
    private readonly DateTime _createdAt = DateTime.UtcNow;
    private readonly object _gate = new();

    public InMemoryFileSystemBackend()
    {
        _nodes = new Dictionary<string, Node>(StringComparer.OrdinalIgnoreCase)
        {
            ["/"] = Node.Directory("/", _createdAt),
            ["/hello.txt"] = Node.File("/hello.txt", _createdAt, "hello from mikura (winfsp build)\r\n"u8.ToArray()),
        };
    }

    public Task InitializeAsync(CancellationToken ct = default) => Task.CompletedTask;

    public VolumeStats VolumeStats { get; } =
        new VolumeStats(TotalSize: 64L * 1024 * 1024 * 1024, FreeSize: 32L * 1024 * 1024 * 1024);

    public Task<FileEntry?> GetEntryAsync(string path, CancellationToken ct = default)
    {
        lock (_gate)
        {
            return Task.FromResult(_nodes.TryGetValue(Norm(path), out var node) ? node.ToEntry() : null);
        }
    }

    public Task<IReadOnlyList<FileEntry>> EnumerateAsync(string parentPath, CancellationToken ct = default)
    {
        lock (_gate)
        {
            var prefix = Norm(parentPath);
            if (!prefix.EndsWith('/')) prefix += "/";
            var children = _nodes.Values
                .Where(n => n.Path != "/" && IsImmediateChild(prefix, n.Path))
                .Select(n => n.ToEntry())
                .OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
            return Task.FromResult<IReadOnlyList<FileEntry>>(children);
        }
    }

    public Task<IFileHandle?> OpenAsync(string path, FileAccessIntent intent, CancellationToken ct = default)
    {
        lock (_gate)
        {
            return Task.FromResult<IFileHandle?>(_nodes.TryGetValue(Norm(path), out var node)
                ? new InMemoryHandle(this, node)
                : null);
        }
    }

    public Task<IFileHandle?> CreateAsync(string path, bool isDirectory, CancellationToken ct = default)
    {
        lock (_gate)
        {
            // Phase A backing: flat root only — reject directories and nested paths
            // so Windows mount-time bookkeeping cannot create runaway artifacts.
            if (isDirectory) return Task.FromResult<IFileHandle?>(null);
            var p = Norm(path);
            if (p == "/" || !IsAllowedFlatPath(p)) return Task.FromResult<IFileHandle?>(null);
            if (_nodes.ContainsKey(p)) return Task.FromResult<IFileHandle?>(null);
            var node = Node.File(p, DateTime.UtcNow, Array.Empty<byte>());
            _nodes[p] = node;
            return Task.FromResult<IFileHandle?>(new InMemoryHandle(this, node));
        }
    }

    public Task<int> ReadAsync(IFileHandle handle, long offset, Memory<byte> buffer, CancellationToken ct = default)
    {
        var node = ((InMemoryHandle)handle).Node;
        lock (_gate)
        {
            var data = node.Data ?? Array.Empty<byte>();
            if (offset >= data.Length) return Task.FromResult(0);
            var available = (int)Math.Min(buffer.Length, data.Length - offset);
            data.AsSpan((int)offset, available).CopyTo(buffer.Span);
            return Task.FromResult(available);
        }
    }

    public Task<long> WriteAsync(
        IFileHandle handle,
        long offset,
        ReadOnlyMemory<byte> data,
        bool appendToEnd,
        bool constrainedIo,
        CancellationToken ct = default)
    {
        var node = ((InMemoryHandle)handle).Node;
        lock (_gate)
        {
            var existing = node.Data ?? Array.Empty<byte>();
            var writeOffset = appendToEnd ? existing.Length : offset;
            var length = data.Length;

            if (constrainedIo)
            {
                if (writeOffset >= existing.Length) return Task.FromResult((long)existing.Length);
                length = (int)Math.Min(length, existing.Length - writeOffset);
            }

            var newLength = Math.Max(existing.Length, writeOffset + length);
            var next = new byte[newLength];
            Buffer.BlockCopy(existing, 0, next, 0, existing.Length);
            data.Span.Slice(0, length).CopyTo(next.AsSpan((int)writeOffset, length));
            node.Data = next;
            node.LastWriteUtc = DateTime.UtcNow;
            return Task.FromResult((long)next.Length);
        }
    }

    public Task SetSizeAsync(IFileHandle handle, long newSize, bool isAllocationHint, CancellationToken ct = default)
    {
        var node = ((InMemoryHandle)handle).Node;
        lock (_gate)
        {
            var existing = node.Data ?? Array.Empty<byte>();
            // AllocationSize >= current is a preallocation hint — ignore.
            if (isAllocationHint && newSize >= existing.Length) return Task.CompletedTask;
            if (newSize == existing.Length) return Task.CompletedTask;
            var next = new byte[newSize];
            Buffer.BlockCopy(existing, 0, next, 0, (int)Math.Min(existing.Length, newSize));
            node.Data = next;
            node.LastWriteUtc = DateTime.UtcNow;
        }
        return Task.CompletedTask;
    }

    public Task RenameAsync(string from, string to, bool replaceIfExists, CancellationToken ct = default)
    {
        lock (_gate)
        {
            var src = Norm(from);
            var dst = Norm(to);
            if (!_nodes.TryGetValue(src, out var srcNode)) throw new FileNotFoundException(src);
            if (_nodes.ContainsKey(dst))
            {
                if (!replaceIfExists) throw new IOException($"target exists: {dst}");
                _nodes.Remove(dst);
            }
            _nodes.Remove(src);
            srcNode.Path = dst;
            _nodes[dst] = srcNode;
        }
        return Task.CompletedTask;
    }

    public Task SetBasicInfoAsync(IFileHandle handle, FileBasicInfo info, CancellationToken ct = default)
    {
        var node = ((InMemoryHandle)handle).Node;
        lock (_gate)
        {
            if (info.LastWriteTimeUtc is { } lw) node.LastWriteUtc = lw;
        }
        return Task.CompletedTask;
    }

    public Task<bool> CanDeleteAsync(IFileHandle handle, CancellationToken ct = default)
    {
        var node = ((InMemoryHandle)handle).Node;
        return Task.FromResult(node.Path != "/");
    }

    public Task CleanupAsync(IFileHandle handle, CleanupFlags flags, CancellationToken ct = default)
    {
        if ((flags & CleanupFlags.Delete) != 0)
        {
            var node = ((InMemoryHandle)handle).Node;
            lock (_gate)
            {
                if (node.Path != "/") _nodes.Remove(node.Path);
            }
        }
        return Task.CompletedTask;
    }

    public Task CloseAsync(IFileHandle handle, CancellationToken ct = default) => Task.CompletedTask;

    private static string Norm(string path) =>
        string.IsNullOrEmpty(path) ? "/" : (path.StartsWith('/') ? path : "/" + path);

    /// <summary>
    /// Phase A restriction: only flat root files (one segment after "/") are
    /// allowed. Prevents Windows mount bookkeeping from creating runaway nested
    /// artifacts (System Volume Information, $RECYCLE.BIN, ...).
    /// </summary>
    private static bool IsAllowedFlatPath(string path)
    {
        if (path == "/") return true;
        if (!path.StartsWith('/')) return false;
        return path.IndexOf('/', 1) < 0;
    }

    private static bool IsImmediateChild(string parentPrefix, string fullPath)
    {
        if (!fullPath.StartsWith(parentPrefix, StringComparison.OrdinalIgnoreCase)) return false;
        var rest = fullPath[parentPrefix.Length..];
        return rest.Length > 0 && !rest.Contains('/');
    }

    private sealed class Node
    {
        public string Path { get; set; } = "";
        public bool IsDirectory { get; init; }
        public DateTime CreationTimeUtc { get; init; }
        public DateTime LastWriteUtc { get; set; }
        public byte[]? Data { get; set; }

        public static Node File(string path, DateTime now, byte[] data) => new()
        {
            Path = path,
            IsDirectory = false,
            CreationTimeUtc = now,
            LastWriteUtc = now,
            Data = data,
        };

        public static Node Directory(string path, DateTime now) => new()
        {
            Path = path,
            IsDirectory = true,
            CreationTimeUtc = now,
            LastWriteUtc = now,
        };

        public FileEntry ToEntry() => new(
            Path: Path,
            IsDirectory: IsDirectory,
            Size: IsDirectory ? 0 : (Data?.Length ?? 0),
            CreationTimeUtc: CreationTimeUtc,
            LastWriteTimeUtc: LastWriteUtc);
    }

    private sealed class InMemoryHandle : IFileHandle
    {
        private readonly InMemoryFileSystemBackend _backend;
        public Node Node { get; }

        public InMemoryHandle(InMemoryFileSystemBackend backend, Node node)
        {
            _backend = backend;
            Node = node;
        }

        public string Path => Node.Path;
        public bool IsDirectory => Node.IsDirectory;
        public FileEntry Entry => Node.ToEntry();

        // In-memory backend は全 op が同期完了するので in-flight tracking は no-op。
        public IDisposable EnterIo() => NoopDisposable.Instance;
        public Task DrainInFlightAsync(CancellationToken ct = default) => Task.CompletedTask;

        public void Dispose() { }

        private sealed class NoopDisposable : IDisposable
        {
            public static readonly NoopDisposable Instance = new();
            public void Dispose() { }
        }
    }
}
