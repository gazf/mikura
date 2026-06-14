using Mikura.Core.Abstractions;
using Mikura.Core.Models;
using WinFsp.Interop.Tests.Fakes;
using WinFsp.Native;
using WinFsp.Native.Native;
using Xunit;
using NativeCleanupFlags = WinFsp.Native.CleanupFlags;
using DomainCleanupFlags = Mikura.Core.Abstractions.CleanupFlags;

namespace WinFsp.Interop.Tests;

/// <summary>
/// <see cref="BackendFileSystem"/> の責務 (ADR-021/022/025、Bug #3a/#3c/#4 経緯):
///   - <see cref="OnlineGate"/> が off の間は全ての I/O callback が
///     <see cref="NtStatus.NetworkUnreachable"/> を返す (SMB 切断と同等の即時死)。
///   - grantedAccess mask から intent を分類して <see cref="IFileSystemBackend.OpenAsync"/>
///     に渡す。write 関連 bit (FILE_WRITE_DATA / APPEND / DELETE / GENERIC_WRITE / MAXIMUM_ALLOWED 等)
///     のいずれかが立っていれば Write 扱い。
///   - <see cref="IFileSystemBackend.OpenAsync"/> が null を返したら
///     <see cref="NtStatus.ObjectNameNotFound"/>、<see cref="UnauthorizedAccessException"/>
///     を投げたら <see cref="NtStatus.AccessDenied"/> に変換 (ADR-016 lock 衝突)。
///   - <see cref="CreateAsync"/> が null を返したら <see cref="NtStatus.AccessDenied"/>。
///   - WinFsp <see cref="NativeCleanupFlags"/> から domain <see cref="DomainCleanupFlags"/>
///     への変換: SetLastWriteTime / SetAllocationSize / SetArchiveBit のいずれかで
///     <see cref="DomainCleanupFlags.Modified"/>、<see cref="NativeCleanupFlags.Delete"/>
///     で <see cref="DomainCleanupFlags.Delete"/>。
///   - sync Read/Write callback は <see cref="NtStatus.NotImplemented"/> (async path のみ提供)。
///   - <see cref="ReadDirectory"/> は marker からの再開、children 順序維持。
/// </summary>
public class BackendFileSystemTests
{
    private const uint FILE_READ_DATA = 0x0001;
    private const uint FILE_WRITE_DATA = 0x0002;
    private const uint FILE_APPEND_DATA = 0x0004;
    private const uint FILE_READ_ATTRIBUTES = 0x0080;
    private const uint MAXIMUM_ALLOWED = 0x02000000;
    private const uint GENERIC_WRITE = 0x40000000;

    private static (BackendFileSystem fs, FakeFileSystemBackend backend, OnlineGate gate) NewFs()
    {
        var backend = new FakeFileSystemBackend();
        var gate = new OnlineGate(); // default = online
        var fs = new BackendFileSystem(backend, gate);
        return (fs, backend, gate);
    }

    // ───────────────────────────────────────── OnlineGate ────

    [Fact]
    public void Open_OfflineGate_ReturnsNetworkUnreachable()
    {
        var (fs, _, gate) = NewFs();
        gate.Set(false);

        var status = fs.Open("\\foo.txt", 0, FILE_READ_DATA, out var ctx, out _);

        Assert.Equal(NtStatus.NetworkUnreachable, status);
        Assert.Null(ctx);
    }

    [Fact]
    public async Task ReadAsync_OfflineGate_ReturnsNetworkUnreachable()
    {
        var (fs, backend, gate) = NewFs();
        backend.SeedFile("/foo.txt", size: 10);
        fs.Open("\\foo.txt", 0, FILE_READ_DATA, out var ctx, out _);
        gate.Set(false);

        var result = await fs.ReadAsync(ctx!, new byte[10], 0, default);

        Assert.Equal(NtStatus.NetworkUnreachable, result.Status);
        Assert.Equal(0u, result.BytesTransferred);
    }

    [Fact]
    public async Task WriteAsync_OfflineGate_ReturnsNetworkUnreachable()
    {
        var (fs, backend, gate) = NewFs();
        backend.SeedFile("/foo.txt");
        fs.Open("\\foo.txt", 0, FILE_WRITE_DATA, out var ctx, out _);
        gate.Set(false);

        var result = await fs.WriteAsync(ctx!, new byte[8], 0, false, false, default);

        Assert.Equal(NtStatus.NetworkUnreachable, result.Status);
    }

    // ───────────────────────────────────────── intent classification ────

