using System.Buffers;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Unicode;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace Mikura.Transport;

public class ApiException(string message, int statusCode) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
}

/// <summary>
/// <para>すべての <c>HttpRequestMessage</c> / <c>HttpResponseMessage</c> は
/// <c>using</c> で必ず dispose する。dispose を漏らすと Content (= byte[] 参照)
/// が GC まで居残り、ChunkedUploader が <c>ArrayPool.Return</c> したあとも
/// 物理メモリが解放されない (実機: 数十 MB の動画ファイル copy で数百 MB のリーク観測)。
/// HttpClient レベルの接続再利用にも影響するので、一律 using で受ける。</para>
/// </summary>
public class HttpServerApi(HttpClient http, string baseUrl) : IServerApi, IDisposable
{
    private readonly HttpClient _http = http;
    private readonly string _baseUrl = baseUrl.TrimEnd('/');

    // PATCH chunk + multipart part の Content-Type は固定 octet-stream。
    // MediaTypeHeaderValue は parameters を mutate しない限り read-only に扱えるので、
    // 全リクエストで共有して per-part alloc を回避する (multipart で 1 PATCH あたり
    // 64 part 以上になるケースで効果)。
    private static readonly MediaTypeHeaderValue OctetStreamContentType =
        new("application/octet-stream");

    public async Task<IReadOnlyList<TreeNode>> GetTreeAsync(CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/tree";
        using var response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync(TransportJsonContext.Default.ListTreeNode, ct).ConfigureAwait(false) ?? [];
    }

    public async Task<IReadOnlyList<FileNode>> ListDirectoryAsync(string path, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/files{NormalizePath(path)}";
        using var response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync(TransportJsonContext.Default.ListFileNode, ct).ConfigureAwait(false) ?? [];
    }

    public async Task<FileNode> GetFileInfoAsync(string path, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/files{NormalizePath(path)}";
        using var response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync(TransportJsonContext.Default.FileNode, ct).ConfigureAwait(false)
            ?? throw new ApiException("Failed to parse response", 500);
    }

    public async Task<Stream> DownloadFileAsync(string path, long offset = 0, long length = -1, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/content{NormalizePath(path)}";
        // 成功パスでは ResponseOwningStream が response の所有権を持ち、stream
        // を Dispose したときに HttpResponseMessage も同時に閉じる。
        var request = new HttpRequestMessage(HttpMethod.Get, url);

        if (offset > 0 || length > 0)
        {
            var end = length > 0 ? offset + length - 1 : (long?)null;
            request.Headers.Range = new RangeHeaderValue(offset, end);
        }

        HttpResponseMessage? response = null;
        try
        {
            response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            await EnsureSuccess(response, ct).ConfigureAwait(false);
            var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            return new ResponseOwningStream(stream, response);
        }
        catch (ApiException ex) when (ex.StatusCode == 404)
        {
            // IServerApi 契約: 404 は FileNotFoundException として通知する。
            // Excel save dance で rename された旧 temp path への stale read 等で
            // 頻発するため、上位 (WinFsp.Interop) が STATUS_OBJECT_NAME_NOT_FOUND に
            // マップして kernel の retry を止められるよう、専用例外に変換する。
            response?.Dispose();
            throw new FileNotFoundException(ex.Message, path);
        }
        catch
        {
            response?.Dispose();
            throw;
        }
        finally
        {
            request.Dispose();
        }
    }

