## ADR-013: Placeholder strategy — ALWAYS_FULL + WSS event-driven

**Decision**: At startup, fetch the full tree via `/tree`, create placeholders in bulk with `CF_POPULATION_POLICY_ALWAYS_FULL`, and receive incremental pushes over WSS.

**Rejected alternatives**:

- **On-demand via PARTIAL + FETCH_PLACEHOLDERS**: directory expansion latency freezes Explorer; degraded UX
- **Polling-based incremental sync**: loses WSS real-time properties; high server load

**Reasons for selection**:

- Explorer operations respond instantly (same feel as offline files)
- Changes from other clients reflect in real time over WSS
- Real-machine verification confirmed dramatic UX improvement

**Implementation findings (from real-machine verification)**:

- Even with ALWAYS_FULL, the OS may still send `FETCH_PLACEHOLDERS`, so a handler that immediately replies with an empty list must remain
- On restart, `CfCreatePlaceholders` returning `ERROR_ALREADY_EXISTS (0x800700B7)` is treated as normal behavior
- For WSS, Deno auto-closes the watcher when the `for await` loop breaks, so `watcher.close()` in `onclose` becomes a double close. Guard with `closeWatcher`
- `CreatePlaceholders` at startup alone does not make entries visible in Explorer. Issue `SHCNE_UPDATEDIR` to trigger re-enumeration

**Scalability constraints**:

- Beyond tens of thousands of files, startup `/tree` fetch and `CreatePlaceholders` become time-consuming
- Realistic upper bound is around 100,000 files
- If larger scale is required, consider migrating to a hybrid strategy: ALWAYS_FULL only directly under root, PARTIAL for subdirectories

**Fallback / reconnect**:

- On WSS disconnect, auto-reconnect with 5-second backoff (`RunEventLoopWithReconnectAsync`)
- If events are missed, manual `OnSyncNow` recovers via full sync

**Related ADRs**:

- ADR-006 (event notification): WSS formally adopted by this decision

---
