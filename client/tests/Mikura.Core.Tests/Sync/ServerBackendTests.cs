using System;
using System.IO;
using System.Threading.Tasks;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;
using Mikura.Core.Sync;
using Xunit;

namespace Mikura.Core.Tests.Sync;

/// <summary>
/// ServerBackend の責務 (ADR-021/022/023):
///   - WinFsp のメタデータ問合せに対し、起動時に取得した /tree のキャッシュで応答する。
///   - ADR-016/022: write-intent open でだけサーバロックを取得し、read open は素通し。
///     プロセス内の同一パスへの複数 open は LockSlot で refcount し、POST/DELETE は
///     最初の open と最後の close でだけ発火する (ADR-022)。
///   - サーバが他者保持でロックを拒否したら UnauthorizedAccessException を投げ、
///     呼出側で STATUS_ACCESS_DENIED に変換できるようにする。
///   - データは Read 時に server から単一 alloc で hydrate し、handle 内の
///     ArrayPool レンタルバッファに staging する (ADR-023)。
///   - sparse write で writeOffset > existingLen の gap は明示的にゼロ埋めする
///     (ArrayPool は returncontent を保持するので、防御しないと前リーズの junk が
///     アップロードに混入する)。
///   - Cleanup(Modified) または FreshlyCreated でアップロード、tree 更新、ロック解放、
///     buffer drop を行う (ADR-020)。
/// </summary>
public class ServerBackendTests
{
    private static async Task<ServerBackend> NewInitializedBackendAsync(FakeServerApi server)
    {
        var backend = new ServerBackend(server);
        await backend.InitializeAsync();
        return backend;
    }

    [Fact]
    public async Task Initialize_PullsTreeFromServer()
    {
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", new byte[] { 1, 2, 3 });
        server.SeedDirectory("/sub");

        var backend = await NewInitializedBackendAsync(server);

        var file = await backend.GetEntryAsync("/a.txt");
        var dir = await backend.GetEntryAsync("/sub");
        var root = await backend.GetEntryAsync("/");
        Assert.NotNull(file);
        Assert.False(file!.IsDirectory);
        Assert.Equal(3, file.Size);
        Assert.NotNull(dir);
        Assert.True(dir!.IsDirectory);
        Assert.NotNull(root); // ルートは backend が合成する
    }

    [Fact]
    public async Task ReadOpen_DoesNotAcquireLock()
    {
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", new byte[] { 1, 2, 3 });
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/a.txt", FileAccessIntent.Read);

        Assert.NotNull(handle);
        Assert.Equal(0, server.AcquireLockCalls);
    }

    [Fact]
    public async Task WriteOpen_LockDenied_ThrowsUnauthorized()
    {
        var server = new FakeServerApi { DenyAcquireLock = true };
        server.SeedFile("/a.txt", new byte[] { 1, 2, 3 });
        var backend = await NewInitializedBackendAsync(server);

        await Assert.ThrowsAsync<UnauthorizedAccessException>(async () =>
        {
            await backend.OpenAsync("/a.txt", FileAccessIntent.Write);
        });

        // ADR-022: 拒否時は LockSlot をクリーンアップして次の open でリトライできる。
        Assert.Equal(1, server.AcquireLockCalls);
    }

    [Fact]
    public async Task WriteOnReadHandle_ThrowsUnauthorized()
    {
        // Defense in depth: kernel が read-only ハンドルからの WriteFile を本来弾くが、
        // バックエンド側でも HasLock=false かつ FreshlyCreated=false なら拒否する。
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", new byte[] { 1, 2, 3 });
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/a.txt", FileAccessIntent.Read);
        Assert.NotNull(handle);

        await Assert.ThrowsAsync<UnauthorizedAccessException>(async () =>
        {
            await backend.WriteAsync(handle!, 0, new byte[] { 9 }, appendToEnd: false, constrainedIo: false);
        });
    }

