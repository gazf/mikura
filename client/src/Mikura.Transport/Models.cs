using System.Text.Json.Serialization;

namespace Mikura.Transport;

public record ErrorResponse(
    [property: JsonPropertyName("message")] string Message
);

internal sealed record StartUploadResponse(
    [property: JsonPropertyName("uploadId")] string UploadId,
    [property: JsonPropertyName("path")] string Path
);

internal sealed record RenameRequest(
    [property: JsonPropertyName("newPath")] string NewPath
);

internal sealed record StartUploadRequest(
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("baseFromExisting")] bool BaseFromExisting
);

internal sealed record FinalizeRequest(
    [property: JsonPropertyName("size")] long Size
);

/// <summary>
/// WSS heartbeat / terminate の send payload。type だけ違って構造は同じ。
/// 手組み JSON 文字列を排除して proper escape を効かせる(deviceId に quote が
/// 混じった時の injection ガード)+ source-gen で reflection なしに直 UTF-8 化。
/// </summary>
internal sealed record WsControlMessage(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("deviceId")] string DeviceId
);
