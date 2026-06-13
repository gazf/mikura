using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace Mikura.Core.FileSystem;

/// <summary>
/// Production <see cref="IFileSystemBackend"/> wired to <see cref="IServerApi"/>.
/// Replaces the CfApi-shaped <c>MikuraSyncCallbacks</c>+<c>SyncProvider</c> pair
/// (ADR-021).
///
/// <para>Write 経路は ADR-025 に従い chunked upload session に直流する
/// (<see cref="WriteCoalescer"/>)。kernel の <c>Write</c> IRP は handle 単位の
/// 4MB バッファに range pack されて 1 PATCH (multipart/mixed) として送出される。
/// handle のメモリ占有はファイルサイズに比例せず最大 4MB に bound される。</para>
/// Read 経路は引き続き whole-file hydrate を使うため、Read+Write を同一 handle
/// で行う場合は (1) 既存ファイル open は server で baseFromExisting コピーが効く、
/// (2) Read は hydrate buffer の値を返す (Write の反映は次回 open まで遅延する)、
/// という挙動になる。Samba 代替の主要ワークフロー (file copy / save / rename)
/// では問題にならない。</para>
/// </summary>
public sealed partial class FileSystemBackend : IFileSystemBackend
{
    private readonly IServerApi _server;
    private readonly ConcurrentDictionary<string, FileEntry> _tree =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly Dictionary<string, LockSlot> _activeLocks =
        new(StringComparer.OrdinalIgnoreCase);
    private readonly object _activeLocksGate = new();

    // path 単位の upload session 共有。同一 file への複数 handle (CDM の T=16 等)
    // が個別 session を開いて baseFromExisting で 1GB × N の copy を走らせる回帰
    // を防ぐ。LockSlot と同じ refcount + TCS パターン。
    private readonly Dictionary<string, SessionSlot> _activeSessions =
        new(StringComparer.OrdinalIgnoreCase);
    private readonly object _activeSessionsGate = new();

    public FileSystemBackend(IServerApi server)
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

        return new FileHandle(this, canonical, entry, hasLock);
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

    /// <summary>
    /// path 単位の session slot を取得する。最初の caller のみ <see cref="IServerApi.StartUploadAsync"/>
    /// を実走し、後続は <see cref="SessionSlot.StartResult"/> を await して同じ slot を共有する。
    /// 失敗は first caller が exception を伝播、後続は同じ exception を再 throw して取り合いに失敗する。
    /// </summary>
    private async Task<SessionSlot?> AcquireSessionSlotAsync(string path, bool baseFromExisting, CancellationToken ct)
    {
        SessionSlot slot;
        bool isFirst;
        lock (_activeSessionsGate)
        {
            if (_activeSessions.TryGetValue(path, out var existing))
            {
                existing.Refcount++;
                slot = existing;
                isFirst = false;
            }
            else
            {
                slot = new SessionSlot { Refcount = 1 };
                _activeSessions[path] = slot;
                isFirst = true;
            }
        }

        if (!isFirst)
        {
            var ok = await slot.StartResult.Task.ConfigureAwait(false);
            return ok ? slot : null;
        }

        try
        {
            var uploadId = await _server.StartUploadAsync(path, baseFromExisting, ct).ConfigureAwait(false);
            slot.UploadId = uploadId;
            slot.Coalescer = new WriteCoalescer(_server, uploadId);
            slot.StartResult.TrySetResult(true);
            return slot;
        }
        catch (Exception ex)
        {
            // start 失敗: 自分の refcount を巻き戻し、待ち合わせていた後続にも失敗を伝える。
            lock (_activeSessionsGate)
            {
                if (--slot.Refcount <= 0) _activeSessions.Remove(path);
            }
            slot.StartResult.TrySetException(ex);
            Trace.WriteLine($"StartUpload failed: {path}: {ex.Message}");
            throw;
        }
    }

