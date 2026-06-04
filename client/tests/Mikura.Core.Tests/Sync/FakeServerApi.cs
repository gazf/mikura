using System;
using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace Mikura.Core.Tests.Sync;

/// <summary>
/// ServerBackend テスト用の手書き fake。Moq だと
/// stateful なロック / ストレージのモデル化が読みづらくなるので、
/// 状態と呼び出し回数を素直に持つ実体クラスにする。
/// </summary>
internal sealed class FakeServerApi : IServerApi
{
    // 実 server (POSIX) は case-sensitive なので Ordinal にする。OrdinalIgnoreCase
    // にすると、ServerBackend が user-provided path をそのまま server に
    // 投げる回帰 (= /Foo.mp4 を /FOO.MP4 で開いた直後の Read 404) を捕まえられない。
    public Dictionary<string, byte[]> Files { get; } = new(StringComparer.Ordinal);
    public List<TreeNode> InitialTree { get; } = new();

    /// <summary>テスト用: 直近 DownloadFileAsync が叩かれた path (case-sensitivity 検証用)。</summary>
    public string? LastDownloadedPath { get; private set; }

    /// <summary>
    /// テスト用: download 時に Files の内容を path 単位で切り詰めて返す。
    /// 「tree で名乗ったサイズより短い stream を寄越すサーバ」という異常応答を
    /// シミュレートする (silent truncation 回帰防止用)。
    /// </summary>
    public Dictionary<string, int> TruncatedDownloadSizes { get; } =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>true にすると AcquireLockAsync が常に null を返す (= 他者ロック中)。</summary>
    public bool DenyAcquireLock { get; set; }

    // ロック call count はカバレッジではなく ADR-022 の責務 (write open N 個に対して
     // POST/DELETE 1 回ずつ) を観測するために保持する。Download も同様 (hydrate は
     // 1 回だけという ADR-023 の no-refetch 責務)。それ以外の責務はすべて
     // <see cref="Files"/> 経由で観測できるので counter を増やさない。
    public int AcquireLockCalls { get; private set; }
    public int ReleaseLockCalls { get; private set; }
    public int DownloadCalls { get; private set; }

    /// <summary>テスト用の seed ヘルパ: ファイルとツリー両方に登録する。</summary>
    public void SeedFile(string path, byte[] content)
    {
        Files[path] = content;
        InitialTree.Add(new TreeNode(path, "file", content.LongLength, DateTime.UtcNow));
    }

    public void SeedDirectory(string path)
    {
        InitialTree.Add(new TreeNode(path, "directory", 0, DateTime.UtcNow));
    }