    [Theory]
    [InlineData(FILE_READ_DATA, FileAccessIntent.Read)]
    [InlineData(FILE_READ_ATTRIBUTES, FileAccessIntent.Read)]
    [InlineData(FILE_WRITE_DATA, FileAccessIntent.Write)]
    [InlineData(FILE_APPEND_DATA, FileAccessIntent.Write)]
    [InlineData(GENERIC_WRITE, FileAccessIntent.Write)]
    [InlineData(MAXIMUM_ALLOWED, FileAccessIntent.Write)] // Defender 等の MAXIMUM_ALLOWED open も write 扱い (回帰: 偽 StartUpload を防ぐ前提)
    [InlineData(FILE_READ_DATA | FILE_WRITE_DATA, FileAccessIntent.Write)]
    public void Open_AccessMask_ClassifiedAsIntent(uint grantedAccess, FileAccessIntent expectedIntent)
    {
        var (fs, backend, _) = NewFs();
        backend.SeedFile("/foo.txt");

        fs.Open("\\foo.txt", 0, grantedAccess, out _, out _);

        Assert.Single(backend.OpenLog);
        Assert.Equal(expectedIntent, backend.OpenLog[0].Intent);
    }

    // ───────────────────────────────────────── Open error mapping ────

    [Fact]
    public void Open_BackendReturnsNull_MapsToObjectNameNotFound()
    {
        var (fs, _, _) = NewFs();
        // SeedFile していないので DenyOpen 関係なく null

        var status = fs.Open("\\missing.txt", 0, FILE_READ_DATA, out var ctx, out _);

        Assert.Equal(NtStatus.ObjectNameNotFound, status);
        Assert.Null(ctx);
    }

    [Fact]
    public void Open_BackendThrowsUnauthorized_MapsToAccessDenied()
    {
        var (fs, backend, _) = NewFs();
        backend.SeedFile("/foo.txt");
        backend.ThrowOpenAsUnauthorized = true;

        var status = fs.Open("\\foo.txt", 0, FILE_WRITE_DATA, out var ctx, out _);

        Assert.Equal(NtStatus.AccessDenied, status);
        Assert.Null(ctx);
    }

    [Fact]
    public void Create_BackendReturnsNull_MapsToAccessDenied()
    {
        var (fs, backend, _) = NewFs();
        backend.DenyCreate = true;

        var status = fs.Create("\\new.txt", 0, FILE_WRITE_DATA, 0, null, 0, out var ctx, out _);

        Assert.Equal(NtStatus.AccessDenied, status);
        Assert.Null(ctx);
    }

    // ───────────────────────────────────────── Cleanup flag mapping ────

    [Theory]
    [InlineData(NativeCleanupFlags.SetLastWriteTime, DomainCleanupFlags.Modified)]
    [InlineData(NativeCleanupFlags.SetAllocationSize, DomainCleanupFlags.Modified)]
    [InlineData(NativeCleanupFlags.SetArchiveBit, DomainCleanupFlags.Modified)]
    [InlineData(NativeCleanupFlags.Delete, DomainCleanupFlags.Delete)]
    [InlineData(NativeCleanupFlags.SetLastAccessTime, DomainCleanupFlags.None)] // 読み取りだけの flag は無視
    [InlineData(NativeCleanupFlags.SetLastWriteTime | NativeCleanupFlags.Delete,
        DomainCleanupFlags.Modified | DomainCleanupFlags.Delete)]
    public void Cleanup_NativeFlags_MappedToDomainFlags(NativeCleanupFlags nativeFlags, DomainCleanupFlags expectedDomainFlags)
    {
        var (fs, backend, _) = NewFs();
        backend.SeedFile("/foo.txt");
        fs.Open("\\foo.txt", 0, FILE_WRITE_DATA, out var ctx, out _);

        fs.Cleanup(ctx, "\\foo.txt", nativeFlags);

        Assert.Single(backend.CleanupLog);
        Assert.Equal(expectedDomainFlags, backend.CleanupLog[0].Flags);
    }

    [Fact]
    public void Cleanup_NullFileContext_NoOp()
    {
        // Close 後の stale fileContext や WinFsp protocol 異常で null が来ても crash しない。
        var (fs, backend, _) = NewFs();

        fs.Cleanup(null, "\\foo.txt", NativeCleanupFlags.SetLastWriteTime);

        Assert.Equal(0, backend.CleanupCalls);
    }

    // ───────────────────────────────────────── Close ────