    [Fact]
    public async Task ConcurrentWriteOpens_ShareLock_AcquireOnceReleaseOnLast()
    {
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", new byte[] { 1, 2, 3 });
        var backend = await NewInitializedBackendAsync(server);

        var h1 = await backend.OpenAsync("/a.txt", FileAccessIntent.Write);
        var h2 = await backend.OpenAsync("/a.txt", FileAccessIntent.Write);
        Assert.NotNull(h1);
        Assert.NotNull(h2);

        Assert.Equal(1, server.AcquireLockCalls);
        Assert.Equal(0, server.ReleaseLockCalls);

        // 1 つ目の Cleanup ではまだ release されない。
        await backend.CleanupAsync(h1!, CleanupFlags.None);
        h1!.Dispose();
        Assert.Equal(0, server.ReleaseLockCalls);

        // 2 つ目で初めて release が走る。
        await backend.CleanupAsync(h2!, CleanupFlags.None);
        h2!.Dispose();
        Assert.Equal(1, server.ReleaseLockCalls);
    }

    [Fact]
    public async Task Hydrate_StreamShorterThanTreeSize_ThrowsInsteadOfReturningTruncated()
    {
        // 異常応答シナリオ: tree で「5 byte」と名乗っていた path が download 時に
        // 2 byte しか返さなかった場合、silent truncation で続行すると整合性の
        // 取れない 2 byte を staging することになる。
        // ReadExactlyAsync 化により、こういうケースは EndOfStreamException として
        // 弾かれて hydrate 自体が失敗する責務 (上位での再試行 or エラー伝播)。
        var server = new FakeServerApi();
        server.SeedFile("/short.bin", new byte[] { 1, 2, 3, 4, 5 }); // tree size = 5
        server.TruncatedDownloadSizes["/short.bin"] = 2;             // 実 stream は 2 byte
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/short.bin", FileAccessIntent.Read);
        var buf = new byte[5];
        await Assert.ThrowsAsync<EndOfStreamException>(async () =>
        {
            await backend.ReadAsync(handle!, 0, buf);
        });
    }

    [Fact]
    public async Task VolumeStats_AfterInitialize_ReflectsServerResponse()
    {
        // Z: ドライブの「ディスクの空き容量」表示は server statfs の値を映す。
        // InitializeAsync で初回 fetch、以後 cache が VolumeStats getter で
        // 即返される (WinFsp GetVolumeInfo callback は sync なため block 不可)。
        var server = new FakeServerApi
        {
            VolumeStats = new VolumeStats(TotalSize: 500_000_000_000L, FreeSize: 100_000_000_000L),
        };
        var backend = await NewInitializedBackendAsync(server);

        var stats = backend.VolumeStats;
        Assert.Equal(500_000_000_000L, stats.TotalSize);
        Assert.Equal(100_000_000_000L, stats.FreeSize);
    }

    [Fact]
    public async Task Open_WithDifferentCase_ReadsViaCanonicalPathOnServer()
    {
        // 実機回帰: Player は /Movie.mp4 を /MOVIE.MP4 (拡張子大文字) で
        // 開きにくる。Windows シェルは case-insensitive、_tree も
        // OrdinalIgnoreCase でルックアップが通るが、server (POSIX) は厳密一致。
        // ハンドルがユーザの渡した非正規 path を握ったまま Read するとサーバ側
        // の GET /content/<path> が 404 になり、再生 / シークが落ちる。
        // OpenAsync が tree の正規 path (entry.Path) を ServerHandle に詰めるべき。
        var server = new FakeServerApi();
        var content = new byte[] { 1, 2, 3, 4 };
        server.SeedFile("/Movie.mp4", content);
        var backend = await NewInitializedBackendAsync(server);

        // Player 由来の case 違いで開く。
        using var handle = await backend.OpenAsync("/MOVIE.MP4", FileAccessIntent.Read);
        Assert.NotNull(handle);

        var buf = new byte[4];
        var n = await backend.ReadAsync(handle!, 0, buf);
        Assert.Equal(4, n);
        Assert.Equal(content, buf);

        // server を叩いた path はユーザが渡した /MOVIE.MP4 ではなく、tree が
        // 記録している正規版 /Movie.mp4 でなければならない。
        Assert.Equal("/Movie.mp4", server.LastDownloadedPath);
    }

