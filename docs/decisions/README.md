# Architecture Decision Records

Records design decisions that have significant implementation impact, capturing the decision, alternatives, and rationale.
Each ADR is split into its own file.

| # | Title |
|---|---|
| ADR-001 | [Protocol choice — CfApi + HTTPS](ADR-001-protocol-choice-cfapi-https.md) |
| ADR-002 | [Rejecting Vanara.PInvoke.CldApi](ADR-002-not-adopting-vanarapinvokecldapi.md) |
| ADR-003 | [Layer structure — 5 layers](ADR-003-layer-structure-5-layers.md) |
| ADR-004 | [Offline behavior — read-only or unavailable](ADR-004-offline-behavior-read-only-or-unavailable.md) |
| ADR-005 | [Conflict resolution — server-side lock (initial)](ADR-005-conflict-resolution-server-side-lock-initial-versi.md) |
| ADR-006 | [Event notification — WebSocket (WSS) adoption](ADR-006-event-notification-adopt-websocket-wss.md) |
| ADR-007 | [Authentication — OIDC + JWT](ADR-007-authentication-oidc-jwt.md) |
| ADR-008 | [Permission model — path + principal × action](ADR-008-permission-model-path-principal-action.md) |
| ADR-009 | [Scope of Zero Alloc application](ADR-009-scope-of-zero-alloc.md) |
| ADR-010 | [HTTP/2 adoption (future)](ADR-010-adopt-http-2-future.md) |
| ADR-011 | [Test strategy](ADR-011-testing-strategy.md) |
| ADR-012 | [Rejecting OpenAPI / TypeSpec (for now)](ADR-012-do-not-adopt-openapi-typespec-for-now.md) |
| ADR-013 | [Placeholder strategy — ALWAYS_FULL + WSS event-driven](ADR-013-placeholder-strategy-always-full-wss-event-driven.md) |
| ADR-014 | [Hybrid modification detection — open/close window + sync timestamp based](ADR-014-hybrid-modification-detection-open-close-window-sy.md) |
| ADR-015 | [oplock handle open/close strategy](ADR-015-oplock-handle-open-close-strategy.md) |
| ADR-016 | [Lock acquisition timing — at open + Liveness-based management](ADR-016-lock-acquisition-timing-at-open-liveness-based-man.md) |
| ADR-017 | [Conflict file strategy — last resort for anomalies](ADR-017-conflict-file-strategy-last-resort-for-abnormal-si.md) |
| ADR-018 | [Device ID-based Liveness lock management](ADR-018-device-id-based-liveness-lock-management.md) |
| ADR-019 | [Conveying file attributes via response headers](ADR-019-convey-file-attributes-via-response-headers.md) |
| ADR-020 | [Always dehydrate on close — operation model equivalent to SMB over VPN](ADR-020-always-dehydrate-at-close-operation-model-equivale.md) |
| ADR-021 | [Migrating the file projection layer from CfApi to WinFsp](ADR-021-migrate-the-file-projection-layer-from-cfapi-to-wi.md) |
| ADR-022 | [Lock acquisition scope on WinFsp — write-intent + in-process refcount](ADR-022-lock-acquisition-scope-on-winfsp-write-intent-in-p.md) |
| ADR-023 | [Design and upper bound of in-memory staging buffer](ADR-023-design-and-ceiling-of-the-in-memory-staging-buffer.md) |
| ADR-024 | [Folder creation + rename support (server endpoint extension)](ADR-024-folder-creation-rename-support-server-endpoint-ext.md) |
| ADR-025 | [Byte-range upload session that streams kernel writes through directly](ADR-025-byte-range-upload-session-that-streams-kernel-writ.md) |
| ADR-027 | [Retaining WinFsp async response API (`SendReadResponse` family)](ADR-027-retaining-winfsp-async-response-api-sendreadrespon.md) |
| ADR-028 | [Shelving HTTP/2 adoption — Deno's HTTP/2 settings not exposed and PATCH path incompatibility](ADR-028-shelving-http-2-adoption-denos-http-2-settings-not.md) |
| ADR-029 | [Client-side write cache — range-coalesce + multipart/byteranges + per-path session sharing](ADR-029-client-side-write-cache-range-coalesce-multipart-b.md) |
| ADR-030 | [WriteCoalescer ArrayPool selection — adopting bounded `maxArraysPerBucket=16`](ADR-030-writecoalescer-arraypool-selection-adopting-bounde.md) |
| ADR-031 | [Per-handle read-ahead prefetch cache for the read path (Samba-style next-sequential)](ADR-031-per-handle-read-ahead-prefetch-cache-for-the-read.md) |
| ADR-032 | [Replacing the WinFsp .NET binding with an in-house modern P/Invoke binding](ADR-032-replacing-the-winfsp-net-binding-with-an-in-house.md) |
