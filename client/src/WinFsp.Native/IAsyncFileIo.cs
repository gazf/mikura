using WinFsp.Native.Native;

namespace WinFsp.Native;

/// <summary>
/// <see cref="IFileSystem"/> の Read / Write を非同期化したい場合に追加で
/// 実装する optional interface。<see cref="FileSystemHost"/> が
/// <c>fs is IAsyncFileIo</c> を検出して async dispatch path を採用する。
/// </summary>
/// <remarks>
/// <para>非同期パス: 我々の Read/Write callback は <c>STATUS_PENDING</c> を即 return
/// し、<see cref="ValueTask{TResult}"/> 完了時に <c>FspFileSystemSendResponse</c> で
/// kernel に通知する。HTTP backed FS (mikura 本体) 等、I/O 完了が遠隔の async event
/// に依存するシナリオで、dispatcher thread を即解放できる。</para>
/// <para>同期で済む実装は <c>ValueTask.FromResult(...)</c> で返せば、callback path で
/// 即 return 経路 (STATUS_PENDING を経由しない) に分岐するので、zero-alloc fast path
/// を維持する。</para>
/// </remarks>
public interface IAsyncFileIo
{
    /// <summary>
    /// <see cref="IFileSystem.Read"/> の非同期版。<paramref name="buffer"/> は kernel
    /// 提供領域への直接 <see cref="Memory{T}"/> wrap (zero-copy)。<paramref name="ct"/>
    /// は callback path から cancel を伝播する余地として残す (現在は未使用)。
    /// </summary>
    ValueTask<ReadResult> ReadAsync(object fileContext, Memory<byte> buffer, ulong offset,
        CancellationToken ct);

    /// <summary>
    /// <see cref="IFileSystem.Write"/> の非同期版。
    /// </summary>
    ValueTask<WriteResult> WriteAsync(object fileContext, ReadOnlyMemory<byte> buffer, ulong offset,
        bool writeToEndOfFile, bool constrainedIo, CancellationToken ct);
}

/// <summary>Read 完了結果。NTSTATUS と転送 byte 数。</summary>
public readonly record struct ReadResult(int Status, uint BytesTransferred);

/// <summary>Write 完了結果。NTSTATUS + 転送 byte 数 + 更新後 FileInfo。</summary>
public readonly record struct WriteResult(int Status, uint BytesTransferred, NativeFileInfo FileInfo);
