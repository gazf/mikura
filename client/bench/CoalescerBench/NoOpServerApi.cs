using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace Mikura.Bench.Coalescer;

/// <summary>
/// 純 C# 経路のコストだけを測るための IServerApi。すべて即時 return、
/// ストレージは持たない。FakeServerApi が test 用に持っている lock + buffer
/// copy 等の overhead を除いて、FileSystemBackend / WriteCoalescer / multipart 直前
/// までのコストを取り出す。
/// </summary>
internal sealed class NoOpServerApi : IServerApi
{
    private long _uploadCounter;
    public long UploadChunkCalls;
    public long UploadMultipartCalls;
    public long MultipartRangesTotal;
    public long BytesUploaded;

    public Task<IReadOnlyList<TreeNode>> GetTreeAsync(CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<TreeNode>>(Array.Empty<TreeNode>());

    public Task<IReadOnlyList<FileNode>> ListDirectoryAsync(string path, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<FileNode>>(Array.Empty<FileNode>());

    public Task<FileNode> GetFileInfoAsync(string path, CancellationToken ct = default) =>
        throw new NotSupportedException();

    public Task<Stream> DownloadFileAsync(string path, long offset = 0, long length = -1, CancellationToken ct = default) =>
        Task.FromResult<Stream>(Stream.Null);

    public Task<UploadResult> UploadFileAsync(string path, Stream content, CancellationToken ct = default) =>
        Task.FromResult(new UploadResult(0, DateTime.UtcNow));

    public Task DeleteFileAsync(string path, CancellationToken ct = default) =>
        Task.CompletedTask;

    public Task CreateFolderAsync(string path, CancellationToken ct = default) =>
        Task.CompletedTask;

    public Task RenameAsync(string oldPath, string newPath, CancellationToken ct = default) =>
        Task.CompletedTask;

    public Task<LockInfo?> AcquireLockAsync(string path, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        return Task.FromResult<LockInfo?>(new LockInfo(
            1, now.ToString("o"), now.AddSeconds(30).ToString("o")));
    }

    public Task ReleaseLockAsync(string path, CancellationToken ct = default) =>
        Task.CompletedTask;

    public Task<VolumeStats> GetVolumeStatsAsync(CancellationToken ct = default) =>
        Task.FromResult(new VolumeStats(1L << 40, 1L << 39));

    public Task<string> StartUploadAsync(string path, bool baseFromExisting, CancellationToken ct = default)
    {
        var id = Interlocked.Increment(ref _uploadCounter);
        return Task.FromResult($"noop-{id:x}");
    }

    public Task UploadChunkAsync(string uploadId, long offset, ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        Interlocked.Increment(ref UploadChunkCalls);
        Interlocked.Add(ref BytesUploaded, data.Length);
        return Task.CompletedTask;
    }

    public Task UploadChunksMultipartAsync(
        string uploadId,
        ReadOnlyMemory<byte> buffer,
        IReadOnlyList<UploadRange> ranges,
        CancellationToken ct = default)
    {
        Interlocked.Increment(ref UploadMultipartCalls);
        Interlocked.Add(ref MultipartRangesTotal, ranges.Count);
        long total = 0;
        for (int i = 0; i < ranges.Count; i++) total += ranges[i].Length;
        Interlocked.Add(ref BytesUploaded, total);
        return Task.CompletedTask;
    }

    public Task<UploadResult> FinalizeUploadAsync(string uploadId, long finalSize, CancellationToken ct = default) =>
        Task.FromResult(new UploadResult(finalSize, DateTime.UtcNow));

    public Task AbortUploadAsync(string uploadId, CancellationToken ct = default) =>
        Task.CompletedTask;
}
