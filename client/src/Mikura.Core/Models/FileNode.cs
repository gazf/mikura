using System.Text.Json.Serialization;

namespace Mikura.Core.Models;

public record FileNode(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("size")] long Size,
    [property: JsonPropertyName("lastModified")] DateTime LastModified
);