    [Fact]
    public async Task Read_AtVariousOffsets_ReturnsCorrectRangeBytes()
    {
        // 責務: offset を変えた Read が server から該当範囲を取得して返す。
        // ADR-025 改訂後の Read は range-based fetch (= shell preview/property
        // 抽出のために 100MB ファイルを丸ごと load しないことが目的)。
        // 以前の "hydrate once" 責務は廃止。
        var content = new byte[] { 10, 20, 30, 40 };
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", content);
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/a.txt", FileAccessIntent.Read);

        var buf = new byte[4];
        var read1 = await backend.ReadAsync(handle!, 0, buf);
        Assert.Equal(4, read1);
        Assert.Equal(content, buf);

        var buf2 = new byte[2];
        var read2 = await backend.ReadAsync(handle!, 1, buf2);
        Assert.Equal(2, read2);
        Assert.Equal(new byte[] { 20, 30 }, buf2);
    }

    [Fact]
    public async Task SparseWrite_GapIsZeroFilled()
    {
        // 責務: fresh ファイルの先頭に触れずに offset=100 だけ 1 byte 書いた
        // 場合、[0..100) は全てゼロでなければならない (機密データの漏洩防止 +
        // 整合性)。ADR-025 改訂前は ArrayPool 残骸の漏洩防止を client 側
        // Array.Clear で担保していた (ce5b8c5)。改訂後は pass-through で
        // server temp が POSIX file-extend 経由でゼロ埋めするため、gap の
        // ゼロ化は server side の責務に移った。テストは結果側 (server payload)
        // を見ているのでどちらの実装でも同じ責務を観測できる。

        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/sparse.bin", isDirectory: false);
        Assert.NotNull(handle);

        await backend.WriteAsync(handle!, offset: 100, new byte[] { 0xAB }, appendToEnd: false, constrainedIo: false);

        // Cleanup でアップロードさせ、サーバが受け取った payload を観測する。
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        var payload = server.Files["/sparse.bin"];
        Assert.Equal(101, payload.Length);
        for (int i = 0; i < 100; i++)
        {
            Assert.True(payload[i] == 0, $"gap byte[{i}] expected 0, was 0x{payload[i]:X2}");
        }
        Assert.Equal(0xAB, payload[100]);
    }

    [Fact]
    public async Task SetSize_AllocationHint_DoesNotInflateUploadedSize()
    {
        // ADR-023: shell の CopyFileEx は SetEndOfFile(N) で先に hint を入れて
        // バッファをプリアロケートさせる。hint で論理長まで伸ばしてしまうと、
        // 後続の Write が来る前に Cleanup された場合に "8MB の 0 埋めゴミ" が
        // upload されてしまう。hint は容量だけ確保し、論理長 (= upload sizes)
        // を変えないことが責務。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/big.bin", isDirectory: false);
        await backend.SetSizeAsync(handle!, newSize: 8 * 1024 * 1024, isAllocationHint: true);
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        Assert.Empty(server.Files["/big.bin"]);
    }

    [Fact]
    public async Task SetSize_Extending_ZeroFillsNewRange()
    {
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", new byte[] { 1, 2, 3 });
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/a.txt", FileAccessIntent.Write);
        await backend.SetSizeAsync(handle!, newSize: 10, isAllocationHint: false);

        var buf = new byte[10];
        var read = await backend.ReadAsync(handle!, 0, buf);
        Assert.Equal(10, read);
        Assert.Equal(new byte[] { 1, 2, 3, 0, 0, 0, 0, 0, 0, 0 }, buf);
    }

