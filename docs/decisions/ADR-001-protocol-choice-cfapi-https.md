## ADR-001: Protocol choice — CfApi + HTTPS

**Decision**: Adopt Windows Cloud Files API (CfApi) + HTTPS REST API.

**Rejected alternatives**:

- **WebDAV**: Deprecated by Microsoft in 2023, disabled by default on Windows 10/11, scheduled for future removal
- **SMB / Samba extensions**: Outdated protocol design, incompatible with Zero Trust, cannot escape dependency on the Windows kernel implementation
- **Custom protocol**: Cannot be debugged with existing tools (curl, browsers, etc.)

**Rationale**:

- CfApi delivers OneDrive-class UX (Explorer integration, on-demand hydration)
- HTTPS on a single port (443) works through firewalls and proxies
- Encrypted with TLS 1.3, aligned with Zero Trust
- Easy integration with modern authentication (OIDC, JWT)

---
