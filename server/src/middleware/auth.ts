import { createMiddleware } from "@hono/hono/factory";
import {
  type AuthUser,
  upsertDevice,
  validateToken,
} from "../services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
  };
};

// UUID v4 など typical な device ID 形式を緩く検証 (空文字や妙な制御文字を弾く)
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
  // Skip auth for health check
  if (c.req.path === "/health") {
    await next();
    return;
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ message: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const identity = await validateToken(token);
  if (!identity) {
    return c.json({ message: "Invalid or expired token" }, 401);
  }

  const deviceId = c.req.header("X-Device-Id");
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return c.json({ message: "Missing or invalid X-Device-Id header" }, 400);
  }

  // Best-effort device registration. 失敗しても auth 全体を落とさない
  // (KV 一時障害で全リクエスト 500 にしないため)。
  try {
    await upsertDevice(deviceId, identity.id);
  } catch (err) {
    console.error("upsertDevice failed:", err);
  }

  c.set("user", { ...identity, deviceId });
  await next();
});
