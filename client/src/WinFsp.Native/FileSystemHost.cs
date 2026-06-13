using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using WinFsp.Native.Native;

namespace WinFsp.Native;

/// <summary>
/// User-mode file system の orchestrator。<see cref="IFileSystem"/> 実装を引き取って:
/// <list type="number">
///   <item>VolumeParams を準備する (public プロパティ経由で設定可能)</item>
///   <item><see cref="NativeApi.FspFileSystemCreate"/> で native FSP_FILE_SYSTEM を作成</item>
///   <item>callback table に <see cref="UnmanagedCallersOnlyAttribute"/> 付きの static
///       trampoline を流し込む</item>
///   <item>Mount point を設定し dispatcher を起動</item>
/// </list>
/// </summary>
/// <remarks>
/// <para><b>FileSystem ポインタ → host instance の関連付け</b>: native callback は
/// <c>nint fileSystem</c> しか持たないので、static <see cref="ConcurrentDictionary{TKey,TValue}"/>
/// に lookup する。FSP_FILE_SYSTEM の <c>UserContext</c> field を使う方法もあるが、
/// 構造体内部 layout への依存が WinFsp upstream の変更で壊れうるため、PoC は
/// dictionary 戦略を採用。lookup cost は per-IRP ~30ns で無視可能。</para>
/// <para><b>FileContext lifetime</b>: Create/Open で IFileSystem が返した
/// <c>object?</c> を <see cref="GCHandle"/> 化して native に渡す。Close で必ず Free。
/// strong reference を握る形なので、IFileSystem 側から触らずにいれば leak しない。</para>
/// </remarks>
public sealed unsafe class FileSystemHost : IDisposable
{
    private readonly IFileSystem _fs;
    private nint _fileSystem; // native FSP_FILE_SYSTEM*
    private bool _started;
    private bool _mounted;
    private FspFileSystemInterface* _ifacePtr;

    // FSP_FILE_SYSTEM* → host 逆引き表。callback の入口で使う。
    private static readonly ConcurrentDictionary<nint, FileSystemHost> _hostsByFs = new();

    // VolumeParams は Mount() 前に caller が設定する。デフォルトは「普通の FAT-like
    // 1 sector = 512 byte の disk volume」。
    public ushort SectorSize { get; set; } = 512;
    public ushort SectorsPerAllocationUnit { get; set; } = 1;
    public ushort MaxComponentLength { get; set; } = 255;
    public ulong VolumeCreationTime { get; set; } = (ulong)DateTime.UtcNow.ToFileTimeUtc();
    public uint VolumeSerialNumber { get; set; } = 0xCAF5;
    public uint FileInfoTimeout { get; set; } = 1000; // ms
    public bool CaseSensitiveSearch { get; set; }
    public bool CasePreservedNames { get; set; } = true;
    public bool UnicodeOnDisk { get; set; } = true;
    public bool PersistentAcls { get; set; }
    public bool PostCleanupWhenModifiedOnly { get; set; }
    public bool PassQueryDirectoryPattern { get; set; } = true;
    public bool FlushAndPurgeOnCleanup { get; set; }
    public string FileSystemName { get; set; } = "NTFS";

    public FileSystemHost(IFileSystem fileSystem)
    {
        _fs = fileSystem;
    }

