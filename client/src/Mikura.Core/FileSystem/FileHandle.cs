using System.Diagnostics;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace Mikura.Core.FileSystem;

public sealed partial class FileSystemBackend
{
    /// <summary>
    /// Per-handle backend state (ADR-025 改訂後):
    ///   - <see cref="_slot"/>: Write の pass-through 先 (Lazy)。最初の Write
    ///     または Cleanup-with-shouldUpload で <see cref="EnsureSessionAsync"/>
    ///     経由で取得される。<see cref="WriteCoalescer"/> はこの slot 経由で
    ///     全 handle 共有。
    ///   - <see cref="Prefetch"/>: Read 経路の per-handle read-ahead cache
    ///     (ADR-031、Samba 流 next-sequential)。ReadAsync が armed 判定 / hit
    ///     消費 / miss 時の格納で利用する。
    /// </summary>
    private sealed class FileHandle : IFileHandle
    {
        private readonly FileSystemBackend _backend;
        private FileEntry _entry;
        private long _length;
        private readonly long _originalServerSize;
        private bool _hasLock;

        // ADR-025: path 単位で共有される chunked upload session の slot。
        // 同一 path に対して複数 handle が開いていても _slot は同じインスタンス
        // (refcount は backend 側で管理)。<see cref="WriteCoalescer"/> も slot 経由で共有され、
        // 全 handle の write は 1 つのバッファに append される。
        private SessionSlot? _slot;

        /// <summary>
        /// per-handle read-ahead prefetch cache (ADR-031)。詳細は
        /// <see cref="PrefetchCache"/> 参照。ReadAsync が直接 method を呼ぶ。
        /// </summary>
        public PrefetchCache Prefetch { get; } = new();

        public FileHandle(FileSystemBackend backend, string path, FileEntry entry, bool hasLock)
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

        public async Task EnsureSessionAsync(IServerApi server, bool baseFromExisting, CancellationToken ct)
        {
            if (_slot is not null) return;
            _slot = await _backend.AcquireSessionSlotAsync(Path, baseFromExisting, ct).ConfigureAwait(false);
            if (_slot is null)
                throw new InvalidOperationException($"session acquisition failed for {Path}");
        }

        public ValueTask EnqueueChunkAsync(long offset, ReadOnlyMemory<byte> data, CancellationToken ct)
        {
            var slot = _slot;
            if (slot?.Coalescer is null)
                throw new InvalidOperationException("session not started");
            return slot.Coalescer.AppendAsync(offset, data, ct);
        }

        /// <summary>
        /// 自分の handle 分の refcount を返す。自分が最後の handle なら実 finalize 経路へ。
        /// 戻り値が null なら他 handle がまだ生きているので caller は _tree 更新をスキップ。
        /// </summary>
        public async Task<UploadResult?> FinalizeAsync(IServerApi server, long finalSize, CancellationToken ct)
        {
            var slot = _slot;
            if (slot is null) throw new InvalidOperationException("session not started");
            _slot = null;
            return await _backend.ReleaseSessionSlotForFinalizeAsync(Path, slot, finalSize, ct).ConfigureAwait(false);
        }

        public async Task AbortSessionIfAnyAsync()
        {
            var slot = _slot;
            if (slot is null) return;
            _slot = null;
            await _backend.ReleaseSessionSlotForAbortAsync(Path, slot).ConfigureAwait(false);
        }

        public void Dispose()
        {
            // session slot は backend 側で path 単位に管理しているので、ここでは
            // 何も持っていない。Cleanup 経路で必ず ReleaseSessionSlotFor*Async が
            // 呼ばれ refcount が減算される。漏れた場合 (例: WinFsp 経路の例外で
            // Cleanup post されず) は server 側 TTL に任せる。
            Prefetch.Dispose();
        }

        // ─────────────────────────────────── async I/O in-flight tracker ────
        // WinFsp の STATUS_PENDING 経路で Read/Write callback が即 return した後の
        // 背景 task を Cleanup から待ち合わせるための counter + TCS。
        // 想定: Cleanup は handle 単位で 1 回だけ呼ばれ、Cleanup 後に新たな
        // Read/Write IRP は来ない(WinFsp の契約)。よって DrainInFlightAsync の
        // 再エントリは考慮不要。

        private int _inFlight;
        private TaskCompletionSource? _drainTcs;

        public IDisposable EnterIo()
        {
            Interlocked.Increment(ref _inFlight);
            return new IoReleaser(this);
        }

        public Task DrainInFlightAsync(CancellationToken ct = default)
        {
            var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            // 最初に Drain を呼んだ caller の TCS を採用(2 回呼ばれた場合は最初の TCS を共有)。
            var existing = Interlocked.CompareExchange(ref _drainTcs, tcs, null);
            var actual = existing ?? tcs;
            // CompareExchange の直後に in-flight が 0 だった場合、ExitIo は既に
            // 走り終えていて _drainTcs を取り損ねている可能性がある → ここで補填。
            if (Volatile.Read(ref _inFlight) == 0)
                actual.TrySetResult();
            return ct.CanBeCanceled ? actual.Task.WaitAsync(ct) : actual.Task;
        }

        private void ExitIo()
        {
            if (Interlocked.Decrement(ref _inFlight) == 0)
            {
                Volatile.Read(ref _drainTcs)?.TrySetResult();
            }
        }

        private sealed class IoReleaser : IDisposable
        {
            private readonly FileHandle _handle;
            private int _disposed;
            public IoReleaser(FileHandle handle) { _handle = handle; }
            public void Dispose()
            {
                if (Interlocked.Exchange(ref _disposed, 1) == 0)
                    _handle.ExitIo();
            }
        }
    }
}
