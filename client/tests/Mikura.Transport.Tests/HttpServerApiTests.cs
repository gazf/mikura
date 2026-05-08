using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Mikura.Core.Models;
using Mikura.Transport;
using Xunit;

namespace Mikura.Transport.Tests;

/// <summary>
/// HttpServerApi の責務:
///   - REST 各エンドポイントへ正しい URL / メソッドで問い合わせる。
///   - GET /content/* レスポンスの X-File-Attributes ヘッダを HydratedContent に
///     反映する (ADR-019)。
///   - POST /locks/* が 409 を返したら null を返す (呼び出し側で「他ユーザー保持中」
///     と区別できるようにする)。
///   - 他のエラー (4xx/5xx) は ApiException としてラップして throw する。
///
/// HttpClient 自体は HttpMessageHandler で差し替えてテストする
/// (実 HTTP listener を立てない、純単体テスト)。
/// </summary>
public class HttpServerApiTests
{
    /// <summary>
    /// SendAsync を関数で差し替えできる HttpMessageHandler。
    /// テストごとに「期待されるリクエスト → 返すべきレスポンス」を記述する。
    /// </summary>
    private sealed class FakeHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> _responder;
        public List<HttpRequestMessage> Requests { get; } = new();

        public FakeHandler(Func<HttpRequestMessage, HttpResponseMessage> responder)
        {
            _responder = responder;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(_responder(request));
        }
    }

    private static (HttpServerApi server, FakeHandler handler) NewServer(
        Func<HttpRequestMessage, HttpResponseMessage> responder)
    {
        var handler = new FakeHandler(responder);
        var http = new HttpClient(handler);
        var server = new HttpServerApi(http, "http://localhost:8700");
        return (server, handler);
    }

    private static HttpResponseMessage Json(HttpStatusCode code, string body)
    {
        var msg = new HttpResponseMessage(code)
        {
            Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
        };
        return msg;
    }

    // ---------- DownloadFileAsync ----------

    [Fact]
    public async Task DownloadFileAsync_HitsContentEndpointWithNormalizedPath()
    {
        var (server, handler) = NewServer(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new ByteArrayContent(new byte[] { 1, 2, 3 }),
        });

        await using var hydrated = await server.DownloadFileAsync("public/hello.txt");

        var req = handler.Requests.Single();
        Assert.Equal(HttpMethod.Get, req.Method);
        // 先頭スラッシュが補われ、/content/public/hello.txt になる
        Assert.Equal("http://localhost:8700/content/public/hello.txt", req.RequestUri!.ToString());
    }

    [Fact]
    public async Task DownloadFileAsync_RangeRequestedSetsRangeHeader()
    {
        HttpRequestMessage? captured = null;
        var (server, _) = NewServer(req =>
        {
            captured = req;
            return new HttpResponseMessage(HttpStatusCode.PartialContent)
            {
                Content = new ByteArrayContent(Array.Empty<byte>()),
            };
        });

        await using var _ = await server.DownloadFileAsync("/x.txt", offset: 100, length: 50);

        Assert.NotNull(captured!.Headers.Range);
        var range = captured.Headers.Range!.Ranges.Single();
        Assert.Equal(100, range.From);
        Assert.Equal(149, range.To); // offset + length - 1
    }

    [Fact]
    public async Task DownloadFileAsync_ServerError_ThrowsApiException()
    {
        var (server, _) = NewServer(_ => Json(HttpStatusCode.InternalServerError, "{\"message\":\"boom\"}"));
        var ex = await Assert.ThrowsAsync<ApiException>(() => server.DownloadFileAsync("/x.txt"));
        Assert.Equal(500, ex.StatusCode);
    }

    // ---------- AcquireLockAsync ----------

    [Fact]
    public async Task AcquireLockAsync_Success_ReturnsLockInfo()
    {
        var body = "{\"userId\":1,\"acquiredAt\":\"2026-04-29T00:00:00Z\",\"expiresAt\":\"2026-04-29T00:00:30Z\"}";
        var (server, handler) = NewServer(_ => Json(HttpStatusCode.OK, body));

        var lockInfo = await server.AcquireLockAsync("/foo.txt");

        Assert.NotNull(lockInfo);
        Assert.Equal(1, lockInfo!.UserId);
        // POST /locks/foo.txt
        var req = handler.Requests.Single();
        Assert.Equal(HttpMethod.Post, req.Method);
        Assert.Equal("http://localhost:8700/locks/foo.txt", req.RequestUri!.ToString());
    }

    [Fact]
    public async Task AcquireLockAsync_409_ReturnsNullInsteadOfThrowing()
    {
        var (server, _) = NewServer(_ => Json(HttpStatusCode.Conflict, "{\"message\":\"locked\"}"));
        var lockInfo = await server.AcquireLockAsync("/foo.txt");
        Assert.Null(lockInfo); // 呼び出し側 (MikuraSyncCallbacks) は null で「他ユーザー保持中」を判定する
    }

    [Fact]
    public async Task AcquireLockAsync_403_Throws()
    {
        var (server, _) = NewServer(_ => Json(HttpStatusCode.Forbidden, "{\"message\":\"no write perm\"}"));
        var ex = await Assert.ThrowsAsync<ApiException>(() => server.AcquireLockAsync("/foo.txt"));
        Assert.Equal(403, ex.StatusCode);
    }

    // ---------- ReleaseLockAsync ----------

    [Fact]
    public async Task ReleaseLockAsync_HitsLocksDeleteEndpoint()
    {
        var (server, handler) = NewServer(_ => Json(HttpStatusCode.OK, "{\"message\":\"Unlocked\"}"));

        await server.ReleaseLockAsync("/private/secret.txt");

        var req = handler.Requests.Single();
        Assert.Equal(HttpMethod.Delete, req.Method);
        Assert.Equal("http://localhost:8700/locks/private/secret.txt", req.RequestUri!.ToString());
    }

    [Fact]
    public async Task ReleaseLockAsync_403_Throws()
    {
        var (server, _) = NewServer(_ => Json(HttpStatusCode.Forbidden, "{\"message\":\"not holder\"}"));
        await Assert.ThrowsAsync<ApiException>(() => server.ReleaseLockAsync("/foo.txt"));
    }

    // ---------- DeleteFileAsync ----------

    [Fact]
    public async Task DeleteFileAsync_404_DoesNotThrow()
    {
        // 既に消えているのは「正常」: クライアント観点では冪等
        var (server, _) = NewServer(_ => Json(HttpStatusCode.NotFound, "{\"message\":\"Not found\"}"));
        await server.DeleteFileAsync("/missing.txt"); // throw しない
    }

    [Fact]
    public async Task DeleteFileAsync_500_Throws()
    {
        var (server, _) = NewServer(_ => Json(HttpStatusCode.InternalServerError, "{}"));
        await Assert.ThrowsAsync<ApiException>(() => server.DeleteFileAsync("/x.txt"));
    }

    // ---------- NormalizePath (URL composition) ----------

    [Fact]
    public async Task NormalizePath_PrependsLeadingSlash_WhenAbsent()
    {
        var (server, handler) = NewServer(_ => Json(HttpStatusCode.OK, "{\"locked\":false}"));

        // "x.txt" (先頭 / なし) を渡しても実 URL は /locks/x.txt になる
        await server.AcquireLockAsync("x.txt");
        Assert.Equal("http://localhost:8700/locks/x.txt", handler.Requests.Single().RequestUri!.ToString());
    }

    [Fact]
    public async Task NormalizePath_ConvertsBackslashesToForwardSlashes()
    {
        var (server, handler) = NewServer(_ => Json(HttpStatusCode.OK, "{\"locked\":false}"));

        await server.AcquireLockAsync(@"folder\subfolder\file.txt");
        Assert.Equal("http://localhost:8700/locks/folder/subfolder/file.txt",
            handler.Requests.Single().RequestUri!.ToString());
    }

    // ---------- Error body parsing ----------

    [Fact]
    public async Task EnsureSuccess_NonJsonBody_ExceptionMessageContainsRaw()
    {
        var (server, _) = NewServer(_ => new HttpResponseMessage(HttpStatusCode.BadRequest)
        {
            Content = new StringContent("plain text error"),
        });

        var ex = await Assert.ThrowsAsync<ApiException>(() => server.AcquireLockAsync("/foo.txt"));
        Assert.Equal(400, ex.StatusCode);
        Assert.Contains("plain text", ex.Message);
    }

    [Fact]
    public async Task EnsureSuccess_JsonError_ExtractsMessageField()
    {
        var (server, _) = NewServer(_ => Json(HttpStatusCode.Forbidden, "{\"message\":\"no write\"}"));
        var ex = await Assert.ThrowsAsync<ApiException>(() => server.AcquireLockAsync("/foo.txt"));
        Assert.Equal("no write", ex.Message);
    }
}
