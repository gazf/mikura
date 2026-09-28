using System;
using System.Collections.Generic;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using Mikura.Core.Abstractions;
using Mikura.Core.FileSystem;
using Mikura.Core.Sync;
using Mikura.Core.Tests.FileSystem;
using Xunit;

namespace Mikura.Core.Tests.Sync;

/// <summary>
/// <para>SyncEngine の責務のうち、ここで主張するのは <b>「自分が起こした変更か」の
/// 判定</b>。判定軸は Holder (そのロックを持っていた端末) ではなく Originator
/// (その変化を起こした端末) でなければならない。</para>
///
/// <para>Holder で判定していた間、他端末が自分のロックを解除しても当人は
/// それを「自分の変更」と誤認して捨てていた。結果、持っていないロックを
/// 持っていると信じ続け、書き込みは finalize まで進んでから弾かれていた。</para>
/// </summary>
public class SyncEngineTests
{
    private const string SelfDevice = "dev-self-0001";
    private const string OtherDevice = "dev-other-0002";

    /// <summary>1 回分のイベントを流して終わる IEventStream。</summary>
    private sealed class FakeEventStream : IEventStream
    {
        private readonly IReadOnlyList<ServerEvent> _events;
        public FakeEventStream(params ServerEvent[] events) => _events = events;

        public async IAsyncEnumerable<ServerEvent> ReadEventsAsync(
            [EnumeratorCancellation] CancellationToken ct)
        {
            foreach (var e in _events)
            {
                ct.ThrowIfCancellationRequested();
                yield return e;
            }
            await Task.CompletedTask;
        }

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private static async Task<(FileSystemBackend backend, SyncEngine sync, FakeServerApi server)> NewAsync()
    {
        var server = new FakeServerApi();
        server.SeedFile("/a.txt", new byte[] { 1, 2, 3 });
        var backend = new FileSystemBackend(server);
        await backend.InitializeAsync();
        // notifyKernelCache は渡さない (WinFsp host が無い状態なので no-op でよい)。
        var sync = new SyncEngine(backend, mountPoint: @"Z:\", deviceId: SelfDevice);
        return (backend, sync, server);
    }

    private static ServerEvent LockReleased(string holderDevice, string originatorDevice) =>
        new(
            Event: "lock_released",
            Path: "/a.txt",
            Holder: new LockHolder(UserId: 1, DeviceId: holderDevice, Name: "alice"),
            OriginatorDeviceId: originatorDevice);

    [Fact]
    public async Task ForceReleaseByAnotherDevice_DropsOurLock()
    {
        var (backend, sync, _) = await NewAsync();
        using var handle = await backend.OpenAsync("/a.txt", FileAccessIntent.Write);

        await sync.RunEventLoopAsync(
            new FakeEventStream(LockReleased(holderDevice: SelfDevice, originatorDevice: OtherDevice)),
            CancellationToken.None);

        // 失ったことを知った = 次の write が即失敗する (finalize まで進まない)。
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            backend.WriteAsync(handle!, 0, new byte[] { 9 }, appendToEnd: false, constrainedIo: false));
    }

    [Fact]
    public async Task SelfIssuedRelease_KeepsOurLock()
    {
        // 自分の release が echo で戻ってきただけのケース。これで無効化すると
        // 正常な書き込みが壊れる。
        var (backend, sync, _) = await NewAsync();
        using var handle = await backend.OpenAsync("/a.txt", FileAccessIntent.Write);

        await sync.RunEventLoopAsync(
            new FakeEventStream(LockReleased(holderDevice: SelfDevice, originatorDevice: SelfDevice)),
            CancellationToken.None);

        await backend.WriteAsync(handle!, 0, new byte[] { 9 }, appendToEnd: false, constrainedIo: false);
    }

    [Fact]
    public async Task OtherHoldersLock_MarksTreeEntryReadOnly()
    {
        // 他端末が取ったロックは従来どおり read-only 表示に反映する。
        var (backend, sync, _) = await NewAsync();

        await sync.RunEventLoopAsync(
            new FakeEventStream(new ServerEvent(
                Event: "lock_acquired",
                Path: "/a.txt",
                Holder: new LockHolder(1, OtherDevice, "bob"),
                OriginatorDeviceId: OtherDevice)),
            CancellationToken.None);

        var entry = await backend.GetEntryAsync("/a.txt");
        Assert.True(entry!.IsReadOnly);
    }
}
