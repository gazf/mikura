## ADR-021: Migrate the file projection layer from CfApi to WinFsp

**Decision**: Migrate the file projection layer from Windows Cloud Files API (CfApi) to WinFsp (Windows File System Proxy). **This ADR supersedes ADR-013 / ADR-016 / ADR-019 / ADR-020** (relevant parts are redesigned on a WinFsp basis).

**Background — structural limits of CfApi**:

mikura's core design principle is to **realize Samba/SMB-equivalent UX with Zero Trust (HTTPS only)** (ADR-001, ADR-016, ADR-020). Among these, particularly critical is **immediate disconnect when offline** — the moment the network is cut, IO on already-open file handles must fail immediately. SMB invalidates handles simultaneously with TCP session disconnect; the next Read/Write fails immediately with `STATUS_NETWORK_NAME_DELETED` or similar. This underpins the business assumption "the file server is down = you know instantly".

CfApi **cannot structurally meet** this requirement:

| Element | CfApi design | Mismatch with mikura's requirements |
|---|---|---|
| API positioning | sync engine API (OneDrive-like) | not a network filesystem API |
| Access to hydrated data | OS cache is read directly; the API is not involved | cannot stop new IO |
| `CfDisconnectSyncRoot` | blocks new operations only; existing handles survive | cannot kill existing handles on disconnect |
| Read/Write IRP path | kernel cache -> disk directly (API only intervenes at FETCH_DATA) | no means to abort IO at the app level |
| Design philosophy | "cache is visible even offline" UX | "immediate error if offline" UX |

Even with the X-File-Attributes header approach in ADR-019 or the always-dehydrate in ADR-020 to minimize local cache, while a handle is open CfApi keeps reading from the kernel cache. **A Samba-equivalent operation model cannot be built on top of CfApi in principle**.

**What WinFsp achieves**:

WinFsp is a **user-mode file system framework**: all IRPs such as `Create` / `Open` / `Read` / `Write` / `Cleanup` are handed to user-mode callbacks. On network-loss detection:

- New `Create` / `Open` fail immediately with `STATUS_NETWORK_UNREACHABLE`
- **The next `Read` / `Write` on existing handles also fail** <- what CfApi could not do
- Only `Cleanup` / `Close` on existing handles is allowed through (to prevent resource leaks)

**Spike validation on real hardware** (performed in `client/spike/Mikura.WinFspSpike` on 2026-05-04. The directory was deleted after this ADR was adopted; see `a19dfe4` on `feature/winfsp-pivot` in git history):

| Scenario | Result |
|---|---|
| Editing `Z:\hello.txt` in Notepad goes offline -> Save | OK: immediate error, Save As fallback, no hang |
| In progress with `FileStream.Read` (144 KB read) goes offline | OK: next `Read()` raises `IOException` immediately, message "Network is unreachable" |

**Superseded ADRs and direction of redesign**:

- **ADR-013 (ALWAYS_FULL placeholder + WSS event-driven)** -> WinFsp has no placeholder concept. Instead, **"metadata is always local (equivalent to `_nodes`), data is fetched on-demand"** is implemented in our own code inside WinFsp's `Read` callback. WSS event-driven sync is retained.
- **ADR-016 (server-side lock at open)** -> Lock acquisition timing (at open) and lifecycle (Device ID + heartbeat, ADR-018) are **retained as-is**. Only the implementation moves from CfApi's `OnFileOpenAsync` to WinFsp's `Open` callback.
- **ADR-019 (RO reflection via X-File-Attributes header)** -> **No longer needed**. With WinFsp, open on a file locked by another device can be directly rejected with `STATUS_ACCESS_DENIED`. The `X-File-Attributes` header is removed.
- **ADR-020 (always dehydrate at close)** -> "server is the single truth, no local cache" principle is retained. With WinFsp the cache layer is fully in-house, so this is reimplemented by discarding cache at `Cleanup`. The equivalent of `CfDehydratePlaceholder` becomes "release the reference to a `byte[]`", still effectively free.

Retained ADRs (no impact or minor):

- ADR-001 (protocol choice — HTTPS): unchanged. CfApi wording will be corrected later
- ADR-006 / 007 / 008 (WSS / OIDC / permission model): server-side, unchanged
- ADR-018 (Device ID + heartbeat): unchanged
- ADR-009 (zero alloc): in the WinFsp integration layer, more `IntPtr`-based `Marshal.Copy` paths appear, so the policy continues

**New layer composition**:

```
old                                  new
─────────────────────────────────   ─────────────────────────────────
CfApi.Native (P/Invoke)             WinFsp.Interop (Fsp.* wrappers)
CfApi.Interop (UnmanagedCallers)    WinFsp.Host (FileSystemBase derived)
Mikura.Core.Sync.MikuraSyncCallbacks    Mikura.Core.Sync.MikuraFileSystem
Mikura.Core.Sync.SyncEngine           Mikura.Core.Sync.SyncEngine (redesigned)
Mikura.Transport (HTTP/WSS)           Mikura.Transport (HTTP/WSS) — unchanged
Mikura.App                            Mikura.App + WinFsp MSI redistributable
```

**Trade-offs**:

| Aspect | What we lose | What we gain |
|---|---|---|
| Distribution | Easy via OS-bundled driver (CfApi) | Must bundle WinFsp MSI in the Mikura.App installer |
| placeholder / hydration semantics | A set of OS-provided concepts | Fully in-house implementation (freedom in exchange for implementation responsibility) |
| Driver updates | Up to Windows Update | mikura tracks WinFsp releases (annual pace) |
| Bus factor | Official MS | Sole WinFsp maintainer (billziss-gh) |
| Feature ceiling | Bound by CfApi semantics | Only minimal constraints (Win32 IRP model) |
| **Immediate offline disconnect** | **Impossible** | **Possible** <- the deciding factor for migration |

**Rejected alternatives**:

- **Keep CfApi with X-File-Attributes hack extensions**: immediate offline disconnect is impossible in principle. No callout point exists
- **WebDAV (IIS LOCK extension)**: LOCK implementation is fragile (advisory, timeout-dependent, inconsistent across clients). mikura is already WebDAV-independent by policy (README)
- **NFSv4 (mandatory locking)**: weak Windows-native UX; inconsistent with Zero Trust / HTTPS
- **Rewrite from scratch in a new repo**: 60-70% of server / Mikura.Transport / upper SyncEngine logic / test infrastructure is reusable. Staged pivot in the same repo was chosen to keep the rationale in git history

**Migration plan**:

Proceed on the `feature/winfsp-pivot` branch in the following order:

1. Done: Prove "immediate offline disconnect is achievable with WinFsp" via spike (`client/spike/Mikura.WinFspSpike`, later deleted; see git history `a19dfe4`)
2. Done: Document the decision in this ADR
3. Add WinFsp.Interop / WinFsp.Host layers
4. Redesign `Mikura.Core.Sync` callbacks / SyncEngine on a WinFsp basis
5. Remove `CfApi.Native` / `CfApi.Interop`
6. Update README / `Mikura.Client.sln` / Directory.Build.props
7. Bundle WinFsp MSI in the Mikura.App installer (distribution step)
8. Merge to main

**Related ADRs**:

- Supersede: ADR-013, ADR-016 (implementation layer only), ADR-019, ADR-020 (implementation layer only)
- Retain: ADR-001, ADR-004, ADR-006, ADR-007, ADR-008, ADR-009, ADR-014, ADR-015, ADR-018

---