    [Fact]
    public async Task Cleanup_Modified_PersistsNewContentAndUpdatesMetadata()
    {
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", new byte[] { 1, 2, 3 });
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/a.txt", FileAccessIntent.Write);
        await backend.WriteAsync(handle!, 0, new byte[] { 9, 9, 9, 9, 9 }, appendToEnd: false, constrainedIo: false);
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        Assert.Equal(new byte[] { 9, 9, 9, 9, 9 }, server.Files["/a.txt"]);

        var entry = await backend.GetEntryAsync("/a.txt");
        Assert.NotNull(entry);
        Assert.Equal(5, entry!.Size);
    }

    [Fact]
    public async Task Cleanup_NotModifiedAndNotFresh_DoesNotUpload()
    {
        // 編集なしで write open → close したケース (Excel のプレビュー保存等で
        // ハンドルだけ取って結局書かないことがある) でサーバ上のファイルが
        // 変化しないことが責務。
        var server = new FakeServerApi();
        var original = new byte[] { 1, 2, 3 };
        server.SeedFile("/a.txt", original);
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/a.txt", FileAccessIntent.Write);
        await backend.CleanupAsync(handle!, CleanupFlags.None);
        handle!.Dispose();

        Assert.Equal(original, server.Files["/a.txt"]);
    }

    [Fact]
    public async Task Cleanup_FreshlyCreatedZeroByte_IsPersistedToServer()
    {
        // touch 相当: Create 直後に編集なしで close されても、サーバにファイルが
        // 出現することがエクスプローラ「新規 > テキストドキュメント」の責務。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/touched.txt", isDirectory: false);
        await backend.CleanupAsync(handle!, CleanupFlags.None);
        handle!.Dispose();

        Assert.True(server.Files.ContainsKey("/touched.txt"));
        Assert.Empty(server.Files["/touched.txt"]);
    }

    [Fact]
    public async Task Cleanup_Delete_RemovesFromServerAndTree()
    {
        var server = new FakeServerApi();
        server.SeedFile("/doomed.txt", new byte[] { 1 });
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/doomed.txt", FileAccessIntent.Write);
        await backend.CleanupAsync(handle!, CleanupFlags.Delete);
        handle!.Dispose();

        Assert.False(server.Files.ContainsKey("/doomed.txt"));
        Assert.Null(await backend.GetEntryAsync("/doomed.txt"));
    }

    [Fact]
    public async Task Rename_MovesFileOnServerAndInTree()
    {
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", new byte[] { 1 });
        var backend = await NewInitializedBackendAsync(server);

        await backend.RenameAsync("/a.txt", "/b.txt", replaceIfExists: false);

        Assert.False(server.Files.ContainsKey("/a.txt"));
        Assert.Equal(new byte[] { 1 }, server.Files["/b.txt"]);
        Assert.Null(await backend.GetEntryAsync("/a.txt"));
        Assert.NotNull(await backend.GetEntryAsync("/b.txt"));
    }

    [Fact]
    public async Task Rename_ForceReleasesSrcAndDstLocks_PreventingOrphans()
    {
        // 実機回帰: Excel の save-to-temp+rename パターンで src (temp) と dst
        // (target) の両方が write open → lock 取得済みのまま rename される。
        // rename は編集完了のセマンティクスなので、両方の lock をその場で
        // 強制 release しないと heartbeat で永久に refresh され続けて孤児化する
        // (実機ログ: Excel デフォルト保存後に複数の Device ID 由来 lock が残留)。
        var server = new FakeServerApi();
        server.SeedFile("/temp.bin", new byte[] { 1 });
        server.SeedFile("/target.bin", new byte[] { 2 });
        var backend = await NewInitializedBackendAsync(server);

        // src と dst を両方 write open(典型的には Excel 内部で起きる状況)。
        using var srcHandle = await backend.OpenAsync("/temp.bin", FileAccessIntent.Write);
        using var dstHandle = await backend.OpenAsync("/target.bin", FileAccessIntent.Write);
        Assert.Equal(2, server.AcquireLockCalls);

        await backend.RenameAsync("/temp.bin", "/target.bin", replaceIfExists: true);

        // rename 完了直後に 2 つの release が走っていなければならない
        // (refcount 関係なく、孤児防止のため)。
        Assert.Equal(2, server.ReleaseLockCalls);
    }

