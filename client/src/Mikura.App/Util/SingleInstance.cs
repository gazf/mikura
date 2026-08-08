using System.IO.Pipes;
using System.Text;

namespace Mikura.App.Util;

/// <summary>
/// 二重起動を防ぎ、後発プロセスの引数を先発プロセスへ渡す。
/// </summary>
/// <remarks>
/// <para>ADR-034 で <c>mikura://</c> リンクを Windows に関連付けたことで、
/// リンククリックのたびに新しいプロセスが起動しうるようになった。tray アプリは
/// ドライブをマウントするので、二重に立ち上がると同じレターを取り合って壊れる。</para>
///
/// <para>先発プロセスは名前付きパイプで待ち受け、後発プロセスは引数を投げて
/// 即座に終了する。パイプは <see cref="PipeDirection.In"/> の一方向で、
/// 応答は返さない — 渡すのは招待リンク 1 本だけなので往復させる必要がない。</para>
/// </remarks>
public sealed class SingleInstance : IDisposable
{
    private const string MutexName = @"Local\mikura-client-single-instance";
    private const string PipeName = "mikura-client-activate";

    private readonly Mutex _mutex;
    private CancellationTokenSource? _listenerCts;

    /// <summary>このプロセスが先発 (= 実際にアプリを動かす側) か。</summary>
    public bool IsPrimary { get; }

    private SingleInstance(Mutex mutex, bool isPrimary)
    {
        _mutex = mutex;
        IsPrimary = isPrimary;
    }

    public static SingleInstance Acquire()
    {
        // createdNew は「この呼び出しが Mutex を作ったか」。既存プロセスが
        // 生きていれば false になる。WaitOne は使わない — 所有権ではなく
        // 存在だけを見たいので、待ち合わせに化けさせない。
        var mutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
        return new SingleInstance(mutex, createdNew);
    }

    /// <summary>
    /// 後発プロセスから先発プロセスへ引数を送る。送れたら true。
    /// </summary>
    /// <remarks>
    /// 先発プロセスが終了しかけている等で繋がらないこともある。その場合は
    /// false を返し、呼び出し側は「単に何もせず終了する」を選べばよい
    /// (無理に自分でマウントを始めると衝突する)。
    /// </remarks>
    public static bool TrySendToPrimary(string payload, int timeoutMs = 2000)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(
                ".", PipeName, PipeDirection.Out);
            pipe.Connect(timeoutMs);
            var bytes = Encoding.UTF8.GetBytes(payload);
            pipe.Write(bytes, 0, bytes.Length);
            pipe.Flush();
            return true;
        }
        catch (Exception ex)
        {
            System.Diagnostics.Trace.WriteLine(
                $"[SingleInstance] could not reach primary: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    /// <summary>
    /// 先発プロセスとして待ち受けを開始する。受信文字列を
    /// <paramref name="onPayload"/> に渡す (呼び出しはパイプのスレッド上なので、
    /// UI を触る側で marshal すること)。
    /// </summary>
    public void StartListening(Action<string> onPayload)
    {
        if (!IsPrimary) return;
        _listenerCts = new CancellationTokenSource();
        _ = Task.Run(() => ListenLoopAsync(onPayload, _listenerCts.Token));
    }

    private static async Task ListenLoopAsync(
        Action<string> onPayload,
        CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var server = new NamedPipeServerStream(
                    PipeName,
                    PipeDirection.In,
                    maxNumberOfServerInstances: 1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                await server.WaitForConnectionAsync(ct).ConfigureAwait(false);

                using var reader = new StreamReader(server, Encoding.UTF8);
                var payload = await reader.ReadToEndAsync(ct).ConfigureAwait(false);
                if (!string.IsNullOrWhiteSpace(payload))
                {
                    onPayload(payload);
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex)
            {
                System.Diagnostics.Trace.WriteLine(
                    $"[SingleInstance] listener error: {ex.GetType().Name}: {ex.Message}");
                // 一過性の失敗でループを止めない。連続失敗時の暴走を避けるため
                // 少し待ってから再度受付に戻る。
                try
                {
                    await Task.Delay(500, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        }
    }

    public void Dispose()
    {
        _listenerCts?.Cancel();
        _listenerCts?.Dispose();
        if (IsPrimary)
        {
            try
            {
                _mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
                // 所有していないスレッドからの Release。落とす理由がない。
            }
        }
        _mutex.Dispose();
    }
}
