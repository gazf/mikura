/**
 * console の session endpoint (`/auth/session`)。
 *
 * ADR-033: browser は `Authorization` も `X-Device-Id` も持てないので、
 * console 側で session を張り、API サーバへは console が bearer token で
 * 喋る。token は login 時に admin が貼り付け、**server 側の session に
 * だけ**保持される。browser に返るのは opaque な session id のみで、
 * disk にも env にも残らない。
 */

import type { Hono } from "hono";
import { getCookie, setCookie } from "@hono/hono/cookie";
import { SESSION_COOKIE } from "../session/store.ts";
import type { ConsoleEnv } from "../app.ts";

interface WhoAmI {
  id: number;
  name: string;
  deviceId: string;
}

export function registerSessionRoutes(app: Hono<ConsoleEnv>) {
  /**
   * login。body は `{ token }` — API サーバの admin bearer token。
   *
   * 検証は `GET /admin/whoami` に丸投げする。console 側で「admin かどうか」を
   * 判定しないのが要点で、認可の SSOT は API サーバの `requireAdmin` 1 箇所に
   * 保たれる。
   */
  app.post("/auth/session", async (c) => {
    const { api, sessions, config } = c.get("deps");

    let body: { token?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (token.length === 0) {
      return c.json({ message: "token required" }, 400);
    }

    const res = await api.get<WhoAmI>(token, "/admin/whoami");
    if (res.status === 401) {
      return c.json({ message: "トークンが無効か期限切れです" }, 401);
    }
    if (res.status === 403) {
      return c.json(
        { message: "このトークンには admin 権限がありません" },
        403,
      );
    }
    if (res.status === 400) {
      // authMiddleware の X-Device-Id 検証で弾かれた場合。console の
      // MIKURA_CONSOLE_DEVICE_ID 設定ミスなので、そう判るようにする。
      return c.json(
        { message: `console の device ID が拒否されました: ${res.message}` },
        500,
      );
    }
    if (res.status !== 200 || !res.body) {
      return c.json(
        { message: res.message ?? "API サーバに接続できません" },
        502,
      );
    }

    const id = sessions.create(token, res.body.id, res.body.name);
    setCookie(c, SESSION_COOKIE, id, {
      httpOnly: true,
      // CSRF の第一防衛線。console は cross-site から叩かれる用途が無いので
      // Lax ではなく Strict で足りる。
      sameSite: "Strict",
      secure: config.cookieSecure,
      path: "/",
      maxAge: Math.floor(config.sessionAbsoluteMs / 1000),
    });
    return c.json({ userId: res.body.id, userName: res.body.name });
  });

  /** whoami。未ログインは 401 で、UI 側は login 画面に倒す。 */
  app.get("/auth/session", (c) => {
    const { sessions } = c.get("deps");
    const session = sessions.get(getCookie(c, SESSION_COOKIE));
    if (!session) return c.json({ message: "Not authenticated" }, 401);
    return c.json({ userId: session.userId, userName: session.userName });
  });

  /** logout。session を破棄し cookie も落とす。 */
  app.delete("/auth/session", (c) => {
    const { sessions, config } = c.get("deps");
    sessions.destroy(getCookie(c, SESSION_COOKIE));
    setCookie(c, SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "Strict",
      secure: config.cookieSecure,
      path: "/",
      maxAge: 0,
    });
    return c.json({ ok: true });
  });
}
