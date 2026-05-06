import { createMiddleware } from "@hono/hono/factory";
import { logAudit } from "../services/audit.service.ts";
import type { AuthUser } from "../services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
  };
};

export const auditLogger = createMiddleware<Env>(async (c, next) => {
  await next();

  // Only log mutating requests
  const method = c.req.method;
  if (method !== "PUT" && method !== "POST" && method !== "DELETE") {
    return;
  }

  const user = c.get("user");
  if (!user) return;

  const ip = c.req.header("X-Forwarded-For") ??
    c.req.header("X-Real-IP") ??
    "unknown";

  const action = `${method} ${c.req.path}`;
  const path = c.req.path;

  // Fire and forget — don't block response
  logAudit(user.id, action, path, ip).catch(console.error);
});