    /// <summary>
    /// 外に出す stream を dispose した時に <see cref="HttpResponseMessage"/>
    /// も一緒に閉じるための薄いラッパ。HttpClient の接続を確実にプールへ
    /// 戻すため必須。
    /// </summary>
    private sealed class ResponseOwningStream(Stream inner, HttpResponseMessage response) : Stream
    {
        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => inner.CanSeek;
        public override bool CanWrite => inner.CanWrite;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override void Flush() => inner.Flush();
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override int Read(Span<byte> buffer) => inner.Read(buffer);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) => inner.ReadAsync(buffer, ct);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct) => inner.ReadAsync(buffer, offset, count, ct);
        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void SetLength(long value) => inner.SetLength(value);
        public override void Write(byte[] buffer, int offset, int count) => inner.Write(buffer, offset, count);

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
                response.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    public async Task<UploadResult> UploadFileAsync(string path, Stream content, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/content{NormalizePath(path)}";
        using var streamContent = new StreamContent(content);
        streamContent.Headers.ContentType = OctetStreamContentType;
        using var response = await _http.PutAsync(url, streamContent, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync(TransportJsonContext.Default.UploadResult, ct).ConfigureAwait(false)
            ?? throw new ApiException("Failed to parse upload response", 500);
    }

    public async Task DeleteFileAsync(string path, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/files{NormalizePath(path)}";
        using var response = await _http.DeleteAsync(url, ct).ConfigureAwait(false);
        if ((int)response.StatusCode == 404) return;
        await EnsureSuccess(response, ct).ConfigureAwait(false);
    }

    public async Task CreateFolderAsync(string path, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/folders{NormalizePath(path)}";
        using var response = await _http.PostAsync(url, null, ct).ConfigureAwait(false);
        // 既に存在 (409) は冪等扱い: クライアント側で先回りして作成済みのケース。
        if ((int)response.StatusCode == 409) return;
        await EnsureSuccess(response, ct).ConfigureAwait(false);
    }

    public async Task RenameAsync(string oldPath, string newPath, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/files{NormalizePath(oldPath)}";
        using var response = await _http.PatchAsJsonAsync(
            url,
            new RenameRequest(NormalizePath(newPath)),
            TransportJsonContext.Default.RenameRequest,
            ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
    }

    public async Task<LockInfo?> AcquireLockAsync(string path, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/locks{NormalizePath(path)}";
        using var response = await _http.PostAsync(url, null, ct).ConfigureAwait(false);
        // 他ユーザーが保持中は HTTP 409 → 例外ではなく null で返す (呼び出し側でハンドル)
        if ((int)response.StatusCode == 409) return null;
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync(TransportJsonContext.Default.LockInfo, ct).ConfigureAwait(false);
    }

    public async Task ReleaseLockAsync(string path, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/locks{NormalizePath(path)}";
        using var response = await _http.DeleteAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
    }

    public async Task<VolumeStats> GetVolumeStatsAsync(CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/volume";
        using var response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync(TransportJsonContext.Default.VolumeStats, ct).ConfigureAwait(false)
            ?? throw new ApiException("Failed to parse volume stats", 500);
    }

    public async Task<string> StartUploadAsync(string path, bool baseFromExisting, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/uploads";
        using var response = await _http.PostAsJsonAsync(
            url,
            new StartUploadRequest(NormalizePath(path), baseFromExisting),
            TransportJsonContext.Default.StartUploadRequest,
            ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        var result = await response.Content.ReadFromJsonAsync(TransportJsonContext.Default.StartUploadResponse, ct).ConfigureAwait(false)
            ?? throw new ApiException("Failed to parse start-upload response", 500);
        return result.UploadId;
    }

    public async Task UploadChunkAsync(string uploadId, long offset, ReadOnlyMemory<byte> data, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/uploads/{uploadId}";
        var end = offset + data.Length - 1;
        // request / response を必ず dispose する: ReadOnlyMemoryContent は data
        // (= ChunkedUploader pool 由来の byte[]) を参照保持しているので、ここで
        // dispose を漏らすと pool が Return してもプロセスメモリは解放されない。
        using var request = new HttpRequestMessage(HttpMethod.Patch, url)
        {
            Content = new ReadOnlyMemoryContent(data),
        };
        // chunk byte は session の意味で連続している必要はない (random offset)。
        // total は不明なので '*' を使う。
        request.Content.Headers.ContentType = OctetStreamContentType;
        request.Content.Headers.Add("Content-Range", $"bytes {offset}-{end}/*");
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
    }

    public async Task UploadChunksMultipartAsync(
        string uploadId,
        ReadOnlyMemory<byte> buffer,
        IReadOnlyList<UploadRange> ranges,
        CancellationToken ct = default)
    {
        if (ranges.Count == 0) return;
        var url = $"{_baseUrl}/uploads/{uploadId}";
        // boundary は ASCII 印字可かつ body 中に出現しない事が前提だが、CDM 等の
        // ランダムバイナリは衝突可能性がゼロでない。実用上は GUID 形式で十分
        // (128bit 衝突空間 + boundary プレフィクスを工夫すれば事実上ゼロ)。
        var boundary = $"mikura-{Guid.NewGuid():N}";
        using var content = new MultipartRangesContent(boundary, buffer, ranges);
        using var request = new HttpRequestMessage(HttpMethod.Patch, url) { Content = content };
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// ADR-029: multipart/mixed (RFC 2046 §5.1.3) body を直接 stream に書き出す
    /// <see cref="HttpContent"/>。<see cref="MultipartContent"/> + per-part
    /// <see cref="ReadOnlyMemoryContent"/> 構成より alloc を 1 PATCH あたり数十
    /// オブジェクト → 数個に削減する。
    ///
    /// <para>per-part の payload は buffer の slice をそのまま <c>stream.WriteAsync</c>
    /// に渡すので zero-copy。header bytes は ArrayPool 貸出の小バッファに
    /// <c>Utf8.TryWrite</c> で format して書く (中間 string 0 個)。
    /// <see cref="TryComputeLength"/> を実装しているので Content-Length 確定 →
    /// chunked transfer-encoding を回避できる。媒体型自体に方向制限のない
    /// multipart/mixed を採用したのは IANA registry が multipart/byteranges の
    /// "206 response 以外での流用" を非推奨としているため (ADR-029 参照)。</para>
    /// </summary>
    private sealed class MultipartRangesContent : HttpContent
    {
        // 全 PATCH で共有する不変 header bytes。
        private static readonly byte[] PartHeaderPrefix =
            "Content-Type: application/octet-stream\r\nContent-Range: "u8.ToArray();
        private static readonly byte[] HeaderTerminator = "\r\n\r\n"u8.ToArray();

        private readonly string _boundary;
        private readonly ReadOnlyMemory<byte> _buffer;
        private readonly IReadOnlyList<UploadRange> _ranges;

        public MultipartRangesContent(string boundary, ReadOnlyMemory<byte> buffer, IReadOnlyList<UploadRange> ranges)
        {
            _boundary = boundary;
            _buffer = buffer;
            _ranges = ranges;
            Headers.ContentType = new MediaTypeHeaderValue("multipart/mixed");
            Headers.ContentType.Parameters.Add(new NameValueHeaderValue("boundary", boundary));
        }

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) =>
            SerializeAsync(stream, CancellationToken.None);

        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context, CancellationToken cancellationToken) =>
            SerializeAsync(stream, cancellationToken);

        private async Task SerializeAsync(Stream stream, CancellationToken ct)
        {
            // boundary を含む 3 種類の delimiter 行は per-PATCH 1 個ずつ alloc
            // (boundary が GUID で request 固有のため使い回し不可)。
            var firstBoundary = Encoding.ASCII.GetBytes($"--{_boundary}\r\n");
            var midBoundary = Encoding.ASCII.GetBytes($"\r\n--{_boundary}\r\n");
            var finalBoundary = Encoding.ASCII.GetBytes($"\r\n--{_boundary}--\r\n");

            // Content-Range の数値部分用の小バッファ。"bytes X-Y/*" は long 最大でも
            // 9 + 19 + 19 = 47 byte に収まる。
            var rangeBuf = ArrayPool<byte>.Shared.Rent(64);
            try
            {
                for (int i = 0; i < _ranges.Count; i++)
                {
                    var r = _ranges[i];
                    await stream.WriteAsync(i == 0 ? firstBoundary : midBoundary, ct).ConfigureAwait(false);
                    await stream.WriteAsync(PartHeaderPrefix, ct).ConfigureAwait(false);

                    long end = r.FileOffset + r.Length - 1;
                    if (!Utf8.TryWrite(rangeBuf, $"bytes {r.FileOffset}-{end}/*", out int written))
                        throw new InvalidOperationException("Content-Range buffer too small");
                    await stream.WriteAsync(rangeBuf.AsMemory(0, written), ct).ConfigureAwait(false);

                    await stream.WriteAsync(HeaderTerminator, ct).ConfigureAwait(false);
                    await stream.WriteAsync(_buffer.Slice(r.BufferOffset, r.Length), ct).ConfigureAwait(false);
                }
                await stream.WriteAsync(finalBoundary, ct).ConfigureAwait(false);
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(rangeBuf);
            }
        }

        protected override bool TryComputeLength(out long length)
        {
            if (_ranges.Count == 0) { length = 0; return true; }

            int b = _boundary.Length;
            // first boundary "--<B>\r\n" = 4 + B
            // mid boundary   "\r\n--<B>\r\n" = 6 + B
            // final boundary "\r\n--<B>--\r\n" = 8 + B
            long total = (4 + b)                              // first boundary
                       + (long)(_ranges.Count - 1) * (6 + b)  // mid boundaries
                       + (8 + b);                             // final boundary

            int prefixLen = PartHeaderPrefix.Length;
            int terminatorLen = HeaderTerminator.Length;
            foreach (var r in _ranges)
            {
                long end = r.FileOffset + r.Length - 1;
                // "bytes X-Y/*" = 6 + digits(X) + 1 + digits(Y) + 2 = 9 + digits(X) + digits(Y)
                int contentRangeLen = 9 + CountDigits(r.FileOffset) + CountDigits(end);
                total += prefixLen + contentRangeLen + terminatorLen + r.Length;
            }
            length = total;
            return true;
        }

        private static int CountDigits(long n)
        {
            if (n == 0) return 1;
            if (n < 0) n = -n; // file offset は非負前提だが防御的に。
            int count = 0;
            while (n > 0) { count++; n /= 10; }
            return count;
        }
    }

    public async Task<UploadResult> FinalizeUploadAsync(string uploadId, long finalSize, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/uploads/{uploadId}/finalize";
        using var response = await _http.PostAsJsonAsync(
            url,
            new FinalizeRequest(finalSize),
            TransportJsonContext.Default.FinalizeRequest,
            ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        return await response.Content.ReadFromJsonAsync(TransportJsonContext.Default.UploadResult, ct).ConfigureAwait(false)
            ?? throw new ApiException("Failed to parse finalize response", 500);
    }

    public async Task AbortUploadAsync(string uploadId, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/uploads/{uploadId}";
        using var response = await _http.DeleteAsync(url, ct).ConfigureAwait(false);
        // 既に finalize/abort 済みなど 404 は冪等扱い。
        if ((int)response.StatusCode == 404) return;
        await EnsureSuccess(response, ct).ConfigureAwait(false);
    }

    private static string NormalizePath(string path)
    {
        path = path.Replace('\\', '/');
        if (!path.StartsWith('/'))
            path = "/" + path;
        return path;
    }

    private static async Task EnsureSuccess(HttpResponseMessage response, CancellationToken ct = default)
    {
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            string message;
            try
            {
                var error = JsonSerializer.Deserialize(body, TransportJsonContext.Default.ErrorResponse);
                message = error?.Message ?? body;
            }
            catch
            {
                message = body;
            }
            throw new ApiException(message, (int)response.StatusCode);
        }
    }

    public void Dispose()
    {
        _http.Dispose();
    }
}