    [Fact]
    public async Task Rename_ReplaceIfExists_OverwritesDestinationContent()
    {
        // server PATCH /files は衝突時 409 を返す仕様 (ADR-024)。replaceIfExists の
        // セマンティクスを満たすためにはクライアントが先に dst を消してから rename
        // する必要がある。観測可能な責務は「rename 後 dst の中身が src 由来になる」。
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", new byte[] { 0xAA });
        server.SeedFile("/b.txt", new byte[] { 0xBB });
        var backend = await NewInitializedBackendAsync(server);

        await backend.RenameAsync("/a.txt", "/b.txt", replaceIfExists: true);

        Assert.False(server.Files.ContainsKey("/a.txt"));
        Assert.Equal(new byte[] { 0xAA }, server.Files["/b.txt"]);
    }

    [Fact]
    public async Task ApplyExternalEvent_CreatedAndDeleted_UpdatesTree()
    {
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        var changed = backend.ApplyExternalEvent("created", "/new.txt", size: 4, lastModified: DateTime.UtcNow, isDirectory: false);
        Assert.True(changed);
        Assert.NotNull(await backend.GetEntryAsync("/new.txt"));

        changed = backend.ApplyExternalEvent("deleted", "/new.txt", 0, DateTime.UtcNow, false);
        Assert.True(changed);
        Assert.Null(await backend.GetEntryAsync("/new.txt"));

        // 知らないイベント名は no-op。
        Assert.False(backend.ApplyExternalEvent("renamed", "/x", 0, DateTime.UtcNow, false));
    }

    // ─────────────────────────────────── ADR-025 chunked upload 固有の責務 ────

    [Fact]
    public async Task CreateAsync_AcquiresLockSoSubsequentSessionStartIsAccepted()
    {
        // 実機回帰: CreateAsync が lock を取らないと、続く Write の
        // EnsureSessionAsync → StartUploadAsync が server で
        // "Lock holder mismatch" 403 になり書き込み不能。
        // 新規作成も write 操作なので lock を取る責務を CreateAsync に課す。
        // 観測可能なふるまい: 新規作成 + Write + Cleanup が完走し、
        // server.Files に内容が永続化される (= session start が拒否されていない)。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/new.bin", isDirectory: false);
        Assert.Equal(1, server.AcquireLockCalls); // CreateAsync が lock 取得した

        await backend.WriteAsync(handle!, 0, new byte[] { 0x42 }, appendToEnd: false, constrainedIo: false);
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        Assert.Equal(new byte[] { 0x42 }, server.Files["/new.bin"]);
        Assert.Equal(1, server.ReleaseLockCalls);
    }

    [Fact]
    public async Task FreshWrite_PassesThroughChunkedSession_NoBaseCopy()
    {
        // ADR-025 の核: 新規作成 (FreshlyCreated) は session 開始時に
        // baseFromExisting=false で開かれ、kernel write は PATCH で素通しする。
        // 連続 offset の Write は WriteCoalescer により単一 PATCH に集約される
        // (kernel IRP 単位の往復を削減する write cache)。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/fresh.bin", isDirectory: false);
        await backend.WriteAsync(handle!, 0, new byte[] { 1, 2, 3, 4 }, appendToEnd: false, constrainedIo: false);
        await backend.WriteAsync(handle!, 4, new byte[] { 5, 6, 7, 8 }, appendToEnd: false, constrainedIo: false);
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        Assert.Equal(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 }, server.Files["/fresh.bin"]);