    public Task<IReadOnlyList<TreeNode>> GetTreeAsync(CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<TreeNode>>(InitialTree);

    public Task<Stream> DownloadFileAsync(string path, long offset = 0, long length = -1, CancellationToken ct = default)
    {
        DownloadCalls++;
        LastDownloadedPath = path;
        if (!Files.TryGetValue(path, out var bytes))
            throw new FileNotFoundException(path);
        if (TruncatedDownloadSizes.TryGetValue(path, out var truncatedTo))
        {
            var clipped = Math.Min(truncatedTo, bytes.Length);
            var sliced = new byte[clipped];
            Array.Copy(bytes, sliced, clipped);
            bytes = sliced;
        }
        // 実 server は HTTP Range ヘッダで該当範囲だけストリームするので、
        // fake も同等の動作にする (offset/length に従って byte[] を切り出す)。
        var startOffset = (int)Math.Min(Math.Max(offset, 0), bytes.Length);
        var endOffset = length < 0
            ? bytes.Length
            : (int)Math.Min(offset + length, bytes.Length);
        if (endOffset < startOffset) endOffset = startOffset;
        var rangeLen = endOffset - startOffset;
        var rangeBytes = new byte[rangeLen];
        Array.Copy(bytes, startOffset, rangeBytes, 0, rangeLen);
        return Task.FromResult<Stream>(new MemoryStream(rangeBytes, writable: false));
    }

    public async Task<UploadResult> UploadFileAsync(string path, Stream content, CancellationToken ct = default)
    {
        using var ms = new MemoryStream();
        await content.CopyToAsync(ms, ct).ConfigureAwait(false);
        var bytes = ms.ToArray();
        Files[path] = bytes;
        return new UploadResult(bytes.LongLength, DateTime.UtcNow);
    }

    public Task DeleteFileAsync(string path, CancellationToken ct = default)
    {
        Files.Remove(path);
        return Task.CompletedTask;
    }

    public Task<LockInfo?> AcquireLockAsync(string path, CancellationToken ct = default)
    {
        AcquireLockCalls++;
        if (DenyAcquireLock) return Task.FromResult<LockInfo?>(null);
        var now = DateTime.UtcNow;
        var info = new LockInfo(1, now.ToString("o"), now.AddSeconds(30).ToString("o"));
        return Task.FromResult<LockInfo?>(info);
    }

    public Task ReleaseLockAsync(string path, CancellationToken ct = default)
    {
        ReleaseLockCalls++;
        return Task.CompletedTask;
    }

    /// <summary>テスト用: GetVolumeStatsAsync で返す値。デフォルトは適当な値。</summary>
    public VolumeStats VolumeStats { get; set; } =
        new VolumeStats(TotalSize: 1024L * 1024 * 1024, FreeSize: 512L * 1024 * 1024);

    public Task<VolumeStats> GetVolumeStatsAsync(CancellationToken ct = default) =>
        Task.FromResult(VolumeStats);

    public Task CreateFolderAsync(string path, CancellationToken ct = default) =>
        Task.CompletedTask;

    public Task RenameAsync(string oldPath, string newPath, CancellationToken ct = default)
    {
        if (Files.Remove(oldPath, out var bytes)) Files[newPath] = bytes;
        return Task.CompletedTask;
    }

    // ─────────────────────────────────────── ADR-025 chunked upload ─────────

    /// <summary>
    /// 進行中の upload session を path で観察できるようにしておく。
    /// テストからは「セッション中の状態は path 単位で 1 つだけ」「finalize で
    /// disappear」のように使う。
    /// </summary>
    public sealed class FakeUploadSession
    {
        public required string UploadId { get; init; }
        public required string Path { get; init; }
        public required bool BaseFromExisting { get; init; }
        public byte[] Buffer = Array.Empty<byte>();
        public int Length;
        public int ChunkPatchCount;
        // multipart/mixed PATCH の累積カウント (新 coalescer 経路)。
        public int MultipartPatchCount;
        public int MultipartRangeCount;
        public bool Finalized;
        public bool Aborted;
    }

    public Dictionary<string, FakeUploadSession> SessionsByUploadId { get; } =
        new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// 直近 (または進行中) のセッションを path で取れるヘルパ。テストが
    /// session の chunk count などを覗くのに使う。
    /// </summary>
    public FakeUploadSession? FindSessionByPath(string path)
    {
        foreach (var s in SessionsByUploadId.Values)
        {
            if (string.Equals(s.Path, path, StringComparison.OrdinalIgnoreCase))
                return s;
        }
        return null;
    }

    public Task<string> StartUploadAsync(string path, bool baseFromExisting, CancellationToken ct = default)
    {
        var uploadId = Guid.NewGuid().ToString();
        var session = new FakeUploadSession
        {
            UploadId = uploadId,
            Path = path,
            BaseFromExisting = baseFromExisting,
        };
        if (baseFromExisting && Files.TryGetValue(path, out var existing))
        {
            session.Buffer = ArrayPool<byte>.Shared.Rent(existing.Length);
            Array.Copy(existing, session.Buffer, existing.Length);
            session.Length = existing.Length;
        }
        SessionsByUploadId[uploadId] = session;
        return Task.FromResult(uploadId);
    }

    public Task UploadChunkAsync(string uploadId, long offset, ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        if (!SessionsByUploadId.TryGetValue(uploadId, out var session))
            throw new InvalidOperationException("session not found");

        // 同一セッションへの concurrent PATCH (= 別 handle や test 上の並列呼び出し)
        // が起きても、実 server は POSIX file への seek+write で順序化されているため
        // race は出ない。ここでも振る舞いを合わせて lock で直列化する。
        // (この lock を外すと Buffer 拡張時の read-modify-write 競合で
        // 先勝ち分が drop されるケースがある)。
        lock (session)
        {
            session.ChunkPatchCount++;

            var end = checked((int)(offset + data.Length));
            if (end > session.Buffer.Length)
            {
                var newBuf = new byte[end];
                Array.Copy(session.Buffer, newBuf, session.Length);
                session.Buffer = newBuf;
            }
            data.Span.CopyTo(session.Buffer.AsSpan((int)offset, data.Length));
            if (end > session.Length) session.Length = end;
        }
        return Task.CompletedTask;
    }

    public Task UploadChunksMultipartAsync(
        string uploadId,
        ReadOnlyMemory<byte> buffer,
        IReadOnlyList<UploadRange> ranges,
        CancellationToken ct = default)
    {
        if (!SessionsByUploadId.TryGetValue(uploadId, out var session))
            throw new InvalidOperationException("session not found");

        lock (session)
        {
            session.MultipartPatchCount++;
            session.MultipartRangeCount += ranges.Count;
            foreach (var range in ranges)
            {
                var end = checked((int)(range.FileOffset + range.Length));
                if (end > session.Buffer.Length)
                {
                    var newBuf = new byte[end];
                    Array.Copy(session.Buffer, newBuf, session.Length);
                    session.Buffer = newBuf;
                }
                var src = buffer.Span.Slice(range.BufferOffset, range.Length);
                src.CopyTo(session.Buffer.AsSpan((int)range.FileOffset, range.Length));
                if (end > session.Length) session.Length = end;
            }
        }
        return Task.CompletedTask;
    }

    public Task<UploadResult> FinalizeUploadAsync(string uploadId, long finalSize, CancellationToken ct = default)
    {
        if (!SessionsByUploadId.TryGetValue(uploadId, out var session))
            throw new InvalidOperationException("session not found");
        session.Finalized = true;

        // ftruncate(finalSize) 相当: 末尾切り詰め / 0 拡張。
        var size = checked((int)finalSize);
        if (size > session.Length)
        {
            var newBuf = new byte[size];
            Array.Copy(session.Buffer, newBuf, session.Length);
            session.Buffer = newBuf;
            session.Length = size;
        }
        else if (size < session.Length)
        {
            session.Length = size;
        }

        var payload = new byte[session.Length];
        Array.Copy(session.Buffer, payload, session.Length);
        Files[session.Path] = payload;
        return Task.FromResult(new UploadResult(session.Length, DateTime.UtcNow));
    }

    public Task AbortUploadAsync(string uploadId, CancellationToken ct = default)
    {
        if (SessionsByUploadId.TryGetValue(uploadId, out var session))
        {
            session.Aborted = true;
        }
        return Task.CompletedTask;
    }

    // 以下は ServerBackend からは呼ばれないので未実装で十分。
    public Task<IReadOnlyList<FileNode>> ListDirectoryAsync(string path, CancellationToken ct = default) =>
        throw new NotImplementedException();

    public Task<FileNode> GetFileInfoAsync(string path, CancellationToken ct = default) =>
        throw new NotImplementedException();
}
