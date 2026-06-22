/**
 * POST /enroll: 初回認証 (bootstrap)。
 *
 * Flow:
 *   1. admin が `deno task admin issue-init` で enrollment secret を発行
 *   2. admin が init.json (= { ServerUrl, EnrollmentSecret }) を user に配布
 *   3. user の client が初回起動時に POST /enroll { secret, deviceId } を投げる
 *   4. server: secret を atomic に consume + bearer token 発行 (boundDeviceId=deviceId)
 *   5. client: response の token を DPAPI 暗号化して secret.bin に保存
 *
 * 認証なしで叩ける endpoint (= authMiddleware 側で skip)。raw secret 自体が
 * single-use credential なので、それ以上の auth は不要。
 *
 * 失敗時:
 *   - 400: body validation 失敗
 *   - 410 Gone: secret が無効 / 期限切れ / consume 済み (全て同じ message に
 *     畳んで、enumeration attack の手掛かりを返さない)
 *   - 500: KV 障害等
 */

import { Hono } from "hono";
import {
  consumeEnrollment,
  EnrollmentError,
} from "../services/enrollment.service.ts";

// deviceId format validation (middleware/auth.ts と同じ規律)
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * `Env` 型を緩い指定にしているのは、`/enroll` 自体は auth middleware 外で
 * 動作するため `user` / `permCtx` を必要としないから。`app.ts` 側で
 * `Hono<Env>` を渡してもこの relax された型は assignable。
 */
// deno-lint-ignore no-explicit-any
export function registerEnrollRoutes(app: Hono<any>) {
  app.post("/enroll", async (c) => {
    let body: { secret?: unknown; deviceId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }

    const secret = body.secret;
    const deviceId = body.deviceId;
    if (typeof secret !== "string" || secret.length === 0) {
      return c.json({ message: "secret required" }, 400);
    }
    if (typeof deviceId !== "string" || !DEVICE_ID_RE.test(deviceId)) {
      return c.json({
        message: "deviceId required (8-128 chars [A-Za-z0-9_-])",
      }, 400);
    }

    try {
      const result = await consumeEnrollment(secret, deviceId);
      console.log(
        `[enroll] consumed userId=${result.userId} user=${result.userName} deviceId=${
          deviceId.slice(0, 8)
        }`,
      );
      return c.json(
        {
          bearerToken: result.rawToken,
          userId: result.userId,
          userName: result.userName,
        },
        201,
      );
    } catch (e) {
      if (e instanceof EnrollmentError) {
        // invalid_or_expired / already_consumed / user_not_found を全て同じ
        // generic message に畳む (= enumeration を防ぐ)。status code は分けて
        // 計測 / 監視は server log 側で区別する。
        console.warn(
          `[enroll] failed code=${e.code} status=${e.statusCode} deviceId=${
            deviceId.slice(0, 8)
          }`,
        );
        return c.json(
          { message: "Enrollment secret invalid or already consumed" },
          e.statusCode as 410,
        );
      }
      throw e;
    }
  });
}
