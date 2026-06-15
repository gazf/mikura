## ADR-006: Event notification — adopt WebSocket (WSS)

**Decision**: Push diff events from the server to the client over WebSocket (WSS).

**Rejected alternatives**:

- **Polling**: No real-time responsiveness, high server load
- **SSE alone**: Server-to-client direction only, no bidirectional communication

**Possibility of keeping SSE as a fallback**:

If the WSS idle timeout under Cloudflare Tunnel (100 seconds on Free/Pro) becomes an issue, an SSE fallback will be considered. WSS only at this point.

**Rationale**:

- Real-time diff reception is possible
- Bidirectional communication (e.g. the heartbeat in the future ADR-018) can be leveraged
- Standard protocol, easy to debug

**Related ADRs**: ADR-013 (WSS formally adopted by this decision), ADR-018 (SID heartbeat sent over WSS)

---
