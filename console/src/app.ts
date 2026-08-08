/**
 * console app の組み立て。
 *
 * ADR-033 の信頼境界:
 *
 *   browser --cookie--> console --Bearer + X-Device-Id--> API server --> KV
 *
 * console は KV も data root も開かない。API サーバから見れば admin token を
 * 持った 1 クライアントに過ぎず、認可判定は全て向こう側の `requireAdmin` が
 * 行う。
 */

import { Hono } from "hono";
import { getCookie } from "@hono/hono/cookie";
import { createMiddleware } from "@hono/hono/factory";
import type { ApiClient } from "./api/client.ts";
import type { ConsoleConfig } from "./config.ts";
import { type Session, SESSION_COOKIE, SessionStore } from "./session/store.ts";
import { registerSessionRoutes } from "./routes/session.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerStaticRoutes, type UiAssets } from "./routes/static.ts";

export interface ConsoleDeps {
  config: ConsoleConfig;
  api: ApiClient;
  sessions: SessionStore;
  ui: UiAssets;
}

export type ConsoleEnv = {
  Variables: {
    deps: ConsoleDeps;
    /** `/console/api/*` でのみ set される (requireSession 通過後)。 */
    session: Session;
  };
};

/**
 * CSRF 対策の第二防衛線。cookie が SameSite=Strict なので cross-site から
 * cookie 付きリクエストは飛ばないが、それだけに依存しない。
 *
 * カスタムヘッダは cross-origin では preflight を強制する。console は CORS
 * ヘッダを一切返さないので preflight は必ず失敗し、他 origin の JS からは
 * このヘッダを付けたリクエストが送れない。
 */
const CSRF_HEADER = "X-Mikura-Console";

const requireCsrfHeader = createMiddleware<ConsoleEnv>(async (c, next) => {
  if (c.req.header(CSRF_HEADER) !== "1") {
    return c.json({ message: `Missing ${CSRF_HEADER} header` }, 403);
  }
  await next();
});

const requireSession = createMiddleware<ConsoleEnv>(async (c, next) => {
  const { sessions } = c.get("deps");
  const session = sessions.get(getCookie(c, SESSION_COOKIE));
  if (!session) return c.json({ message: "Not authenticated" }, 401);
  c.set("session", session);
  await next();
});

export function createConsoleApp(deps: ConsoleDeps): Hono<ConsoleEnv> {
  const app = new Hono<ConsoleEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.onError((err, c) => {
    console.error("[console] unhandled error:", err);
    return c.json({ message: "Internal error" }, 500);
  });

  // UI 配信 (認証不要 — 中身は空のシェルだけで、データは API 経由でしか出ない)
  registerStaticRoutes(app);

  // session endpoint。CSRF ガードは掛けるが session 自体はまだ無い。
  app.use("/auth/session", requireCsrfHeader);
  registerSessionRoutes(app);

  // API 中継。ここから先は session 必須。
  app.use("/console/api/*", requireCsrfHeader);
  app.use("/console/api/*", requireSession);
  registerAdminRoutes(app);

  return app;
}
