using System.Text.Json.Serialization;

namespace Mikura.Core.Models;

public record LockStatus(
    [property: JsonPropertyName("locked")] bool Locked,
    [property: JsonPropertyName("lock")] LockInfo? Lock
);
