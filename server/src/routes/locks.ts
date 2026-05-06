import { Hono } from "hono";
import { acquireLock, getLock, releaseLock } from "../services/lock.service.ts";
import { checkPermission } from "../services/auth.service.ts";
import type { AuthUser } from "../services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
  };
};

export function registerLockRoutes(app: Hono<Env>) {
  // POST /locks/*path — acquire lock
  app.post("/locks/*", async (c) => {
    const wildcard = c.req.path.replace(/^\/locks\/?/, "");
    const filePath = "/" + wildcard;
    const user = c.get("user");

    if (!(await checkPermission(user.id, filePath, "write"))) {
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
    const wildcard = c.req.path.replace(/^\/locks\/?/, "");
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
    const wildcard = c.req.path.replace(/^\/locks\/?/, "");
    const filePath = "/" + wildcard;
    const lock = await getLock(filePath);

    if (!lock) {
      return c.json({ locked: false }, 200);
    }

    return c.json({ locked: true, lock }, 200);
  });
}
