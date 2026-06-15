## ADR-007: Authentication — OIDC + JWT

**Decision**: Skip LDAP / Kerberos; authenticate via OIDC (OpenID Connect), authorize with JWT.

**Rationale**:

- Direct integration with Google Workspace, Microsoft 365, Okta, Keycloak, etc.
- Standard MFA support
- A single authentication mechanism for both HTTP and WebSocket via JWT
- Stateless, easy to scale

**JWT claim design**:

```json
{
  "sub": "user-id",
  "device_id": "laptop-abc123",
  "iat": 1234567890,
  "exp": 1234571490
}
```

Short-lived (1 hour) + refresh token. Device ID is included for Zero Trust.

---