    /// <summary>
    /// handle の Cleanup から呼ばれる: slot の refcount を減らし、0 になった (= 自分が
    /// 最後の handle) ケースだけ実 finalize を走らせる。それ以外は null を返し、caller
    /// は <c>_tree</c> 更新をスキップする。
    /// </summary>
    private async Task<UploadResult?> ReleaseSessionSlotForFinalizeAsync(
        string path,
        SessionSlot slot,
        long handleFinalSize,
        CancellationToken ct)
    {
        bool isLast;
        long finalSize;
        lock (_activeSessionsGate)
        {
            if (handleFinalSize > slot.MaxFinalSize) slot.MaxFinalSize = handleFinalSize;
            slot.AnyModified = true;
            isLast = --slot.Refcount <= 0;
            if (isLast) _activeSessions.Remove(path);
            finalSize = slot.MaxFinalSize;
        }
        if (!isLast) return null;

        // 実 finalize: coalescer を flush + dispose してから FinalizeUploadAsync。
        // 注意: FlushAsync が throw した場合でも Coalescer (= Timer 経由で TimerQueue
        // に grounded) の dispose を必ず走らせる必要がある。これを怠ると Coalescer
        // インスタンス + 保有 buf + _inFlightSends Tasks が GC root から到達可能な
        // まま session ごとに leak する。
        try
        {
            if (slot.Coalescer is not null)
            {
                await slot.Coalescer.FlushAsync(ct).ConfigureAwait(false);
            }
            return await _server.FinalizeUploadAsync(slot.UploadId!, finalSize, ct).ConfigureAwait(false);
        }
        catch
        {
            // finalize 失敗時は session を捨てる (TTL に任せて緑に戻る)。例外は上位に。
            if (slot.UploadId is not null)
            {
                try { await _server.AbortUploadAsync(slot.UploadId, CancellationToken.None).ConfigureAwait(false); }
                catch (Exception inner) { Trace.WriteLine($"AbortUpload after finalize-fail: {path}: {inner.Message}"); }
            }
            throw;
        }
        finally
        {
            // 正常 / 例外いずれの経路でも Coalescer を必ず dispose する (Timer 解放 +
            // 残 buf を pool 返却)。FlushAsync が throw した時の Coalescer leak 修正。
            if (slot.Coalescer is not null)
            {
                try { await slot.Coalescer.DisposeAsync().ConfigureAwait(false); }
                catch (Exception ex) { Trace.WriteLine($"FinalizeSession coalescer dispose: {path}: {ex.Message}"); }
            }
        }
    }

    /// <summary>
    /// handle の Abort 経路から呼ばれる: refcount を減らし、0 になった (= 最後の handle)
    /// ケースで coalescer 破棄 + server 側 session abort を走らせる。Modified を踏まずに
    /// 全 handle が閉じた場合や、Cleanup(Delete) 経路の合流で使う。
    /// </summary>
    private async Task ReleaseSessionSlotForAbortAsync(string path, SessionSlot slot)
    {
        bool isLast;
        string? uploadId;
        WriteCoalescer? coalescer;
        lock (_activeSessionsGate)
        {
            isLast = --slot.Refcount <= 0;
            if (isLast) _activeSessions.Remove(path);
            uploadId = slot.UploadId;
            coalescer = isLast ? slot.Coalescer : null;
        }
        if (!isLast) return;

        if (coalescer is not null)
        {
            try { await coalescer.DisposeAsync().ConfigureAwait(false); }
            catch (Exception ex) { Trace.WriteLine($"AbortSession coalescer dispose: {path}: {ex.Message}"); }
        }
        if (uploadId is not null)
        {
            try { await _server.AbortUploadAsync(uploadId, CancellationToken.None).ConfigureAwait(false); }
            catch (Exception ex) { Trace.WriteLine($"AbortSession server: {path}: {ex.Message}"); }
        }
    }

    private sealed class LockSlot
    {
        public int Refcount = 1;
        public bool HasServerLock;
        public TaskCompletionSource<bool> AcquireResult { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
    }

