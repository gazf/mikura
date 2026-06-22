import { createMiddleware } from "@hono/hono/factory";
import {
  type AuthUser,
  PermissionContext,
  upsertDevice,
  validateToken,
} from "../services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
    permCtx: PermissionContext;
  };
};

// UUID v4 など typical な device ID 形式を緩く検証 (空文字や妙な制御文字を弾く)
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

export const authMiddleware = createMiddleware<Env>(async (c, next) => {
  // Skip auth for health check と enrollment (= 認証前の bootstrap path)
  if (c.req.path === "/health" || c.req.path === "/enroll") {
    await next();
    return;
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ message: "Missing or invalid Authorization header" }, 401);
  }

  // deviceId は validateToken の binding check 入力としても必要なので、token
  // 検証より先に取り出す。format 不正は token 検証する価値もないので 400。
  const deviceId = c.req.header("X-Device-Id");
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return c.json({ message: "Missing or invalid X-Device-Id header" }, 400);
  }

  // 直近 IP は audit / 異常検知の input。Hono の Request には標準で remote
  // info を取る API が無いので、X-Forwarded-For があればそれ、無ければ
  // socket info から (= 大半は reverse proxy 越し前提)。
  const ip = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    c.req.header("X-Real-IP") ?? undefined;

  const token = authHeader.slice(7);
  const identity = await validateToken(token, { deviceId, ip });
  if (!identity) {
    return c.json({ message: "Invalid or expired token" }, 401);
  }

  // Best-effort device registration. 失敗しても auth 全体を落とさない
  // (KV 一時障害で全リクエスト 500 にしないため)。
  try {
    await upsertDevice(deviceId, identity.id, ip);
  } catch (err) {
    console.error("upsertDevice failed:", err);
  }

  c.set("user", { ...identity, deviceId });
  // request スコープの permission cache。groupIds / permission(path, groupId)
  // の duplicate KV lookup を排除する (GET /tree で N entries × parent path
  // 重複が劇的に効く)。lifetime は本 request のみ。
  c.set("permCtx", new PermissionContext());
  await next();
});
