using System.Collections.Concurrent;
using System.Diagnostics;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace Mikura.Core.Sync;

/// <summary>
/// Production <see cref="IFileSystemBackend"/> wired to <see cref="IMikuraServer"/>.
/// Replaces the CfApi-shaped <c>MikuraSyncCallbacks</c>+<c>SyncProvider</c> pair
/// (ADR-021).
///
/// <para>Write 経路は ADR-025 に従い chunked upload session に直流する
/// (<see cref="ChunkedUploader"/>)。kernel の <c>Write</c> IRP は handle 単位の
/// in-memory バッファに溜めず、その都度 PATCH に載せて送る。これにより
/// handle のメモリ占有がファイルサイズに比例しなくなる (ADR-023 supersede)。
/// Read 経路は引き続き whole-file hydrate を使うため、Read+Write を同一 handle
/// で行う場合は (1) 既存ファイル open は server で baseFromExisting コピーが効く、
/// (2) Read は hydrate buffer の値を返す (Write の反映は次回 open まで遅延する)、
/// という挙動になる。Samba 代替の主要ワークフロー (file copy / save / rename)
/// では問題にならない。</para>
/// </summary>
public sealed class MikuraServerBackend : IFileSystemBackend
{
    private readonly IMikuraServer _server;
    private readonly ConcurrentDictionary<string, FileEntry> _tree =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly Dictionary<string, LockSlot> _activeLocks =
        new(StringComparer.OrdinalIgnoreCase);
    private readonly object _activeLocksGate = new();

    public MikuraServerBackend(IMikuraServer server)
    {
        _server = server;
    }