    /// <summary>
    /// 指定 mount point (drive letter "Z:" or directory path) に FS を bind して
    /// dispatcher を起動。失敗時は NTSTATUS を例外で投げる。
    /// </summary>
    public void Mount(string mountPoint, uint threadCount = 0)
    {
        if (_started) throw new InvalidOperationException("already mounted");
        _fs.Init(this);

        var vp = BuildVolumeParams();

        _ifacePtr = (FspFileSystemInterface*)Marshal.AllocHGlobal(sizeof(FspFileSystemInterface));
        *_ifacePtr = default; // 全 slot を null clear
        PopulateInterface(_ifacePtr);

        nint fsPtr;
        var status = NativeApi.FspFileSystemCreate(NativeApi.DiskDeviceName, &vp, _ifacePtr, &fsPtr);
        Check(status, "FspFileSystemCreate");
        _fileSystem = fsPtr;
        _hostsByFs[_fileSystem] = this;

        try
        {
            status = NativeApi.FspFileSystemSetMountPoint(_fileSystem, mountPoint);
            Check(status, "FspFileSystemSetMountPoint");
            _mounted = true;

            status = NativeApi.FspFileSystemStartDispatcher(_fileSystem, threadCount);
            Check(status, "FspFileSystemStartDispatcher");
            _started = true;

            _fs.Mounted(this);
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public void Unmount()
    {
        if (_started)
        {
            NativeApi.FspFileSystemStopDispatcher(_fileSystem);
            _started = false;
        }
        if (_mounted)
        {
            NativeApi.FspFileSystemRemoveMountPoint(_fileSystem);
            _mounted = false;
        }
        if (_fileSystem != 0)
        {
            _hostsByFs.TryRemove(_fileSystem, out _);
            NativeApi.FspFileSystemDelete(_fileSystem);
            _fileSystem = 0;
        }
        if (_ifacePtr is not null)
        {
            Marshal.FreeHGlobal((nint)_ifacePtr);
            _ifacePtr = null;
        }
        _fs.Unmounted(this);
    }

    public void Dispose() => Unmount();

    // ─────────────────────────────────────────── VolumeParams build ────
    private VolumeParams BuildVolumeParams()
    {
        var vp = default(VolumeParams);
        vp.Version = (ushort)Marshal.SizeOf<VolumeParams>(); // V0 + V1 = 504
        vp.SectorSize = SectorSize;
        vp.SectorsPerAllocationUnit = SectorsPerAllocationUnit;
        vp.MaxComponentLength = MaxComponentLength;
        vp.VolumeCreationTime = VolumeCreationTime;
        vp.VolumeSerialNumber = VolumeSerialNumber;
        vp.FileInfoTimeout = FileInfoTimeout;
        vp.Prefix = "";
        vp.FileSystemName = FileSystemName;

        VolumeParamsFlags.Set(ref vp.Flags1, VolumeParamsFlags.CaseSensitiveSearch, CaseSensitiveSearch);
        VolumeParamsFlags.Set(ref vp.Flags1, VolumeParamsFlags.CasePreservedNames, CasePreservedNames);
        VolumeParamsFlags.Set(ref vp.Flags1, VolumeParamsFlags.UnicodeOnDisk, UnicodeOnDisk);
        VolumeParamsFlags.Set(ref vp.Flags1, VolumeParamsFlags.PersistentAcls, PersistentAcls);
        VolumeParamsFlags.Set(ref vp.Flags1, VolumeParamsFlags.PostCleanupWhenModifiedOnly, PostCleanupWhenModifiedOnly);
        VolumeParamsFlags.Set(ref vp.Flags1, VolumeParamsFlags.PassQueryDirectoryPattern, PassQueryDirectoryPattern);
        VolumeParamsFlags.Set(ref vp.Flags1, VolumeParamsFlags.FlushAndPurgeOnCleanup, FlushAndPurgeOnCleanup);

        return vp;
    }

    // ─────────────────────────────────────────── callback wiring ────
    private static void PopulateInterface(FspFileSystemInterface* iface)
    {
        iface->GetVolumeInfo = &OnGetVolumeInfo;
        iface->GetSecurityByName = &OnGetSecurityByName;
        iface->Create = &OnCreate;
        iface->Open = &OnOpen;
        iface->Overwrite = &OnOverwrite;
        iface->Cleanup = &OnCleanup;
        iface->Close = &OnClose;
        iface->Read = &OnRead;
        iface->Write = &OnWrite;
        iface->Flush = &OnFlush;
        iface->GetFileInfo = &OnGetFileInfo;
        iface->SetBasicInfo = &OnSetBasicInfo;
        iface->SetFileSize = &OnSetFileSize;
        iface->CanDelete = &OnCanDelete;
        iface->Rename = &OnRename;
        iface->GetSecurity = &OnGetSecurity;
        iface->SetSecurity = &OnSetSecurity;
        iface->ReadDirectory = &OnReadDirectory;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static FileSystemHost? GetHost(nint fileSystem) =>
        _hostsByFs.TryGetValue(fileSystem, out var host) ? host : null;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static object? GetContext(nint fileContext)
    {
        if (fileContext == 0) return null;
        var handle = GCHandle.FromIntPtr(fileContext);
        return handle.IsAllocated ? handle.Target : null;
    }

    /// <summary>callback 内で生 PWSTR を C# string に。null-terminated UTF-16。</summary>
    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static string MarshalString(nint pwstr) =>
        pwstr == 0 ? string.Empty : Marshal.PtrToStringUni(pwstr) ?? string.Empty;

    private static void Check(int status, string what)
    {
        if (status < 0)
            throw new InvalidOperationException($"WinFsp {what} failed: 0x{status:X8}");
    }

    // ─────────────────────────────────────────── UnmanagedCallersOnly trampolines ────
    // 各 callback は dispatcher thread から native ABI で呼ばれる。host を引き当てて
    // IFileSystem に dispatch。例外は捕まえて NTSTATUS UNSUCCESSFUL に変換 (native 側に
    // 例外を投げると process が落ちる)。

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(System.Runtime.CompilerServices.CallConvCdecl) })]
    private static int OnGetVolumeInfo(nint fs, NativeVolumeInfo* info)
    {
        try
        {
            var host = GetHost(fs);
            if (host is null) return NtStatus.Unsuccessful;
            var status = host._fs.GetVolumeInfo(out var total, out var free, out var label);
            if (status >= 0)
            {
                info->TotalSize = total;
                info->FreeSize = free;
                info->SetLabel(label);
            }
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnGetSecurityByName(nint fs, nint fileName, uint* pAttributes, nint sd, nuint* pSdSize)
    {
        try
        {
            var host = GetHost(fs);
            if (host is null) return NtStatus.Unsuccessful;
            var status = host._fs.GetSecurityByName(MarshalString(fileName), out var attributes, out var sdBytes);
            if (status >= 0)
            {
                if (pAttributes is not null) *pAttributes = attributes;
                if (sdBytes is not null && sd != 0 && pSdSize is not null)
                {
                    if ((nuint)sdBytes.Length > *pSdSize)
                    {
                        *pSdSize = (nuint)sdBytes.Length;
                        return NtStatus.BufferTooSmall;
                    }
                    Marshal.Copy(sdBytes, 0, sd, sdBytes.Length);
                    *pSdSize = (nuint)sdBytes.Length;
                }
                else if (pSdSize is not null)
                {
                    *pSdSize = 0;
                }
            }
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnCreate(nint fs, nint fileName, uint createOptions, uint grantedAccess,
        uint fileAttributes, nint sd, ulong allocationSize, nint* pFileContext, NativeFileInfo* pInfo)
    {
        try
        {
            var host = GetHost(fs);
            if (host is null) return NtStatus.Unsuccessful;
            var status = host._fs.Create(MarshalString(fileName), createOptions, grantedAccess,
                fileAttributes, null, allocationSize, out var context, out var info);
            if (status >= 0)
            {
                *pFileContext = AllocContext(context);
                *pInfo = info;
            }
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnOpen(nint fs, nint fileName, uint createOptions, uint grantedAccess,
        nint* pFileContext, NativeFileInfo* pInfo)
    {
        try
        {
            var host = GetHost(fs);
            if (host is null) return NtStatus.Unsuccessful;
            var status = host._fs.Open(MarshalString(fileName), createOptions, grantedAccess,
                out var context, out var info);
            if (status >= 0)
            {
                *pFileContext = AllocContext(context);
                *pInfo = info;
            }
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnOverwrite(nint fs, nint fileContext, uint fileAttributes,
        byte replaceFileAttributes, ulong allocationSize, NativeFileInfo* pInfo)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            var status = host._fs.Overwrite(ctx, fileAttributes, replaceFileAttributes != 0,
                allocationSize, out var info);
            if (status >= 0) *pInfo = info;
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static void OnCleanup(nint fs, nint fileContext, nint fileName, uint flags)
    {
        try
        {
            var host = GetHost(fs);
            if (host is null) return;
            host._fs.Cleanup(GetContext(fileContext),
                fileName == 0 ? null : MarshalString(fileName),
                (CleanupFlags)flags);
        }
        catch { /* native 側に例外を流さない */ }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static void OnClose(nint fs, nint fileContext)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is not null && ctx is not null) host._fs.Close(ctx);
        }
        catch { /* swallow */ }
        finally
        {
            FreeContext(fileContext);
        }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnRead(nint fs, nint fileContext, nint buffer, ulong offset, uint length, uint* pBytesTransferred)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            var span = new Span<byte>((void*)buffer, checked((int)length));
            var status = host._fs.Read(ctx, span, offset, out var transferred);
            *pBytesTransferred = transferred;
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnWrite(nint fs, nint fileContext, nint buffer, ulong offset, uint length,
        byte writeToEndOfFile, byte constrainedIo, uint* pBytesTransferred, NativeFileInfo* pInfo)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            var span = new ReadOnlySpan<byte>((void*)buffer, checked((int)length));
            var status = host._fs.Write(ctx, span, offset,
                writeToEndOfFile != 0, constrainedIo != 0,
                out var transferred, out var info);
            *pBytesTransferred = transferred;
            if (status >= 0) *pInfo = info;
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnFlush(nint fs, nint fileContext, NativeFileInfo* pInfo)
    {
        try
        {
            var host = GetHost(fs);
            if (host is null) return NtStatus.Unsuccessful;
            var status = host._fs.Flush(GetContext(fileContext), out var info);
            if (status >= 0) *pInfo = info;
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnGetFileInfo(nint fs, nint fileContext, NativeFileInfo* pInfo)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            var status = host._fs.GetFileInfo(ctx, out var info);
            if (status >= 0) *pInfo = info;
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnSetBasicInfo(nint fs, nint fileContext, uint fileAttributes,
        ulong creationTime, ulong lastAccessTime, ulong lastWriteTime, ulong changeTime,
        NativeFileInfo* pInfo)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            var status = host._fs.SetBasicInfo(ctx, fileAttributes,
                creationTime, lastAccessTime, lastWriteTime, changeTime, out var info);
            if (status >= 0) *pInfo = info;
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnSetFileSize(nint fs, nint fileContext, ulong newSize, byte setAllocationSize, NativeFileInfo* pInfo)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            var status = host._fs.SetFileSize(ctx, newSize, setAllocationSize != 0, out var info);
            if (status >= 0) *pInfo = info;
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnCanDelete(nint fs, nint fileContext, nint fileName)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            return host._fs.CanDelete(ctx, MarshalString(fileName));
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnRename(nint fs, nint fileContext, nint fileName, nint newFileName, byte replaceIfExists)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            return host._fs.Rename(ctx, MarshalString(fileName), MarshalString(newFileName), replaceIfExists != 0);
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnGetSecurity(nint fs, nint fileContext, nint sd, nuint* pSdSize)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            var status = host._fs.GetSecurity(ctx, out var bytes);
            if (status >= 0)
            {
                if (bytes is not null && sd != 0 && pSdSize is not null)
                {
                    if ((nuint)bytes.Length > *pSdSize)
                    {
                        *pSdSize = (nuint)bytes.Length;
                        return NtStatus.BufferTooSmall;
                    }
                    Marshal.Copy(bytes, 0, sd, bytes.Length);
                    *pSdSize = (nuint)bytes.Length;
                }
                else if (pSdSize is not null) *pSdSize = 0;
            }
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnSetSecurity(nint fs, nint fileContext, uint securityInformation, nint modificationDescriptor)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            // PoC: modificationDescriptor の long を取れないので、SDDL 等は未対応。
            // 本格対応時は kernel32!GetSecurityDescriptorLength 経由で長さを取り、
            // managed byte[] にコピーしてから dispatch する。
            return host._fs.SetSecurity(ctx, securityInformation, Array.Empty<byte>());
        }
        catch { return NtStatus.Unsuccessful; }
    }

    [UnmanagedCallersOnly(CallConvs = new[] { typeof(CallConvCdecl) })]
    private static int OnReadDirectory(nint fs, nint fileContext, nint pattern, nint marker,
        nint buffer, uint length, uint* pBytesTransferred)
    {
        try
        {
            var host = GetHost(fs);
            var ctx = GetContext(fileContext);
            if (host is null || ctx is null) return NtStatus.Unsuccessful;
            var status = host._fs.ReadDirectory(ctx,
                pattern == 0 ? null : MarshalString(pattern),
                marker == 0 ? null : MarshalString(marker),
                buffer, length, out var transferred);
            *pBytesTransferred = transferred;
            return status;
        }
        catch { return NtStatus.Unsuccessful; }
    }

    // ─────────────────────────────────────────── FileContext lifecycle ────
    private static nint AllocContext(object? ctx)
    {
        if (ctx is null) return 0;
        var handle = GCHandle.Alloc(ctx, GCHandleType.Normal);
        return GCHandle.ToIntPtr(handle);
    }

    private static void FreeContext(nint fileContext)
    {
        if (fileContext == 0) return;
        var handle = GCHandle.FromIntPtr(fileContext);
        if (handle.IsAllocated) handle.Free();
    }
}
