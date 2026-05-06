using System.Text.Json.Serialization;

namespace Mikura.Core.Models;

public record TreeNode(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("size")] long Size,
    [property: JsonPropertyName("lastModified")] DateTime LastModified,
    [property: JsonPropertyName("isReadOnly")] bool IsReadOnly = false
)
{
    public bool IsDirectory => Type == "directory";

    public string Name => Path.LastIndexOf('/') is int i && i >= 0
        ? Path[(i + 1)..]
        : Path;

    public string ParentPath => Path.LastIndexOf('/') is int i && i > 0
        ? Path[..i]
        : "/";
}
