using System.Net.Http.Headers;
using System.Text.Json;
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

    public async Task<IReadOnlyList<TreeNode>> GetTreeAsync(CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/tree";
        using var response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        var json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return JsonSerializer.Deserialize<List<TreeNode>>(json) ?? [];
    }

    public async Task<IReadOnlyList<FileNode>> ListDirectoryAsync(string path, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/files{NormalizePath(path)}";
        using var response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        var json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return JsonSerializer.Deserialize<List<FileNode>>(json) ?? [];
    }

    public async Task<FileNode> GetFileInfoAsync(string path, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/files{NormalizePath(path)}";
        using var response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        var json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return JsonSerializer.Deserialize<FileNode>(json)
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
        streamContent.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        using var response = await _http.PutAsync(url, streamContent, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        var json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return JsonSerializer.Deserialize<UploadResult>(json)
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
        var body = JsonSerializer.Serialize(new { newPath = NormalizePath(newPath) });
        using var request = new HttpRequestMessage(HttpMethod.Patch, url)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
        };
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
    }

    public async Task<LockInfo?> AcquireLockAsync(string path, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/locks{NormalizePath(path)}";
        using var response = await _http.PostAsync(url, null, ct).ConfigureAwait(false);
        // 他ユーザーが保持中は HTTP 409 → 例外ではなく null で返す (呼び出し側でハンドル)
        if ((int)response.StatusCode == 409) return null;
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        var json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return JsonSerializer.Deserialize<LockInfo>(json);
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
        var json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return JsonSerializer.Deserialize<VolumeStats>(json)
            ?? throw new ApiException("Failed to parse volume stats", 500);
    }

    public async Task<string> StartUploadAsync(string path, bool baseFromExisting, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/uploads";
        var body = JsonSerializer.Serialize(new
        {
            path = NormalizePath(path),
            baseFromExisting,
        });
        using var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync(url, content, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        var json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        var result = JsonSerializer.Deserialize<StartUploadResponse>(json)
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
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        request.Content.Headers.Add("Content-Range", $"bytes {offset}-{end}/*");
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
    }

    public async Task<UploadResult> FinalizeUploadAsync(string uploadId, long finalSize, CancellationToken ct = default)
    {
        var url = $"{_baseUrl}/uploads/{uploadId}/finalize";
        var body = JsonSerializer.Serialize(new { size = finalSize });
        using var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");
        using var response = await _http.PostAsync(url, content, ct).ConfigureAwait(false);
        await EnsureSuccess(response, ct).ConfigureAwait(false);
        var json = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        return JsonSerializer.Deserialize<UploadResult>(json)
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

    private sealed record StartUploadResponse(
        [property: System.Text.Json.Serialization.JsonPropertyName("uploadId")] string UploadId,
        [property: System.Text.Json.Serialization.JsonPropertyName("path")] string Path
    );

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
                var error = JsonSerializer.Deserialize<ErrorResponse>(body);
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
