namespace Mikura.Core.Models;

/// <summary>
/// multipart/mixed PATCH 用の 1 range 記述。
/// <see cref="BufferOffset"/> + <see cref="Length"/> で送信バッファ内の位置を、
/// <see cref="FileOffset"/> でサーバ側 staging file 内の書込み位置を指す。
/// 同一バッファに複数 range を pack するときの metadata として使われる。
/// </summary>
public readonly record struct UploadRange(long FileOffset, int BufferOffset, int Length);
