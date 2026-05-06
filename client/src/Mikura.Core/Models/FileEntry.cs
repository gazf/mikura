namespace Mikura.Core.Models;

/// <summary>
/// Domain-shaped file/directory metadata used by <c>IFileSystemBackend</c>.
/// Distinct from <see cref="FileNode"/> (server-wire DTO) and
/// <see cref="TreeNode"/> (server tree DTO).
/// </summary>
public sealed record FileEntry(
    string Path,
    bool IsDirectory,
    long Size,
    DateTime CreationTimeUtc,
    DateTime LastWriteTimeUtc,
    bool IsReadOnly = false)
{
    public string Name
    {
        get
        {
            var sep = Path.LastIndexOfAny(new[] { '/', '\\' });
            return sep < 0 ? Path : Path[(sep + 1)..];
        }
    }
}

public sealed record FileBasicInfo(
    DateTime? CreationTimeUtc = null,
    DateTime? LastAccessTimeUtc = null,
    DateTime? LastWriteTimeUtc = null);
