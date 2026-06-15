## ADR-028: Shelving HTTP/2 adoption — Deno's HTTP/2 settings not exposed and PATCH path incompatibility

**Decision**: HTTP/2 migration is **shelved** for now, **operating with HTTP/1.1 cleartext** (no TLS either). Reconsider when Deno exposes HTTP/2 tuning items.

### Background

ADR-025's chunked upload and GET /content Range read both hit a concurrency ceiling at the HTTP/1.1 8-connection cap. Raising `MaxConnectionsPerServer = 8` causes per-connection internal buffers to balloon and consume memory ([Mikura.App TrayAppContext.cs](../client/src/Mikura.App/Ui/TrayAppContext.cs)).

Introducing HTTP/2 multiplex would let many streams run concurrently over 1 TCP connection, virtually eliminating the conn-per-server cap. We expected this to be particularly effective for **512 outstanding** workloads like CDM RND 4K Q=32 T=16 Read, and verified on actual hardware in the `feat/perf-instrumentation` branch.

### What the verification revealed

1. **HTTP/2 multiplex does work on the read side**

   | Test | HTTP/1.1 (B2 baseline) | HTTP/2 (TLS, 16MB stream window) |
   |---|---|---|
   | **RND 4K Q=32 T=16 Read** | 2.06 MB/s | **2.90 MB/s** (+40%) |
   | SEQ 128K Q=32 Read | 91 | 79 (-14%) |
   | SEQ 1M Q=8 Read | 290-330 | 290 (flat) |

   The sweet spot showed for RND Read which needs 512 outstanding. Low-concurrency SEQ Read shows slight degradation due to HTTP/2 framing overhead.

2. **The write side (PATCH) becomes catastrophically slow**

   | Test | HTTP/1.1 | HTTP/2 |
   |---|---|---|
   | SEQ 1M Q=8 Write | 172-226 | **44** (-80%) |
   | SEQ 128K Q=32 Write | 152-169 | **54** (-65%) |

   The cause is HTTP/2's **per-stream initial window 64KB** (RFC 7540 default). For PATCH body 128KB it's 1 round, for 1MB it's **15 rounds** of `WINDOW_UPDATE` round-trip wait per chunk. The 1 RTT (~0.5-1ms) on LAN/loopback directly piles on per-chunk and worsens proportionally to body size.

3. **Client-side window expansion only helps GET**

   .NET `SocketsHttpHandler.InitialHttp2StreamWindowSize = 16MB` expands the client-side **receive** window. This helps GET /content (measured improvement on SEQ 128K Read). However, PATCH's **send** window is governed by the server-side (Deno) receive window, and the client-side setting can't rescue it.

4. **Deno does not expose HTTP/2 settings**

   `Deno.serve({ cert, key })` options accept no HTTP/2 tuning items at all. The internal hyper crate has options like `http2_initial_stream_window_size` / `http2_adaptive_window`, but as of 2026-06 Deno does not forward them. Via `Deno.serve`, the window is forced to the default 64KB.

5. **Related issue/PR investigation on GitHub** (as of 2026-06)

   - `denoland/deno#33332` (merged 2026-04): Fix `node:http2` settings validation (including `initialWindowSize`) to spec
   - `denoland/deno#33640` (merged 2026-04): Fix HTTP/2 stream window replenishment behavior
   - `denoland/deno#26088` / `#29206` (closed): `http2.createSecureServer` implementation completed
   - **No PR** to expose HTTP/2 settings on the `Deno.serve` side

### Rejected alternatives

- **`node:http2`-based server wrapper (`createSecureServer` + `settings.initialWindowSize`)**: Technically possible, connecting Hono's fetch handler via an ~100-line adapter. However, mikura's `/events` (WebSocket upgrade) handled via Deno.upgradeWebSocket can't be used on the node:http2 path, leading to a dual-stack setup where only WSS escapes to a separate port via Deno.serve. **Insufficient confidence in payoff vs. implementation cost** (whether window expansion rescues PATCH, or it eventually clogs on connection-level window or TCP backpressure, is unverified). Shelved for now, leaving room for revival under "reconsideration conditions" below.
- **Fork Deno and force `http2_adaptive_window: true` ON**: Root cure, but cost of touching Rust internals + upstream sync debt.
- **Place Cloudflare etc. in front**: Edge provides HTTP/2 / HTTP/3, origin is HTTP/1.1. Mismatched with mikura's LAN-oriented use case. Re-evaluate when publishing to the internet in the future.

### Also not adopting TLS

Since HTTP/2 is not adopted, TLS introduction for the purpose of keeping the ALPN negotiation path is also **shelved** this time. HTTPS adds operational burden of dev cert generation, distribution, and expiry management, while current mikura is intended for LAN-internal / single-trust-boundary use and meets requirements with plaintext HTTP.

When the decision to re-adopt HTTP/2 is made in the future:

1. Enable TLS (dev: self-signed, prod: regular cert or Let's Encrypt)
2. Configure server to advertise h2 via ALPN
3. Switch client `HttpVersion` to Version20

Set up in this order. Procedures equivalent to `deno task gen-cert` will be rebuilt at re-introduction time.

Same stance as ADR-027: "Adoption shelved, record investigation results and future resumption conditions".

### Reconsideration conditions

Re-evaluate HTTP/2 adoption when any of the following occurs:

1. **Deno exposes HTTP/2 settings on `Deno.serve`** — particularly equivalent to `initialWindowSize` or `adaptiveWindow: true`. This alone is expected to resolve the PATCH path (the most likely resumption trigger anticipated by this ADR).
2. **hyper crate's `http2_adaptive_window` default changes to true** — Possibly benefiting even without Deno forwarding. Depends on upstream behavior.
3. **mikura's operation goes over the internet / through Cloudflare** — In a world where edge provides HTTP/2 / HTTP/3, origin choices change. TLS also becomes mandatory by external requirements simultaneously.
4. **The client parallelism cap (`MaxConnectionsPerServer = 8`) becomes the real bottleneck** — Even with current HTTP/1.1 + 8 conn, if other dominant factors emerge in RND 4K Q=32 T=16 Read and HTTP/2 multiplex shows signs of breakthrough.

### Related ADRs

- Prerequisite: ADR-025 (per-IRP HTTP passthrough write path, ChunkedUploader structure)
- Related investigation: measurement results in the `feat/perf-instrumentation` branch (collecting server-side phase timing + client-side PATCH wall time via diag instrumentation to identify bottleneck locations). After adopting this ADR, the measurement branch itself is deleted (rewrite the same instrumentation for re-investigation)

---
