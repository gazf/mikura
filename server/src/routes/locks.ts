import { Hono } from "hono";
import { acquireLock, getLock, releaseLock } from "../services/lock.service.ts";
import { checkPermission } from "../services/auth.service.ts";
import type { AuthUser, PermissionContext } from "../services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
    permCtx: PermissionContext;
  };
};

// hono の `*` ワイルドカード経由のパス抽出。`/^\/locks\/?/` を各 handler で
// inline literal にしておくと V8 が cache する保証は弱いので、module-level に
// 1 個を切り出して全 handler で共有する (lock acquire/release は CDM テストの
// open/close リズムで秒間数十回叩かれるので per-call alloc を避けたい)。
const LOCKS_PREFIX_RE = /^\/locks\/?/;

export function registerLockRoutes(app: Hono<Env>) {
  // POST /locks/*path — acquire lock
  app.post("/locks/*", async (c) => {
    const wildcard = c.req.path.replace(LOCKS_PREFIX_RE, "");
    const filePath = "/" + wildcard;
    const user = c.get("user");

    const permCtx = c.get("permCtx");
    if (!(await checkPermission(user.id, filePath, "write", permCtx))) {
      return c.json({ message: "Forbidden" }, 403);
    }

    const result = await acquireLock(filePath, user.id, user.deviceId);
    console.log(
      `[locks] POST ${filePath} userId=${user.id} deviceId=${
        user.deviceId.slice(0, 8)
      } → success=${result.success}${
        result.success ? "" : ` msg=${result.message}`
      }`,
    );
    if (!result.success) {
      return c.json({ message: result.message, lock: result.lock }, 409);
    }

    return c.json(result.lock, 200);
  });

  // DELETE /locks/*path — release lock
  app.delete("/locks/*", async (c) => {
    const wildcard = c.req.path.replace(LOCKS_PREFIX_RE, "");
    const filePath = "/" + wildcard;
    const user = c.get("user");

    const released = await releaseLock(filePath, user.id, user.deviceId);
    console.log(
      `[locks] DELETE ${filePath} userId=${user.id} deviceId=${
        user.deviceId.slice(0, 8)
      } → released=${released}`,
    );
    if (!released) {
      return c.json({ message: "Not the lock holder" }, 403);
    }

    return c.json({ message: "Unlocked" }, 200);
  });

  // GET /locks/*path — check lock status
  app.get("/locks/*", async (c) => {
    const wildcard = c.req.path.replace(LOCKS_PREFIX_RE, "");
    const filePath = "/" + wildcard;
    const lock = await getLock(filePath);

    if (!lock) {
      return c.json({ locked: false }, 200);
    }

    return c.json({ locked: true, lock }, 200);
  });
}
