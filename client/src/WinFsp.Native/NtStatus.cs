namespace WinFsp.Native;

/// <summary>
/// NTSTATUS constants used by WinFsp callbacks. WinFsp 自身がそのまま kernel に
/// 流すので、これらの値は Windows DDK の ntstatus.h と一致している必要がある。
/// </summary>
/// <remarks>
/// 完全な一覧ではない。mikura が踏む経路で実際に必要なものに絞る。新規 status は
/// 追加した時点で対応 NTSTATUS を Microsoft DDK doc から拾ってここに置く。
/// </remarks>
public static class NtStatus
{
    public const int Success = unchecked((int)0x00000000);
    public const int Pending = unchecked((int)0x00000103);

    public const int Unsuccessful = unchecked((int)0xC0000001);
    public const int InvalidParameter = unchecked((int)0xC000000D);
    public const int InvalidDeviceRequest = unchecked((int)0xC0000010);
    public const int EndOfFile = unchecked((int)0xC0000011);
    public const int AccessDenied = unchecked((int)0xC0000022);
    public const int ObjectNameInvalid = unchecked((int)0xC0000033);
    public const int ObjectNameNotFound = unchecked((int)0xC0000034);
    public const int ObjectNameCollision = unchecked((int)0xC0000035);
    public const int InsufficientResources = unchecked((int)0xC000009A);
    public const int NetworkUnreachable = unchecked((int)0xC000023C);
    public const int FileIsADirectory = unchecked((int)0xC00000BA);
    public const int NotADirectory = unchecked((int)0xC0000103);
    public const int DirectoryNotEmpty = unchecked((int)0xC0000101);
    public const int FileDeleted = unchecked((int)0xC0000123);
    public const int MediaWriteProtected = unchecked((int)0xC00000A2);
    public const int DiskFull = unchecked((int)0xC000007F);
    public const int BufferTooSmall = unchecked((int)0xC0000023);
    public const int InvalidBufferSize = unchecked((int)0xC0000206);
    public const int NotImplemented = unchecked((int)0xC0000002);
}
