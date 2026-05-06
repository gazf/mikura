using System.Text.Json.Serialization;

namespace Mikura.Core.Models;

public record LockInfo(
    [property: JsonPropertyName("userId")] int UserId,
    [property: JsonPropertyName("acquiredAt")] string AcquiredAt,
    [property: JsonPropertyName("expiresAt")] string ExpiresAt
);
