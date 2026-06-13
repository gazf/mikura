using System.Diagnostics;
using System.Runtime.InteropServices;
using WinFsp.Native.Native;

namespace WinFsp.Native;

/// <summary>
/// IRP の非同期完了 (STATUS_PENDING + <c>FspFileSystemSendResponse</c>) を扱う static
/// ヘルパー。<see cref="FileSystemHost"/> 内に置けないのは、async method が unsafe class
/// context で declare できないため (CS4004)。Hint は呼出側が unsafe block で
/// 取り出して渡す。
/// </summary>
internal static class AsyncCompletion
{
    public static async Task ReadAsync(nint fs, ulong hint,
        ValueTask<ReadResult> task, UnmanagedMemoryManager mm)
    {
        ReadResult result;
        try
        {
            result = await task.ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[ERROR] WinFsp.Native Read async backend threw: {ex.GetType().Name}: {ex.Message}");
            result = new ReadResult(NtStatus.Unsuccessful, 0);
        }
        finally
        {
            try { ((IDisposable)mm).Dispose(); }
            catch (Exception ex)
            {
                Trace.WriteLine($"[ERROR] WinFsp.Native Read mm dispose threw: {ex.GetType().Name}: {ex.Message}");
            }
        }

        try
        {
            SendResponseRead(fs, hint, result);
        }
        catch (Exception ex)
        {
            // SendResponse failure (e.g., host disposed concurrently). 起こすと
            // UnobservedTaskException 経由でログだけ残ってプロセスは生き残る
            // — kernel 側は STATUS_PENDING のまま戻ってこないので caller の IRP
            // は無応答になるが、unmount 時しか起きないはず。
            Trace.WriteLine($"[ERROR] WinFsp.Native Read SendResponse threw (hint=0x{hint:X}): {ex.GetType().Name}: {ex.Message}");
        }
    }

    public static async Task WriteAsync(nint fs, ulong hint,
        ValueTask<WriteResult> task, UnmanagedMemoryManager mm)
    {
        WriteResult result;
        try
        {
            result = await task.ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[ERROR] WinFsp.Native Write async backend threw: {ex.GetType().Name}: {ex.Message}");
            result = new WriteResult(NtStatus.Unsuccessful, 0, default);
        }
        finally
        {
            try { ((IDisposable)mm).Dispose(); }
            catch (Exception ex)
            {
                Trace.WriteLine($"[ERROR] WinFsp.Native Write mm dispose threw: {ex.GetType().Name}: {ex.Message}");
            }
        }

        try
        {
            SendResponseWrite(fs, hint, result);
        }
        catch (Exception ex)
        {
            Trace.WriteLine($"[ERROR] WinFsp.Native Write SendResponse threw (hint=0x{hint:X}): {ex.GetType().Name}: {ex.Message}");
        }
    }

    // ───────────────────────────────────────── SendResponse builders ────
    // FSP_FSCTL_TRANSACT_RSP を NativeMemory.AllocZeroed で組み、SendResponse 後に Free。
    // PoC は per-IRP alloc、本格化時に pool 化検討。

    private static unsafe void SendResponseRead(nint fs, ulong hint, ReadResult result)
    {
        var rsp = (TransactRsp*)NativeMemory.AllocZeroed((nuint)sizeof(TransactRsp));
        try
        {
            rsp->Version = (ushort)sizeof(TransactRsp);
            rsp->Size = (ushort)sizeof(TransactRsp);
            rsp->Kind = (uint)FspFsctlTransactKind.Read;
            rsp->Hint = hint;
            rsp->IoStatusInformation = result.BytesTransferred;
            rsp->IoStatusStatus = (uint)result.Status;
            NativeApi.FspFileSystemSendResponse(fs, (nint)rsp);
        }
        finally
        {
            NativeMemory.Free(rsp);
        }
    }

    private static unsafe void SendResponseWrite(nint fs, ulong hint, WriteResult result)
    {
        // Rsp.Write.FileInfo は struct offset 24 (Rsp union 開始位置、Write variant は
        // FSP_FSCTL_FILE_INFO FileInfo 単独配置)。
        const int RspUnionStart = 24;
        var rsp = (TransactRsp*)NativeMemory.AllocZeroed((nuint)sizeof(TransactRsp));
        try
        {
            rsp->Version = (ushort)sizeof(TransactRsp);
            rsp->Size = (ushort)sizeof(TransactRsp);
            rsp->Kind = (uint)FspFsctlTransactKind.Write;
            rsp->Hint = hint;
            rsp->IoStatusInformation = result.BytesTransferred;
            rsp->IoStatusStatus = (uint)result.Status;
            if (result.Status >= 0)
            {
                var fileInfoPtr = (NativeFileInfo*)((byte*)rsp + RspUnionStart);
                *fileInfoPtr = result.FileInfo;
            }
            NativeApi.FspFileSystemSendResponse(fs, (nint)rsp);
        }
        finally
        {
            NativeMemory.Free(rsp);
        }
    }
}
