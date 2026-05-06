using System.Text.Json.Serialization;

namespace Mikura.Core.Models;

/// <summary>
/// PUT /content の戻り値。アップロード後のサーバー側メタデータを表す。
/// CfApi の UpdatePlaceholder で placeholder を最新状態に同期するために使用。
/// </summary>
public record UploadResult(
    [property: JsonPropertyName("size")] long Size,
    [property: JsonPropertyName("lastModified")] DateTime LastModified
);