    public IReadOnlyDictionary<string, FileEntry> TreeSnapshot => _tree;

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        var tree = await _server.GetTreeAsync(ct).ConfigureAwait(false);
        _tree.Clear();
        _tree["/"] = new FileEntry("/", IsDirectory: true, Size: 0,
            CreationTimeUtc: DateTime.UtcNow, LastWriteTimeUtc: DateTime.UtcNow);
        foreach (var n in tree)
        {
            _tree[Norm(n.Path)] = new FileEntry(
                Path: Norm(n.Path),
                IsDirectory: n.IsDirectory,
                Size: n.Size,
                CreationTimeUtc: n.LastModified.ToUniversalTime(),
                LastWriteTimeUtc: n.LastModified.ToUniversalTime(),
                IsReadOnly: n.IsReadOnly);
        }
        // 初回 volume stats は同期で取って kernel が最初の GetVolumeInfo callback
        // を投げてきた瞬間に正しい値を返せるようにしておく。失敗してもデフォルト
        // ハードコードで起動継続。
        try
        {
            await RefreshVolumeStatsAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"Initial volume stats fetch failed (using defaults): {ex.Message}");
        }
    }

    // ─────────────────────────────────────── Volume stats cache ─────────
    // WinFsp の GetVolumeInfo callback は同期、かつ explorer の status bar 更新
    // 等で高頻度に呼ばれる。毎回 HTTP に行くと shell がもたつくので、cache +
    // 背景 refresh パターン。値が古い (TTL 超え) ときは fire-and-forget で
    // refresh、callback には現在の cache を即返す。
    private static readonly VolumeStats _defaultVolumeStats = new(
        TotalSize: 64L * 1024 * 1024 * 1024,
        FreeSize: 32L * 1024 * 1024 * 1024);
    private VolumeStats _cachedVolumeStats = _defaultVolumeStats;
    private long _lastVolumeRefreshTicks; // DateTime.UtcNow.Ticks
    private static readonly long _volumeRefreshTtlTicks = TimeSpan.FromSeconds(30).Ticks;
    private int _volumeRefreshInFlight; // Interlocked: 0 = idle, 1 = running

    public VolumeStats VolumeStats
    {
        get
        {
            var ageTicks = DateTime.UtcNow.Ticks - Interlocked.Read(ref _lastVolumeRefreshTicks);
            if (ageTicks > _volumeRefreshTtlTicks)
            {
                TriggerBackgroundVolumeRefresh();
            }
            return _cachedVolumeStats;
        }
    }

    private void TriggerBackgroundVolumeRefresh()
    {
        // 同時 refresh は 1 つだけ。CompareExchange で atomic に取る。
        if (Interlocked.CompareExchange(ref _volumeRefreshInFlight, 1, 0) != 0) return;
        _ = Task.Run(async () =>
        {
            try { await RefreshVolumeStatsAsync(CancellationToken.None).ConfigureAwait(false); }
            catch (Exception ex) { Trace.WriteLine($"Volume stats refresh failed: {ex.Message}"); }
            finally { Interlocked.Exchange(ref _volumeRefreshInFlight, 0); }
        });
    }

    private async Task RefreshVolumeStatsAsync(CancellationToken ct)
    {
        var stats = await _server.GetVolumeStatsAsync(ct).ConfigureAwait(false);
        _cachedVolumeStats = stats;
        Interlocked.Exchange(ref _lastVolumeRefreshTicks, DateTime.UtcNow.Ticks);
    }

    public Task<FileEntry?> GetEntryAsync(string path, CancellationToken ct = default) =>
        Task.FromResult(_tree.TryGetValue(Norm(path), out var e) ? e : null);

    public Task<IReadOnlyList<FileEntry>> EnumerateAsync(string parentPath, CancellationToken ct = default)
    {
        var prefix = Norm(parentPath);
        if (!prefix.EndsWith('/')) prefix += "/";
        var children = _tree.Values
            .Where(e => e.Path != "/" && IsImmediateChild(prefix, e.Path))
            .OrderBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return Task.FromResult<IReadOnlyList<FileEntry>>(children);
    }

    public async Task<IFileHandle?> OpenAsync(string path, FileAccessIntent intent, CancellationToken ct = default)
    {
        var requested = Norm(path);
        if (!_tree.TryGetValue(requested, out var entry)) return null;

        // _tree は OrdinalIgnoreCase 比較なので、Windows のシェル/プレイヤが
        // 大文字小文字違いの path で開いても hit する (例: /foo.mp4 と /foo.MP4)。
        // しかし server (POSIX) は厳密一致なので、ハンドル後段で server を叩く
        // 際は **必ず tree が記録している正規 path = entry.Path を使う**。
        // user が渡した path をそのまま使うと、Read 時に GET /content/<...>
        // が 404 になり再生 / シークが落ちる (実機回帰)。
        var canonical = entry.Path;

        // ADR-016/022: write-intent open でだけサーバロックを取る。read open は素通し。
        var hasLock = false;
        if (!entry.IsDirectory && intent == FileAccessIntent.Write)
        {
            hasLock = await AcquireSharedAsync(canonical, ct).ConfigureAwait(false);
            if (!hasLock)
            {
                throw new UnauthorizedAccessException($"file is locked by another holder: {canonical}");
            }
        }

        return new ServerHandle(this, canonical, entry, hasLock);
    }

    private async Task<bool> AcquireSharedAsync(string path, CancellationToken ct)
    {
        LockSlot slot;
        bool isFirst;
        lock (_activeLocksGate)
        {
            if (_activeLocks.TryGetValue(path, out var existing))
            {
                existing.Refcount++;
                slot = existing;
                isFirst = false;
            }
            else
            {
                slot = new LockSlot();
                _activeLocks[path] = slot;
                isFirst = true;
            }
        }

        if (!isFirst)
        {
            return await slot.AcquireResult.Task.ConfigureAwait(false);
        }

        try
        {
            var info = await _server.AcquireLockAsync(path, ct).ConfigureAwait(false);
            var success = info is not null;
            slot.HasServerLock = success;
            slot.AcquireResult.TrySetResult(success);
            if (!success)
            {
                lock (_activeLocksGate)
                {
                    if (--slot.Refcount <= 0) _activeLocks.Remove(path);
                }
            }
            return success;
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"AcquireLock failed (open): {path}: {ex.Message}");
            slot.AcquireResult.TrySetResult(false);
            lock (_activeLocksGate)
            {
                if (--slot.Refcount <= 0) _activeLocks.Remove(path);
            }
            return false;
        }
    }

    private async Task ReleaseSharedAsync(string path)
    {
        bool needRelease = false;
        lock (_activeLocksGate)
        {
            if (_activeLocks.TryGetValue(path, out var slot))
            {
                if (--slot.Refcount <= 0)
                {
                    _activeLocks.Remove(path);
                    needRelease = slot.HasServerLock;
                }
            }
        }
        if (needRelease)
        {
            try
            {
                await _server.ReleaseLockAsync(path, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"ReleaseLock failed: {path}: {ex.Message}");
            }
        }
    }

    private sealed class LockSlot
    {
        public int Refcount = 1;
        public bool HasServerLock;
        public TaskCompletionSource<bool> AcquireResult { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    public async Task<IFileHandle?> CreateAsync(string path, bool isDirectory, CancellationToken ct = default)
    {
        var p = Norm(path);
        if (_tree.ContainsKey(p)) return null;

        if (isDirectory)
        {
            try
            {
                await _server.CreateFolderAsync(p, ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"CreateFolder failed: {p}: {ex.Message}");
                return null;
            }

            var dirEntry = new FileEntry(
                Path: p,
                IsDirectory: true,
                Size: 0,
                CreationTimeUtc: DateTime.UtcNow,
                LastWriteTimeUtc: DateTime.UtcNow);
            _tree[p] = dirEntry;
            return new ServerHandle(this, p, dirEntry, hasLock: false);
        }

        // ADR-016/022 + ADR-025: 新規ファイル作成も write 操作として lock を取る。
        // server 側 upload session (POST /uploads) は lock holder のみ受け付ける
        // ため、ここで lock を取らないと最初の Write で 403 になる。
        var hasLock = await AcquireSharedAsync(p, ct).ConfigureAwait(false);
        if (!hasLock)
        {
            // 同名 path を別ユーザーが先に作っている (= レース) → 拒否。
            throw new UnauthorizedAccessException($"file is locked by another holder: {p}");
        }

        var entry = new FileEntry(
            Path: p,
            IsDirectory: false,
            Size: 0,
            CreationTimeUtc: DateTime.UtcNow,
            LastWriteTimeUtc: DateTime.UtcNow);
        _tree[p] = entry;
        return new ServerHandle(this, p, entry, hasLock: true)
        {
            FreshlyCreated = true,
        };
    }

    public async Task<int> ReadAsync(IFileHandle handle, long offset, Memory<byte> buffer, CancellationToken ct = default)
    {
        // ADR-025 改訂: 旧設計は最初の Read で whole-file hydrate (handle 単位の
        // _buffer に全 byte を load) していたが、shell の preview/property 抽出
        // は file 全体を必要としないのに 100MB 級ファイルを丸ごとメモリに
        // 乗せていた。右クリックのたびに 100MB が LOH に積み増されてプロセス
        // メモリが膨らむ実機回帰の主因。本実装は range-based fetch に切替え、
        // kernel が要求した範囲ぶんだけ HTTP Range で取得する。
        var h = (ServerHandle)handle;
        if (h.IsDirectory) return 0;

        var logicalEnd = h.Length;
        if (offset >= logicalEnd) return 0;
        var requested = (int)Math.Min(buffer.Length, logicalEnd - offset);
        if (requested == 0) return 0;

        // 新規作成 (server 未存在) は SetSize で extend されていてもサーバから
        // 取れる byte が 0 なので全てゼロ返し。
        if (h.FreshlyCreated)
        {
            buffer.Span.Slice(0, requested).Clear();
            return requested;
        }

        // server 側に実体がある範囲は range fetch、その先は SetSize-extend
        // 由来のゼロ領域として local で zero-fill する。
        var fetchableEnd = Math.Min(offset + requested, h.OriginalServerSize);
        var fetchLen = (int)Math.Max(0, fetchableEnd - offset);
        var fetched = 0;
        if (fetchLen > 0)
        {
            await using var stream = await _server.DownloadFileAsync(h.Path, offset, fetchLen, ct)
                .ConfigureAwait(false);
            await stream.ReadExactlyAsync(buffer.Slice(0, fetchLen), ct).ConfigureAwait(false);
            fetched = fetchLen;
        }
        if (fetched < requested)
        {
            buffer.Span.Slice(fetched, requested - fetched).Clear();
        }
        return requested;
    }

    public async Task<long> WriteAsync(
        IFileHandle handle,
        long offset,
        ReadOnlyMemory<byte> data,
        bool appendToEnd,
        bool constrainedIo,
        CancellationToken ct = default)
    {
        var h = (ServerHandle)handle;
        if (h.IsDirectory) throw new InvalidOperationException("cannot write to directory");
        // 防御 (ADR-022): write は lock 持ちか FreshlyCreated に限る。
        if (!h.HasLock && !h.FreshlyCreated)
        {
            throw new UnauthorizedAccessException(
                $"write attempted on handle without server lock: {h.Path}");
        }

        var existingLen = h.Length;
        var writeOffset = appendToEnd ? existingLen : offset;
        var length = data.Length;

        if (constrainedIo)
        {
            if (writeOffset >= existingLen) return existingLen;
            length = (int)Math.Min(length, existingLen - writeOffset);
        }

        // ADR-025: Write は upload session への PATCH に直流する。
        // FreshlyCreated は base 不要、既存 file 修正は base 要 (modify-in-place)。
        await h.EnsureSessionAsync(_server, baseFromExisting: !h.FreshlyCreated, ct)
            .ConfigureAwait(false);
        await h.EnqueueChunkAsync(writeOffset, data.Slice(0, length), ct).ConfigureAwait(false);
        h.RecordWriteSize(length);

        var newLength = Math.Max(existingLen, writeOffset + length);
        h.SetLogicalLength(newLength);
        return newLength;
    }

    public async Task SetSizeAsync(IFileHandle handle, long newSize, bool isAllocationHint, CancellationToken ct = default)
    {
        var h = (ServerHandle)handle;
        if (h.IsDirectory) throw new InvalidOperationException("cannot resize directory");

        if (isAllocationHint)
        {
            // ADR-025: server 側は finalize size で末尾長を確定する。allocation hint は
            // クライアントの buffer 容量予約だけで、論理 length は触らない。
            // 過去 (ADR-023) は in-memory buffer の prealloc に使っていたが、pass-through
            // 設計では buffer 自体を持たないため no-op で良い。
            return;
        }

        // !allocationHint は実際にファイル長を変える。logical length のみ更新し、
        // サーバ側への反映は Cleanup(Modified) の finalize size で 1 回だけ行う。
        // Read 経路は range fetch + zero-fill で SetSize-extend を吸収する。
        var existingLen = h.Length;
        if (newSize == existingLen) return;
        h.SetLogicalLength(newSize);
        return;
    }

    public async Task RenameAsync(string from, string to, bool replaceIfExists, CancellationToken ct = default)
    {
        var src = Norm(from);
        var dst = Norm(to);
        if (string.Equals(src, dst, StringComparison.OrdinalIgnoreCase)) return;

        if (!_tree.TryGetValue(src, out var existing))
            throw new FileNotFoundException(src);

        // OpenAsync と同じ理由で、server を叩く path は tree が記録している正規版。
        var canonicalSrc = existing.Path;

        // dst は新規の名前 (必ずしも tree に存在しない) なので呼び出し側の正規化に任せる。
        if (replaceIfExists && _tree.TryGetValue(dst, out var existingDst))
        {
            var canonicalDst = existingDst.Path;
            try { await _server.DeleteFileAsync(canonicalDst, ct).ConfigureAwait(false); }
            catch (Exception ex) { Trace.WriteLine($"Rename: pre-delete dst failed: {canonicalDst}: {ex.Message}"); }
            _tree.TryRemove(canonicalDst, out _);
        }

        await _server.RenameAsync(canonicalSrc, dst, ct).ConfigureAwait(false);
        _tree.TryRemove(canonicalSrc, out _);
        _tree[dst] = existing with { Path = dst, LastWriteTimeUtc = DateTime.UtcNow };

        // ADR-016/024 連動: rename 完了は「編集終了」のセマンティクスなので、
        // src/dst 両方の lock を強制 release する。これをやらないと Excel の
        // save-to-temp+rename パターンで src lock(temp file 名)と dst lock
        // (置き換え target)が孤立し、heartbeat で永久に refresh され続ける
        // (実機: Book1.xlsx 保存後に 4 つの孤児 lock が残る)。
        // server lock service は path-keyed KV なので rename 連動しない。
        // client 側で明示的に release を投げる責務がここにある。
        await ForceReleasePathLockAsync(canonicalSrc).ConfigureAwait(false);
        await ForceReleasePathLockAsync(dst).ConfigureAwait(false);
    }

    /// <summary>
    /// 指定 path の lock を refcount 関係なく強制的に release する。
    /// rename 後の旧/新 path の孤児 lock を掃除する用途。
    /// </summary>
    private async Task ForceReleasePathLockAsync(string path)
    {
        bool needRelease = false;
        lock (_activeLocksGate)
        {
            if (_activeLocks.TryGetValue(path, out var slot))
            {
                needRelease = slot.HasServerLock;
                _activeLocks.Remove(path);
            }
        }
        if (needRelease)
        {
            try
            {
                await _server.ReleaseLockAsync(path, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"ForceReleaseLock failed: {path}: {ex.Message}");
            }
        }
    }

    public Task SetBasicInfoAsync(IFileHandle handle, FileBasicInfo info, CancellationToken ct = default)
    {
        return Task.CompletedTask;
    }

    public Task<bool> CanDeleteAsync(IFileHandle handle, CancellationToken ct = default)
    {
        var h = (ServerHandle)handle;
        return Task.FromResult(h.Path != "/");
    }

    public async Task CleanupAsync(IFileHandle handle, CleanupFlags flags, CancellationToken ct = default)
    {
        var h = (ServerHandle)handle;

        try
        {
            if ((flags & CleanupFlags.Delete) != 0)
            {
                // 進行中の session があれば破棄してから削除。
                await h.AbortSessionIfAnyAsync().ConfigureAwait(false);
                try
                {
                    await _server.DeleteFileAsync(h.Path, ct).ConfigureAwait(false);
                    _tree.TryRemove(h.Path, out _);
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"Delete failed: {h.Path}: {ex.Message}");
                }
                return;
            }

            var shouldUpload = (flags & CleanupFlags.Modified) != 0 || h.FreshlyCreated;
            if (shouldUpload && !h.IsDirectory)
            {
                try
                {
                    // SetSize / FreshlyCreated だけで PATCH なし、というケースのため
                    // ここでも session を idempotent に開く。
                    await h.EnsureSessionAsync(_server, baseFromExisting: !h.FreshlyCreated, ct)
                        .ConfigureAwait(false);
                    var result = await h.FinalizeAsync(_server, h.Length, ct).ConfigureAwait(false);
                    _tree[h.Path] = new FileEntry(
                        Path: h.Path,
                        IsDirectory: false,
                        Size: result.Size,
                        CreationTimeUtc: h.Entry.CreationTimeUtc,
                        LastWriteTimeUtc: result.LastModified.ToUniversalTime());
                    Trace.WriteLine($"Uploaded (chunked): {h.Path} (size={result.Size}) IRP[{h.FormatWriteSizeHistogram()}]");
                }
                catch (Exception ex)
                {
                    Trace.WriteLine($"Upload failed: {h.Path}: {ex.Message}");
                    // 失敗時は session を破棄して TTL に任せる。
                    await h.AbortSessionIfAnyAsync().ConfigureAwait(false);
                }
            }
            else
            {
                // 未編集: lock だけ解放。session は本来始まっていないが念のため。
                await h.AbortSessionIfAnyAsync().ConfigureAwait(false);
            }
        }
        finally
        {
            if (h.HasLock)
            {
                await ReleaseSharedAsync(h.Path).ConfigureAwait(false);
                h.MarkLockReleased();
            }
        }
    }

    public async Task CloseAsync(IFileHandle handle, CancellationToken ct = default)
    {
        // 通常は Cleanup の finally で lock release と session abort が走るが、
        // WinFsp の host 設定や callback タイミングの組合わせで Cleanup が
        // post されないケースに備えて、Close (= 必ず最後に呼ばれる) でも
        // safety net として release する。Cleanup で既に release 済みなら
        // h.HasLock=false で no-op、_uploader=null で no-op になる。
        var h = (ServerHandle)handle;
        try
        {
            await h.AbortSessionIfAnyAsync().ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"CloseAsync: AbortSession safety-net failed: {h.Path}: {ex.Message}");
        }
        if (h.HasLock)
        {
            try
            {
                await ReleaseSharedAsync(h.Path).ConfigureAwait(false);
                h.MarkLockReleased();
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"CloseAsync: ReleaseShared safety-net failed: {h.Path}: {ex.Message}");
            }
        }
    }

    public bool ApplyExternalEvent(string eventName, string path, long size, DateTime lastModified, bool isDirectory)
    {
        var p = Norm(path);
        switch (eventName)
        {
            case "created":
            case "modified":
                _tree[p] = new FileEntry(
                    Path: p,
                    IsDirectory: isDirectory,
                    Size: size,
                    CreationTimeUtc: lastModified.ToUniversalTime(),
                    LastWriteTimeUtc: lastModified.ToUniversalTime());
                return true;

            case "deleted":
                return _tree.TryRemove(p, out _);

            default:
                return false;
        }
    }

    public bool ApplyLockEvent(string path, bool locked)
    {
        var p = Norm(path);
        if (!_tree.TryGetValue(p, out var existing)) return false;
        var updated = existing with { IsReadOnly = locked };
        _tree[p] = updated;
        return true;
    }

    private static string Norm(string path) =>
        string.IsNullOrEmpty(path) ? "/" : (path.StartsWith('/') ? path : "/" + path);

    private static bool IsImmediateChild(string parentPrefix, string fullPath)
    {
        if (!fullPath.StartsWith(parentPrefix, StringComparison.OrdinalIgnoreCase)) return false;
        var rest = fullPath[parentPrefix.Length..];
        return rest.Length > 0 && !rest.Contains('/');
    }

    /// <summary>
    /// Per-handle backend state (ADR-025 改訂後):
    ///   - <see cref="_buffer"/>: Read 用の hydrate cache。Read を 1 度も触らない
    ///     pure-write フローでは empty のまま。
    ///   - <see cref="_uploader"/>: Write の pass-through 先 (Lazy)。最初の Write
    ///     または Cleanup-with-shouldUpload で <see cref="EnsureSessionAsync"/>
    ///     経由で生成される。
    /// </summary>
    private sealed class ServerHandle : IFileHandle
    {
        private readonly MikuraServerBackend _backend;
        private FileEntry _entry;
        private long _length;
        private readonly long _originalServerSize;
        private bool _hasLock;

        // ADR-025: chunked upload session。最初の Write で開く。
        private ChunkedUploader? _uploader;
        private readonly SemaphoreSlim _sessionGate = new(1, 1);

        public ServerHandle(MikuraServerBackend backend, string path, FileEntry entry, bool hasLock)
        {
            _backend = backend;
            Path = path;
            _entry = entry;
            _hasLock = hasLock;
            _length = entry.Size;
            _originalServerSize = entry.Size;
        }

        public string Path { get; }
        public bool IsDirectory => _entry.IsDirectory;
        public bool FreshlyCreated { get; init; }
        public bool HasLock => _hasLock;

        public long Length => _length;
        public FileEntry Entry => _entry;

        /// <summary>
        /// open 時にツリーキャッシュが報告した「サーバ側ファイルサイズ」のスナップショット。
        /// SetSize で local logical length を伸縮しても固定で、Read の range fetch
        /// 上限 (= 「これ以上 server から取れる byte は無い」) として使う。
        /// </summary>
        public long OriginalServerSize => _originalServerSize;

        public void SetLogicalLength(long newLength)
        {
            _length = newLength;
            _entry = _entry with { Size = newLength, LastWriteTimeUtc = DateTime.UtcNow };
        }

        public void MarkLockReleased() => _hasLock = false;

        // ─────────────────────────── 診断用: WinFsp Write IRP サイズ分布 ────
        // copy 速度のバラつき調査で「kernel が何 byte 単位で来ているか」を
        // 知るためのヒストグラム。Cleanup の "Uploaded (chunked):" log に
        // バンドルされる。本番でも常時オンだが、出力 1 行 / 1 ファイル close
        // なので帯域は小さい。
        private readonly Dictionary<int, int> _writeSizes = new();
        private readonly object _writeSizesGate = new();

        public void RecordWriteSize(int size)
        {
            lock (_writeSizesGate)
            {
                _writeSizes[size] = _writeSizes.TryGetValue(size, out var c) ? c + 1 : 1;
            }
        }

        public string FormatWriteSizeHistogram()
        {
            lock (_writeSizesGate)
            {
                if (_writeSizes.Count == 0) return "";
                return string.Join(", ", _writeSizes
                    .OrderBy(kv => kv.Key)
                    .Select(kv => $"{FormatSize(kv.Key)}×{kv.Value}"));
            }
        }

        private static string FormatSize(int bytes) => bytes switch
        {
            < 1024 => $"{bytes}B",
            < 1024 * 1024 => $"{bytes / 1024}KB",
            _ => $"{bytes / (1024 * 1024)}MB",
        };

        // ─────────────────────────────────────── chunked upload session ────

        public async Task EnsureSessionAsync(IMikuraServer server, bool baseFromExisting, CancellationToken ct)
        {
            if (_uploader is not null) return;
            await _sessionGate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (_uploader is not null) return;
                var uploadId = await server.StartUploadAsync(Path, baseFromExisting, ct).ConfigureAwait(false);
                _uploader = new ChunkedUploader(server, uploadId);
            }
            finally { _sessionGate.Release(); }
        }

        public Task EnqueueChunkAsync(long offset, ReadOnlyMemory<byte> data, CancellationToken ct)
        {
            if (_uploader is null)
                throw new InvalidOperationException("session not started");
            return _uploader.EnqueueAsync(offset, data, ct);
        }

        public async Task<UploadResult> FinalizeAsync(IMikuraServer server, long finalSize, CancellationToken ct)
        {
            if (_uploader is null)
                throw new InvalidOperationException("session not started");
            await _uploader.DrainAsync().ConfigureAwait(false);
            var result = await server.FinalizeUploadAsync(_uploader.UploadId, finalSize, ct).ConfigureAwait(false);
            _uploader = null;
            return result;
        }

        public async Task AbortSessionIfAnyAsync()
        {
            var local = _uploader;
            if (local is null) return;
            _uploader = null;
            try
            {
                await local.AbortAsync().ConfigureAwait(false);
                await _backend._server.AbortUploadAsync(local.UploadId, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                Trace.WriteLine($"AbortSession failed: {Path}: {ex.Message}");
            }
            finally
            {
                await local.DisposeAsync().ConfigureAwait(false);
            }
        }

        public void Dispose()
        {
            _sessionGate.Dispose();
            // _uploader は CleanupAsync で finalize / abort 済みの想定。
            // 例外経路で漏れた場合は AbortAsync を非同期で呼ばずに諦める。
        }
    }
}
