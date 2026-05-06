using System.Text.Json.Serialization;

namespace Mikura.Core.Models;

/// <summary>
/// server が statfs(2) 経由で返す storage FS の容量情報。
/// WinFsp の <c>VolumeInfo</c> callback の入力にする。
/// </summary>
public record VolumeStats(
    [property: JsonPropertyName("totalSize")] long TotalSize,
    [property: JsonPropertyName("freeSize")] long FreeSize
);
