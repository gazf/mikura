using System.Text.Json.Serialization;

namespace Mikura.Transport;

public record ErrorResponse(
    [property: JsonPropertyName("message")] string Message
);
