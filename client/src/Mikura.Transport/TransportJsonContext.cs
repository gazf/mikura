using System.Text.Json.Serialization;
using Mikura.Core.Abstractions;
using Mikura.Core.Models;

namespace Mikura.Transport;

/// <summary>
/// System.Text.Json の source generator 経由で transport が触る全 DTO の
/// (de)serialize コードを compile-time に生成する。reflection ベースの
/// JsonSerializer ヘルパに比べて:
/// - startup 時の type discovery / metadata 構築のコストが消える
/// - hot path で reflection が走らない → 低 allocation, 高速
/// - trim / Native AOT 安全(将来 AOT へ移行する場合のための布石)
/// 新しい DTO を追加したら必ず <c>[JsonSerializable]</c> をここに追加すること。
/// </summary>
[JsonSerializable(typeof(TreeNode))]
[JsonSerializable(typeof(List<TreeNode>))]
[JsonSerializable(typeof(FileNode))]
[JsonSerializable(typeof(List<FileNode>))]
[JsonSerializable(typeof(UploadResult))]
[JsonSerializable(typeof(LockInfo))]
[JsonSerializable(typeof(VolumeStats))]
[JsonSerializable(typeof(StartUploadResponse))]
[JsonSerializable(typeof(ErrorResponse))]
[JsonSerializable(typeof(RenameRequest))]
[JsonSerializable(typeof(StartUploadRequest))]
[JsonSerializable(typeof(FinalizeRequest))]
[JsonSerializable(typeof(ServerEvent))]
[JsonSerializable(typeof(LockHolder))]
[JsonSerializable(typeof(WsControlMessage))]
internal sealed partial class TransportJsonContext : JsonSerializerContext
{
}
