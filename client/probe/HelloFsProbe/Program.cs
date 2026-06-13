using System.Text;
using WinFsp.Native;
using WinFsp.Native.Native;

// 最小 read-only FS。"\hello.txt" のみ含む、root dir + 1 file。
// 自前 WinFsp.Native binding が mount + Read までやれることの実証用。
//
// 実行例:
//   HelloFsProbe.exe Z:
//   notepad Z:\hello.txt   ← "hello from custom WinFsp binding" が見える
//   Ctrl-C で unmount
//
// 期待動作:
//   - mount 成功 (drive Z: が Explorer に出る)
//   - Z:\hello.txt が enumeration で見える
//   - 内容が Read できる
//
// 失敗ケース:
//   - "WinFsp 未インストール" → MSI を https://winfsp.dev/rel/ から入れる
//   - "Drive Z: already in use" → 別 letter (例 X:) を引数で渡す

if (args.Length < 1)
{
    Console.WriteLine("Usage: HelloFsProbe.exe <mount-point>");
    Console.WriteLine("  e.g. HelloFsProbe.exe Z:");
    return 1;
}

var mountPoint = args[0];

using var host = new FileSystemHost(new HelloFs())
{
    SectorSize = 4096,
    SectorsPerAllocationUnit = 1,
    MaxComponentLength = 255,
    FileSystemName = "HELLOFS",
    PassQueryDirectoryPattern = true,
};

try
{
    host.Mount(mountPoint);
    Console.WriteLine($"Mounted at {mountPoint}. Press Ctrl-C to unmount.");
    var done = new ManualResetEventSlim(false);
    Console.CancelKeyPress += (_, e) => { e.Cancel = true; done.Set(); };
    done.Wait();
    Console.WriteLine("Unmounting...");
}
catch (Exception ex)
{
    Console.WriteLine($"FAILED: {ex.GetType().Name}: {ex.Message}");
    return 2;
}

return 0;

// ─────────────────────────────────────────────────── HelloFs implementation ────

internal sealed class HelloFs : IFileSystem, IAsyncFileIo
{
    // ─────────────────────────────────────── async Read path 実証 ────
    // sync 経路 (IFileSystem.Read) は残しつつ、IAsyncFileIo.ReadAsync で
    // Task.Delay を 1ms 挟んで STATUS_PENDING + SendResponse 経路を強制踏む。
    // 実機 `type Z:\hello.txt` で「async path が機能してる」ことを確認する。

    public async ValueTask<ReadResult> ReadAsync(object fileContext, Memory<byte> buffer, ulong offset,
        CancellationToken ct)
    {
        await Task.Delay(1, ct).ConfigureAwait(false); // 必ず STATUS_PENDING 経由
        if (fileContext is not Node node || node.IsDir)
            return new ReadResult(NtStatus.InvalidDeviceRequest, 0);
        if (offset >= (ulong)HelloBytes.Length)
            return new ReadResult(NtStatus.EndOfFile, 0);
        var toCopy = Math.Min(buffer.Length, HelloBytes.Length - (int)offset);
        HelloBytes.AsSpan((int)offset, toCopy).CopyTo(buffer.Span);
        return new ReadResult(NtStatus.Success, (uint)toCopy);
    }

    // Write は read-only FS なので即同期 return (= ValueTask.FromResult、fast path 経路)。
    // CompletedSuccessfully で IsCompletedSuccessfully = true、SendResponse は使われない。
    public ValueTask<WriteResult> WriteAsync(object fileContext, ReadOnlyMemory<byte> buffer, ulong offset,
        bool writeToEndOfFile, bool constrainedIo, CancellationToken ct) =>
        ValueTask.FromResult(new WriteResult(NtStatus.MediaWriteProtected, 0, default));

    // 静的内容。Read-only なので mutation 無し。
    private static readonly byte[] HelloBytes = Encoding.UTF8.GetBytes("hello from custom WinFsp binding\r\n");
    private const string HelloName = "\\hello.txt";

    // FileContext として使うシンプルマーカー。Root dir と file の 2 種類しかない。
    private sealed record Node(string Path, bool IsDir);

    private static readonly Node Root = new("\\", IsDir: true);
    private static readonly Node Hello = new(HelloName, IsDir: false);

    private static ulong NowFileTime => (ulong)DateTime.UtcNow.ToFileTimeUtc();

    public int GetVolumeInfo(out ulong totalSize, out ulong freeSize, out string label)
    {
        totalSize = 1024 * 1024;
        freeSize = 0; // 全部 hello.txt で埋まってる体
        label = "HelloFs";
        return NtStatus.Success;
    }

    public int GetSecurityByName(string fileName, out uint fileAttributes, out byte[]? securityDescriptor)
    {
        securityDescriptor = null;
        if (fileName == "\\" || fileName.Length == 0)
        {
            fileAttributes = 0x10; // FILE_ATTRIBUTE_DIRECTORY
            return NtStatus.Success;
        }
        if (string.Equals(fileName, HelloName, StringComparison.OrdinalIgnoreCase))
        {
            fileAttributes = 0x01 | 0x80; // READONLY | NORMAL
            return NtStatus.Success;
        }
        fileAttributes = 0;
        return NtStatus.ObjectNameNotFound;
    }

