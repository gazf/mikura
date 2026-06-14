using System.Runtime.InteropServices;

namespace WinFsp.Native.Native;

/// <summary>
/// FSP_FILE_SYSTEM_OPERATION_CONTEXT — winfsp/winfsp.h:1122-1126。
/// 現在 dispatcher thread で処理中の IRP の Request / Response ポインタを保持する。
/// <see cref="NativeApi.FspFileSystemGetOperationContext"/> で取得。
/// </summary>
[StructLayout(LayoutKind.Sequential)]
public unsafe struct OperationContext
{
    /// <summary>FSP_FSCTL_TRANSACT_REQ*</summary>
    public TransactReqHeader* Request;
    /// <summary>FSP_FSCTL_TRANSACT_RSP* (kernel が用意した出力 buffer)</summary>
    public void* Response;
}

/// <summary>
/// FSP_FSCTL_TRANSACT_REQ の先頭 24 byte だけをミラー。Hint と Kind が分かれば
/// async response の組み立てには十分。残りフィールド (FileName 等) は callback の
/// 引数で別途渡されているので Request 経由では参照しない。
/// </summary>
[StructLayout(LayoutKind.Sequential)]
public struct TransactReqHeader
{
    public ushort Version;
    public ushort Size;
    public uint Kind;
    public ulong Hint;
}

/// <summary>
/// FSP_FSCTL_TRANSACT_RSP の固定サイズ部 (header + IoStatus + Rsp union)。
/// Buffer[] flexible array は本実装では未使用 (Read/Write 経路は別 channel で
/// データを返すため)。Size = sizeof = 128 byte (union が Opened のとき最大、
/// その分の枠を全 Rsp variant で共有)。
/// </summary>
/// <remarks>
/// レイアウト内訳:
///   header: Version(2) + Size(2) + Kind(4) + Hint(8) = 16 byte
///   IoStatus: Information(4) + Status(4) = 8 byte → 24
///   Rsp union (最大要素 = Opened): UserContext*2(16) + GrantedAccess(4) +
///     SDBuf(4) + FileInfo(72) + FileNameBuf(4) + bitfield(4) = 104 byte → 128
/// </remarks>
[StructLayout(LayoutKind.Sequential, Size = 128)]
public struct TransactRsp
{
    public ushort Version;
    public ushort Size;
    public uint Kind;
    public ulong Hint;
    public uint IoStatusInformation;
    public uint IoStatusStatus;
    // 以降 union 領域 (104 byte) は zero-fill のまま、Write 等で必要な field のみ
    // pointer 計算で書き込む。
}