    /// <summary>
    /// path 単位の chunked upload session 共有。同一 path への <see cref="FileHandle"/>
    /// が複数あっても <see cref="StartUploadAsync"/> は最初の 1 回だけ走り、
    /// 全 handle が同じ <see cref="WriteCoalescer"/> に append する。
    /// finalize は refcount が 0 になった handle (= 最後に閉じた handle) が代表で行う。
    /// </summary>
    private sealed class SessionSlot
    {
        public int Refcount;
        // Start 完了で UploadId / Coalescer が埋まる。2 番目以降の Acquire は
        // この task を await して値を読む。
        public string? UploadId;
        public WriteCoalescer? Coalescer;
        public TaskCompletionSource<bool> StartResult { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        // 全 handle が CleanupAsync の Modified/FreshlyCreated 判定で報告する size の max。
        // 最後の release で server.FinalizeUploadAsync に渡す。
        public long MaxFinalSize;
        // どれか 1 handle でも Modified の Cleanup を踏んだら true。すべて
        // 未編集 Cleanup なら最後の release で abort 経路に流す。
        public bool AnyModified;
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
            return new FileHandle(this, p, dirEntry, hasLock: false);
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
        return new FileHandle(this, p, entry, hasLock: true)
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
        //
        // read-ahead cache: 1 IRP につき 2x prefetch して残りを per-handle cache
        // に置く (Samba 流 next-sequential)。次 IRP が cache 先頭から始まれば
        // HTTP RTT 0。詳細は PrefetchCache.TryConsume / Store。
        var h = (FileHandle)handle;
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

        // sequential pattern tracking: cache hit / miss いずれの経路でも
        // 1 IRP につき 1 回 update する。armed = SeqStreakThreshold 連続で
        // sequential continue を観測 = prefetch 価値あり と判定。
        var armed = h.Prefetch.NoteReadAndCheckArmed(offset, requested);

        // prefetch cache hit: zero round-trip。partial hit (cache が requested 未満)
        // でも single-use semantics で remainder は捨てる (user 仕様)。caller
        // (kernel) は不足分を次 IRP で要求してくるので integrity は崩れない。
        if (h.Prefetch.TryConsume(offset, buffer.Span.Slice(0, requested), out var cachedBytes))
        {
            if (cachedBytes < requested)
            {
                // EOF を跨いだ partial hit。残りは zero-fill (logicalEnd 以下なので
                // 通常ここには来ないが safety net)。
                buffer.Span.Slice(cachedBytes, requested - cachedBytes).Clear();
            }
            return requested;
        }

        // server 側に実体がある範囲は range fetch、その先は SetSize-extend
        // 由来のゼロ領域として local で zero-fill する。
        var fetchableEnd = Math.Min(offset + requested, h.OriginalServerSize);
        var fetchLen = (int)Math.Max(0, fetchableEnd - offset);
        var fetched = 0;
        if (fetchLen > 0)
        {
            // prefetch size 計算: armed の場合のみ 2x、それ以外は plain (fetchLen のみ)。
            // armed=false 経路は従来挙動と同等 = zero-copy direct fetch。
            var prefetchableEnd = armed
                ? Math.Min(
                    offset + (long)Math.Min(requested * 2L, PrefetchCache.MaxPrefetchSize),
                    h.OriginalServerSize)
                : (long)offset + fetchLen;
            var prefetchLen = (int)Math.Max(0, prefetchableEnd - offset);

            if (prefetchLen <= fetchLen)
            {
                // 余剰なし (disarmed / EOF 直前 / 要求が既に MaxPrefetchSize に等しい)。
                // 直接 buffer に読み込む zero-copy 経路。
                await using var stream = await _server.DownloadFileAsync(h.Path, offset, fetchLen, ct)
                    .ConfigureAwait(false);
                await stream.ReadExactlyAsync(buffer.Slice(0, fetchLen), ct).ConfigureAwait(false);
                fetched = fetchLen;
            }
            else
            {
                // prefetch: pooled buffer に prefetchLen byte 読んで、先頭 fetchLen を
                // IRP buffer にコピー、残りを cache に格納 (所有権移譲)。
                var pooled = ArrayPool<byte>.Shared.Rent(prefetchLen);
                var transferred = false;
                try
                {
                    await using var stream = await _server.DownloadFileAsync(h.Path, offset, prefetchLen, ct)
                        .ConfigureAwait(false);
                    await stream.ReadExactlyAsync(pooled.AsMemory(0, prefetchLen), ct)
                        .ConfigureAwait(false);

                    pooled.AsMemory(0, fetchLen).CopyTo(buffer);
                    fetched = fetchLen;

                    var extraStart = fetchLen;
                    var extraLen = prefetchLen - fetchLen;
                    h.Prefetch.Store(pooled, extraStart, extraLen, offset + fetchLen);
                    transferred = true;
                }
                finally
                {
                    if (!transferred)
                    {
                        ArrayPool<byte>.Shared.Return(pooled);
                    }
                }
            }
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
        var h = (FileHandle)handle;
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

        // read-ahead cache invalidate: 同 handle で Write した後の Read は
        // 自身が書いた新 byte を見るべき。prefetch は server から取った Write 前
        // の値なので必ず stale。
        h.Prefetch.Invalidate();

        var newLength = Math.Max(existingLen, writeOffset + length);
        h.SetLogicalLength(newLength);
        return newLength;
    }

    public async Task SetSizeAsync(IFileHandle handle, long newSize, bool isAllocationHint, CancellationToken ct = default)
    {
        var h = (FileHandle)handle;
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
        var h = (FileHandle)handle;
        return Task.FromResult(h.Path != "/");
    }

    public async Task CleanupAsync(IFileHandle handle, CleanupFlags flags, CancellationToken ct = default)
    {
        var h = (FileHandle)handle;

        // WinFsp の async response (STATUS_PENDING) で Read/Write callback が即 return
        // した後の背景 task を待ち合わせる。これを await しないと finalize 中に
        // 残存 Write の chunk が PATCH に行って "Session not found" を踏む。
        // Channel 内の chunk drain は FinalizeAsync の中の uploader.DrainAsync が担当。
        await h.DrainInFlightAsync(ct).ConfigureAwait(false);

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
                    // null = 同 path に他 handle が生きており自分は最後ではない。
                    // 実 finalize は最後の handle の Cleanup でまとめて走るので _tree 更新は遅延。
                    if (result is not null)
                    {
                        _tree[h.Path] = new FileEntry(
                            Path: h.Path,
                            IsDirectory: false,
                            Size: result.Size,
                            CreationTimeUtc: h.Entry.CreationTimeUtc,
                            LastWriteTimeUtc: result.LastModified.ToUniversalTime());
                        Trace.WriteLine($"Uploaded (chunked): {h.Path} (size={result.Size}) IRP[{h.FormatWriteSizeHistogram()}]");
                    }
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
        var h = (FileHandle)handle;
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

}
