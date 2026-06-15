## ADR-008: Permission model — path + principal × action

**Decision**: Fine-grained authorization of "user / group" × "path" × "read / write / admin".

**Deno KV schema**:

```
["users", userId]                   → { id, name, email, groups }
["groups", groupId]                 → { id, name, members }
["permissions", path, type, id]     → { path, principal, access }
```

**Access check**:

- Walk up the path's parent hierarchy to evaluate
- Check permissions for both the user themselves and the groups they belong to
- OK if any of them grants permission

---
