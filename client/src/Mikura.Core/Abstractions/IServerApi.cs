using Mikura.Core.Models;

namespace Mikura.Core.Abstractions;

public interface IServerApi
{
    Task<IReadOnlyList<FileNode>> ListDirectoryAsync(string path, CancellationToken ct = default);
    Task<IReadOnlyList<TreeNode>> GetTreeAsync(CancellationToken ct = default);
    Task<FileNode> GetFileInfoAsync(string path, CancellationToken ct = default);
    /// <summary>
    /// 指定 path / range の content を Stream として返す。Stream を Dispose
    /// (or DisposeAsync) すると、その下の HTTP response 等の所有資源も同時に
    /// 解放される (transport 実装側の責務)。
    /// 対象 path が存在しない場合は <see cref="FileNotFoundException"/> を投げる
    /// (transport-specific な 404 例外を呼び出し側で意識しなくて済むようにする)。
    /// </summary>
    Task<Stream> DownloadFileAsync(string path, long offset = 0, long length = -1, CancellationToken ct = default);
    Task<UploadResult> UploadFileAsync(string path, Stream content, CancellationToken ct = default);
    Task DeleteFileAsync(string path, CancellationToken ct = default);

    /// <summary>
    /// ディレクトリを 1 段だけ作成する。親が無ければ 404、既に同名があれば 409。
    /// </summary>
    Task CreateFolderAsync(string path, CancellationToken ct = default);

    /// <summary>
    /// ファイル/ディレクトリの rename。サーバ側で旧→新へ移動する。衝突時 409。
    /// </summary>
    Task RenameAsync(string oldPath, string newPath, CancellationToken ct = default);

    /// <summary>
    /// 排他ロックを取得する。同一ユーザーで既存ロックがある場合は expiresAt を延長する (renew として使える)。
    /// 他ユーザーが保持している場合は null を返す (HTTP 409)。
    /// </summary>
    Task<LockInfo?> AcquireLockAsync(string path, CancellationToken ct = default);

    Task ReleaseLockAsync(string path, CancellationToken ct = default);

    /// <summary>
    /// storage が乗っている FS の容量 (Z: ドライブの「ディスクの空き容量」表示用)。
    /// 高頻度呼出は想定されていない (server 側 statfs(2) は cheap だが per-call
    /// system call なのでクライアント側で短期キャッシュ推奨)。
    /// </summary>
    Task<VolumeStats> GetVolumeStatsAsync(CancellationToken ct = default);

    /// <summary>
    /// ADR-025: byte-range chunked upload セッションを開始する。
    /// <paramref name="baseFromExisting"/> = true の場合、既存ファイルを temp に
    /// 複製してから session を返す (modify-in-place)。新規作成の場合は false。
    /// 戻り値は uploadId (UUID v4)。
    /// </summary>
    Task<string> StartUploadAsync(string path, bool baseFromExisting, CancellationToken ct = default);

    /// <summary>
    /// ADR-025: chunked upload session に対して任意 offset への chunk を書き込む。
    /// 同一 session への並行 PATCH は OS level で seek+write が独立するため安全。
    /// </summary>
    Task UploadChunkAsync(string uploadId, long offset, ReadOnlyMemory<byte> data, CancellationToken ct = default);

    /// <summary>
    /// 複数 range を 1 PATCH (multipart/byteranges) でまとめて送る。WriteCoalescer
    /// が非連続な小 IRP をバッファに pack し、1 リクエストで HTTP round-trip を 1 回に
    /// 集約する経路。<paramref name="ranges"/> の各 entry は <paramref name="buffer"/>
    /// 内の <c>BufferOffset..BufferOffset+Length</c> を、サーバ側 staging の
    /// <c>FileOffset</c> に書く。
    /// </summary>
    Task UploadChunksMultipartAsync(
        string uploadId,
        ReadOnlyMemory<byte> buffer,
        IReadOnlyList<Mikura.Core.Models.UploadRange> ranges,
        CancellationToken ct = default);

    /// <summary>
    /// ADR-025: chunked upload session を確定する。
    /// <paramref name="finalSize"/> で末尾を ftruncate して、temp → 実 path に
    /// 原子 rename する。戻り値は確定後のサーバ side メタデータ。
    /// </summary>
    Task<UploadResult> FinalizeUploadAsync(string uploadId, long finalSize, CancellationToken ct = default);

    /// <summary>
    /// ADR-025: chunked upload session を破棄する。
    /// Cleanup-without-Modified、エラー時の後始末から呼ばれる。
    /// </summary>
    Task AbortUploadAsync(string uploadId, CancellationToken ct = default);
}