    [Fact]
    public void Close_DelegatesToBackendAndDisposesHandle()
    {
        var (fs, backend, _) = NewFs();
        backend.SeedFile("/foo.txt");
        fs.Open("\\foo.txt", 0, FILE_READ_DATA, out var ctx, out _);
        var handle = (FakeHandle)ctx!;

        fs.Close(ctx!);

        Assert.True(handle.WasClosed);
        Assert.True(handle.WasDisposed);
        Assert.Equal(1, backend.CloseCalls);
    }

    // ───────────────────────────────────────── volume info ────

    [Fact]
    public void GetVolumeInfo_ReportsBackendStats()
    {
        var (fs, backend, _) = NewFs();
        backend.VolumeStats = new VolumeStats(TotalSize: 200_000_000, FreeSize: 50_000_000);

        var status = fs.GetVolumeInfo(out var total, out var free, out _);

        Assert.Equal(NtStatus.Success, status);
        Assert.Equal(200_000_000UL, total);
        Assert.Equal(50_000_000UL, free);
    }

    // ───────────────────────────────────────── sync Read/Write are not implemented ────

    [Fact]
    public void SyncRead_NotImplemented()
    {
        // async path 専用なので、sync callback path は never used + NotImplemented で返す
        // ことで実装が無いと明示する (将来 sync-only backend が来たら override する設計)。
        var (fs, _, _) = NewFs();
        var status = fs.Read(new object(), Span<byte>.Empty, 0, out var bt);
        Assert.Equal(NtStatus.NotImplemented, status);
        Assert.Equal(0u, bt);
    }

    [Fact]
    public void SyncWrite_NotImplemented()
    {
        var (fs, _, _) = NewFs();
        var status = fs.Write(new object(), ReadOnlySpan<byte>.Empty, 0, false, false, out var bt, out _);
        Assert.Equal(NtStatus.NotImplemented, status);
        Assert.Equal(0u, bt);
    }

    // ───────────────────────────────────────── async I/O happy paths ────

    [Fact]
    public async Task ReadAsync_ReturnsBackendBytesAndSuccess()
    {
        var (fs, backend, _) = NewFs();
        backend.SeedFile("/foo.txt", size: 16);
        fs.Open("\\foo.txt", 0, FILE_READ_DATA, out var ctx, out _);
        var buf = new byte[8];

        var result = await fs.ReadAsync(ctx!, buf, 0, default);

        Assert.Equal(NtStatus.Success, result.Status);
        Assert.Equal(8u, result.BytesTransferred);
        Assert.All(buf, b => Assert.Equal(0xAB, b)); // fake が 0xAB で埋める契約
    }

    [Fact]
    public async Task ReadAsync_BackendZeroBytes_ReturnsEof()
    {
        var (fs, backend, _) = NewFs();
        backend.SeedFile("/foo.txt", size: 16);
        backend.ReadReturnsEof = true;
        fs.Open("\\foo.txt", 0, FILE_READ_DATA, out var ctx, out _);

        var result = await fs.ReadAsync(ctx!, new byte[8], 0, default);

        Assert.Equal(NtStatus.EndOfFile, result.Status);
        Assert.Equal(0u, result.BytesTransferred);
    }

    [Fact]
    public async Task WriteAsync_ReportsTransferredBytesAndUpdatesFileInfo()
    {
        var (fs, backend, _) = NewFs();
        backend.SeedFile("/foo.txt");
        fs.Open("\\foo.txt", 0, FILE_WRITE_DATA, out var ctx, out _);
        var data = new byte[1024];

        var result = await fs.WriteAsync(ctx!, data, 0, false, false, default);

        Assert.Equal(NtStatus.Success, result.Status);
        Assert.Equal(1024u, result.BytesTransferred);
        Assert.Equal(1024UL, result.FileInfo.FileSize);
        Assert.Single(backend.WriteLog);
        Assert.Equal((Path: "/foo.txt", Offset: 0L, Length: 1024), backend.WriteLog[0]);
    }

    // ───────────────────────────────────────── ReadDirectory ────
    // 実 enumeration の振る舞いは <c>FspFileSystemAddDirInfo</c> という winfsp-x64.dll
    // への P/Invoke が必須なので、Linux/CI hosted runner では unit test として走らせない。
    // 代わりに <c>WinFsp.Native.IntegrationTests.MountRoundtripTests.Enumerate_AfterCreateFiles_ListsThem</c>
    // で end-to-end を verify する。ここに薄い unit を置くと「native 解決失敗」テストになり
    // 価値が薄い。
}
