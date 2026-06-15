## ADR-007: 認証 — OIDC + JWT

**決定**: LDAP / Kerberos を使わず、OIDC(OpenID Connect)経由で認証、JWT で認可。

**選択理由**:

- Google Workspace、Microsoft 365、Okta、Keycloak 等と直接統合可能
- MFA 標準対応
- JWT で HTTP / WebSocket 両方に同じ認証機構
- ステートレス、スケール容易

**JWT クレーム設計**:

```json
{
  "sub": "user-id",
  "device_id": "laptop-abc123",
  "iat": 1234567890,
  "exp": 1234571490
}
```

短命(1 時間)+ リフレッシュトークン。デバイス ID も含め Zero Trust 対応。

---