    public int Create(string fileName, uint createOptions, uint grantedAccess,
        uint fileAttributes, byte[]? securityDescriptor, ulong allocationSize,
        out object? fileContext, out NativeFileInfo fileInfo)
    {
        fileContext = null;
        fileInfo = default;
        return NtStatus.AccessDenied; // read-only FS
    }

    public int Open(string fileName, uint createOptions, uint grantedAccess,
        out object? fileContext, out NativeFileInfo fileInfo)
    {
        if (fileName == "\\" || fileName.Length == 0)
        {
            fileContext = Root;
            fileInfo = MakeFileInfo(isDir: true, size: 0);
            return NtStatus.Success;
        }
        if (string.Equals(fileName, HelloName, StringComparison.OrdinalIgnoreCase))
        {
            fileContext = Hello;
            fileInfo = MakeFileInfo(isDir: false, size: (ulong)HelloBytes.Length);
            return NtStatus.Success;
        }
        fileContext = null;
        fileInfo = default;
        return NtStatus.ObjectNameNotFound;
    }

    public int Overwrite(object fileContext, uint fileAttributes, bool replaceFileAttributes,
        ulong allocationSize, out NativeFileInfo fileInfo)
    {
        fileInfo = default;
        return NtStatus.AccessDenied;
    }

    public int Read(object fileContext, Span<byte> buffer, ulong offset, out uint bytesTransferred)
    {
        if (fileContext is not Node node || node.IsDir)
        {
            bytesTransferred = 0;
            return NtStatus.InvalidDeviceRequest;
        }
        if (offset >= (ulong)HelloBytes.Length)
        {
            bytesTransferred = 0;
            return NtStatus.EndOfFile;
        }
        var toCopy = Math.Min(buffer.Length, HelloBytes.Length - (int)offset);
        HelloBytes.AsSpan((int)offset, toCopy).CopyTo(buffer);
        bytesTransferred = (uint)toCopy;
        return NtStatus.Success;
    }

    public int Write(object fileContext, ReadOnlySpan<byte> buffer, ulong offset,
        bool writeToEndOfFile, bool constrainedIo,
        out uint bytesTransferred, out NativeFileInfo fileInfo)
    {
        bytesTransferred = 0;
        fileInfo = default;
        return NtStatus.MediaWriteProtected;
    }

    public int Flush(object? fileContext, out NativeFileInfo fileInfo)
    {
        fileInfo = default;
        return NtStatus.Success;
    }

    public int GetFileInfo(object fileContext, out NativeFileInfo fileInfo)
    {
        if (fileContext is Node node)
        {
            fileInfo = node.IsDir
                ? MakeFileInfo(isDir: true, size: 0)
                : MakeFileInfo(isDir: false, size: (ulong)HelloBytes.Length);
            return NtStatus.Success;
        }
        fileInfo = default;
        return NtStatus.InvalidDeviceRequest;
    }

    public int SetBasicInfo(object fileContext, uint fileAttributes,
        ulong creationTime, ulong lastAccessTime, ulong lastWriteTime, ulong changeTime,
        out NativeFileInfo fileInfo)
    {
        // read-only FS、変更は受けないが Status 成功で espose (Explorer の保存系の通り抜け)
        return GetFileInfo(fileContext, out fileInfo);
    }

    public int SetFileSize(object fileContext, ulong newSize, bool setAllocationSize,
        out NativeFileInfo fileInfo)
    {
        fileInfo = default;
        return NtStatus.MediaWriteProtected;
    }

    public void Cleanup(object? fileContext, string? fileName, CleanupFlags flags) { }
    public void Close(object fileContext) { }

    public int CanDelete(object fileContext, string fileName) => NtStatus.AccessDenied;
    public int Rename(object fileContext, string fileName, string newFileName, bool replaceIfExists) =>
        NtStatus.AccessDenied;

    public int GetSecurity(object fileContext, out byte[]? securityDescriptor)
    {
        securityDescriptor = null;
        return NtStatus.Success;
    }

    public int SetSecurity(object fileContext, uint securityInformation, byte[] modificationDescriptor) =>
        NtStatus.AccessDenied;

    public int ReadDirectory(object fileContext, string? pattern, string? marker,
        nint buffer, uint length, out uint bytesTransferred)
    {
        // PoC: 簡略化のため directory enumeration は最小値だけ返す (空 listing 扱い)。
        // Explorer は GetSecurityByName で hello.txt が見えるので、root open + listing の
        // 全 entry を WinFsp 経由で取り出すには FSP_FSCTL_DIR_INFO 構造体への直接 write
        // (DirInfo Size + FileInfo + NormalizedName) が必要。完全実装は後段。
        bytesTransferred = 0;
        return NtStatus.Success;
    }

    private static NativeFileInfo MakeFileInfo(bool isDir, ulong size)
    {
        var now = NowFileTime;
        return new NativeFileInfo
        {
            FileAttributes = isDir ? 0x10u : 0x80u, // DIRECTORY or NORMAL
            FileSize = size,
            AllocationSize = (size + 4095) & ~4095UL, // 4KB align
            CreationTime = now,
            LastAccessTime = now,
            LastWriteTime = now,
            ChangeTime = now,
            IndexNumber = isDir ? 1UL : 2UL,
        };
    }
}
