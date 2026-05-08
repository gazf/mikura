using System.Text.Json.Serialization;

namespace Mikura.Core.Abstractions;

public record LockHolder(
    [property: JsonPropertyName("userId")] int UserId,
    [property: JsonPropertyName("deviceId")] string DeviceId,
    [property: JsonPropertyName("name")] string Name
);

public record ServerEvent(
    [property: JsonPropertyName("event")] string Event,
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("type")] string? Type = null,
    [property: JsonPropertyName("size")] long Size = 0,
    [property: JsonPropertyName("lastModified")] DateTime? LastModified = null,
    [property: JsonPropertyName("holder")] LockHolder? Holder = null,
    [property: JsonPropertyName("originatorDeviceId")] string? OriginatorDeviceId = null
);

public interface IEventStream : IAsyncDisposable
{
    IAsyncEnumerable<ServerEvent> ReadEventsAsync(CancellationToken ct);
}