        var session = server.SessionsByUploadId.Values.Single(s => s.Path == "/fresh.bin");
        Assert.False(session.BaseFromExisting);
        Assert.True(session.Finalized);
        // 2 つの連続 Write は coalesce されて 1 PATCH に集約。
        Assert.Equal(1, session.ChunkPatchCount);
    }

    [Fact]
    public async Task ModifyInPlace_OpensSessionWithBaseFromExisting()
    {
        // 既存ファイル open (write) → 1 byte だけ書き換えても、それ以外は
        // 元の内容が残る (server temp が baseFromExisting で複製されているため)。
        var server = new FakeServerApi();
        server.SeedFile("/doc.bin", new byte[] { 0x10, 0x20, 0x30, 0x40, 0x50 });
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/doc.bin", FileAccessIntent.Write);
        await backend.WriteAsync(handle!, 2, new byte[] { 0xFF }, appendToEnd: false, constrainedIo: false);
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        Assert.Equal(new byte[] { 0x10, 0x20, 0xFF, 0x40, 0x50 }, server.Files["/doc.bin"]);

        var session = server.SessionsByUploadId.Values.Single(s => s.Path == "/doc.bin");
        Assert.True(session.BaseFromExisting);
    }

    [Fact]
    public async Task ConcurrentHandles_SamePath_ShareSingleSession()
    {
        // 同一 path に対して複数 handle が write open されても、StartUpload は
        // 最初の 1 回だけ走り、finalize も最後の handle が代表で 1 回だけ走る。
        // CDM T=16 が 16 個の handle を開いて 16 個の base copy を走らせる回帰の防止。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        var h1 = await backend.CreateAsync("/shared.bin", isDirectory: false);
        await backend.WriteAsync(h1!, 0, new byte[] { 0x10, 0x20 }, appendToEnd: false, constrainedIo: false);

        var h2 = await backend.OpenAsync("/shared.bin", FileAccessIntent.Write);
        await backend.WriteAsync(h2!, 2, new byte[] { 0x30, 0x40 }, appendToEnd: false, constrainedIo: false);

        // h1 を先に Cleanup → 自分は最後ではないので skip。
        await backend.CleanupAsync(h1!, CleanupFlags.Modified);
        // 中間状態: session はまだ open、staging には両 handle 分の write が積まれている。
        Assert.Single(server.SessionsByUploadId);
        var session = server.SessionsByUploadId.Values.Single();
        Assert.False(session.Finalized);
        Assert.False(session.Aborted);

        // h2 を Cleanup → 自分が最後なので実 finalize。
        await backend.CleanupAsync(h2!, CleanupFlags.Modified);

        Assert.True(session.Finalized);
        Assert.Equal(new byte[] { 0x10, 0x20, 0x30, 0x40 }, server.Files["/shared.bin"]);
        // baseFromExisting は最初の caller (CreateAsync → FreshlyCreated) が採用される。
        Assert.False(session.BaseFromExisting);

        h1!.Dispose();
        h2!.Dispose();
    }

    [Fact]
    public async Task ContiguousSmallWrites_CoalesceIntoSinglePatch()
    {
        // WriteCoalescer: 連続 offset の小さい IRP を 4MB target chunk に積み、
        // 単一 PATCH として server に送る。SEQ Write の HTTP round-trip 数削減。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/seq.bin", isDirectory: false);
        const int IrpSize = 64 * 1024;
        const int IrpCount = 32; // 32 × 64KB = 2MB < 4MB target → 全て 1 chunk に集約
        var rng = new Random(42);
        var expected = new byte[IrpSize * IrpCount];
        rng.NextBytes(expected);
        for (int i = 0; i < IrpCount; i++)
        {
            var slice = expected.AsMemory(i * IrpSize, IrpSize);
            await backend.WriteAsync(handle!, i * IrpSize, slice, appendToEnd: false, constrainedIo: false);
        }
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        Assert.Equal(expected, server.Files["/seq.bin"]);
        var session = server.SessionsByUploadId.Values.Single(s => s.Path == "/seq.bin");
        Assert.Equal(1, session.ChunkPatchCount);
    }

    [Fact]
    public async Task ContiguousWrites_OverFourMb_SplitAtTargetBoundary()
    {
        // 連続 6MB の書き込み: target 4MB で chunk が flush され、新バッファに残り 2MB。
        // 結果 2 PATCH。kernel 1MB IRP × 6 でも同じ結果になることを確認。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/big.bin", isDirectory: false);
        const int IrpSize = 1024 * 1024;
        const int IrpCount = 6;
        var rng = new Random(7);
        var expected = new byte[IrpSize * IrpCount];
        rng.NextBytes(expected);
        for (int i = 0; i < IrpCount; i++)
        {
            var slice = expected.AsMemory(i * IrpSize, IrpSize);
            await backend.WriteAsync(handle!, i * IrpSize, slice, appendToEnd: false, constrainedIo: false);
        }
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        Assert.Equal(expected, server.Files["/big.bin"]);
        var session = server.SessionsByUploadId.Values.Single(s => s.Path == "/big.bin");
        // 4MB + 残 2MB = 2 PATCH。
        Assert.Equal(2, session.ChunkPatchCount);
    }

    [Fact]
    public async Task NonContiguousWrites_CoalesceIntoSingleMultipartPatch()
    {
        // 散発的な非連続 IRP (Excel/SQLite/RND 4K Q=32 ベンチが踏むパターン) を
        // 同一 handle にまとめる: 1 PATCH に multipart/mixed で束ねて送られる。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/scatter.bin", isDirectory: false);
        var rng = new Random(3);
        const int N = 16;
        var offsets = new long[N];
        var datas = new byte[N][];
        for (int i = 0; i < N; i++)
        {
            // 4KB IRP を 64KB 飛びの非連続 offset に散らす。
            offsets[i] = i * 64L * 1024;
            datas[i] = new byte[4 * 1024];
            rng.NextBytes(datas[i]);
            await backend.WriteAsync(handle!, offsets[i], datas[i], appendToEnd: false, constrainedIo: false);
        }
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        var payload = server.Files["/scatter.bin"];
        for (int i = 0; i < N; i++)
        {
            // 各 range の先頭/末尾を 1 byte ずつ突き合わせ。
            Assert.Equal(datas[i][0], payload[offsets[i]]);
            Assert.Equal(datas[i][^1], payload[offsets[i] + datas[i].Length - 1]);
        }
        var session = server.SessionsByUploadId.Values.Single(s => s.Path == "/scatter.bin");
        // 全 16 件が 1 multipart PATCH に束なる。
        Assert.Equal(1, session.MultipartPatchCount);
        Assert.Equal(N, session.MultipartRangeCount);
        // 単 range の UploadChunkAsync は呼ばれない。
        Assert.Equal(0, session.ChunkPatchCount);
    }

    [Fact]
    public async Task RandomOffsetWrites_LandAtCorrectServerOffsets()
    {
        // 順序を入れ替えて offset をジャンプさせる: pass-through 設計では
        // 各 PATCH の offset がそのまま server temp の seek+write になる。
        // FreshlyCreated なので gap は server (POSIX file extend) でゼロ埋め。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/scattered.bin", isDirectory: false);
        await backend.WriteAsync(handle!, 200, new byte[] { 0xAA }, appendToEnd: false, constrainedIo: false);
        await backend.WriteAsync(handle!, 100, new byte[] { 0xBB }, appendToEnd: false, constrainedIo: false);
        await backend.WriteAsync(handle!, 0, new byte[] { 0xCC }, appendToEnd: false, constrainedIo: false);
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        var payload = server.Files["/scattered.bin"];
        Assert.Equal(201, payload.Length);
        Assert.Equal(0xCC, payload[0]);
        Assert.Equal(0xBB, payload[100]);
        Assert.Equal(0xAA, payload[200]);
        Assert.Equal(0, payload[50]); // 中間の hole は server-side で 0
        Assert.Equal(0, payload[150]);
    }

    [Fact]
    public async Task Cleanup_Delete_AbortsInProgressSession()
    {
        // 編集途中で Delete された場合、開いていた session を abort してから
        // ファイル削除する (孤児 session を残さない責務)。
        var server = new FakeServerApi();
        server.SeedFile("/doomed.bin", new byte[] { 1, 2, 3 });
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/doomed.bin", FileAccessIntent.Write);
        await backend.WriteAsync(handle!, 0, new byte[] { 9 }, appendToEnd: false, constrainedIo: false);
        await backend.CleanupAsync(handle!, CleanupFlags.Delete);
        handle!.Dispose();

        Assert.False(server.Files.ContainsKey("/doomed.bin"));
        var session = server.SessionsByUploadId.Values.Single(s => s.Path == "/doomed.bin");
        Assert.True(session.Aborted);
        Assert.False(session.Finalized);
    }

    [Fact]
    public async Task Cleanup_FreshTouchOnly_StartsSessionAndFinalizesAtZero()
    {
        // touch 相当: Create だけして Cleanup → Write が 1 度も来ていなくても、
        // session を開いて size=0 で finalize し、サーバ上にファイルを実体化する。
        var server = new FakeServerApi();
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.CreateAsync("/touched.bin", isDirectory: false);
        await backend.CleanupAsync(handle!, CleanupFlags.None);
        handle!.Dispose();

        Assert.True(server.Files.ContainsKey("/touched.bin"));
        Assert.Empty(server.Files["/touched.bin"]);

        var session = server.SessionsByUploadId.Values.Single(s => s.Path == "/touched.bin");
        Assert.True(session.Finalized);
        Assert.Equal(0, session.ChunkPatchCount); // PATCH なしで finalize=0
    }

    [Fact]
    public async Task SetSize_TruncateThenWrite_PersistsOnlyNewContent()
    {
        // Excel/Notepad save の典型: 既存ファイルを truncate(0) してから新内容を書く。
        // session は baseFromExisting=true で開かれるが、SetSize(0) + Write で
        // 旧内容は finalize size と PATCH の上書きで上書きされる。
        var server = new FakeServerApi();
        server.SeedFile("/save.txt", new byte[] { 0xAA, 0xAA, 0xAA, 0xAA, 0xAA });
        var backend = await NewInitializedBackendAsync(server);

        using var handle = await backend.OpenAsync("/save.txt", FileAccessIntent.Write);
        await backend.SetSizeAsync(handle!, 0, isAllocationHint: false);
        await backend.WriteAsync(handle!, 0, new byte[] { 0x42, 0x43, 0x44 }, appendToEnd: false, constrainedIo: false);
        await backend.CleanupAsync(handle!, CleanupFlags.Modified);
        handle!.Dispose();

        Assert.Equal(new byte[] { 0x42, 0x43, 0x44 }, server.Files["/save.txt"]);
    }

    [Fact]
    public async Task Enumerate_ReturnsImmediateChildrenOnly()
    {
        var server = new FakeServerApi();
        server.SeedFile("/root.txt", new byte[] { 1 });
        server.SeedDirectory("/dir");
        server.SeedFile("/dir/inside.txt", new byte[] { 2 });
        server.SeedFile("/dir/sub/deep.txt", new byte[] { 3 });
        var backend = await NewInitializedBackendAsync(server);

        var rootChildren = await backend.EnumerateAsync("/");
        var dirChildren = await backend.EnumerateAsync("/dir");

        Assert.Contains(rootChildren, e => e.Path == "/root.txt");
        Assert.Contains(rootChildren, e => e.Path == "/dir");
        Assert.DoesNotContain(rootChildren, e => e.Path == "/dir/inside.txt");

        Assert.Contains(dirChildren, e => e.Path == "/dir/inside.txt");
        Assert.DoesNotContain(dirChildren, e => e.Path == "/dir/sub/deep.txt");
    }
}
