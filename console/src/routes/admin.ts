/**
 * browser → API サーバの中継ハンドラ。
 *
 * **ここが console の権限境界そのもの。** `/console/api/*` を素通しプロキシに
 * すると、session を取った相手が admin token の権限で `/content/*` や
 * `/files/*` にも到達できてしまう — つまり管理 UI がファイル流出経路になる。
 *
 * そうならないよう、必要な endpoint だけを 1 本ずつ明示的に宣言する。
 * ADR-033 の規律: **console が叩けるのは `/admin/*` と `GET /tree` のみ。**
 * 中継先のパスはこのファイル内のリテラルからしか組み立てず、リクエスト由来の
 * 文字列をパスに流し込む前に必ず形式を検証する。
 */

import type { Context, Hono } from "hono";
import type { ConsoleEnv } from "../app.ts";
import type { ApiResponse } from "../api/client.ts";

/** SHA-256 hex。token hash をパスに載せる前の検証に使う。 */
const HASH_RE = /^[a-f0-9]{64}$/;

/** ロール名 (ADR-035)。上流のパスに載るので console 側でも形を固定する。 */
const ROLE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** 逆方向診断の level。上流の query に載せる前に列挙で閉じる。 */
const ACCESS_LEVELS: ReadonlySet<string> = new Set([
  "visible",
  "read",
  "write",
  "admin",
]);

/** 中継結果をそのまま HTTP 応答に落とす。 */
function relay<T>(c: Context<ConsoleEnv>, res: ApiResponse<T>): Response {
  if (res.body !== undefined) {
    return c.json(res.body as Record<string, unknown>, res.status as 200);
  }
  return c.json({ message: res.message ?? "" }, res.status as 200);
}

/** 整数のパスパラメータを取り出す。中継先のパスに載せる前の検証。 */
function intParam(c: Context<ConsoleEnv>, name: string): number | null {
  const raw = c.req.param(name as never) as string | undefined;
  if (raw === undefined) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 省略可能な `userId` query を、中継先の query string に組み直す。
 *
 * リクエストの query をそのまま連結しない: `?userId=1&path=/etc` のような
 * 余計なパラメータを上流に持ち込ませないため、値を取り出して再構築する。
 */
function userIdQuery(c: Context<ConsoleEnv>): string | null {
  const raw = c.req.query("userId");
  if (raw === undefined || raw === "") return "";
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return `?userId=${n}`;
}

export function registerAdminRoutes(app: Hono<ConsoleEnv>) {
  // ---- Users ----

  app.get("/console/api/users", async (c) => {
    const { api } = c.get("deps");
    return relay(c, await api.get(c.get("session").token, "/admin/users"));
  });

  app.post("/console/api/users", async (c) => {
    const { api } = c.get("deps");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    return relay(
      c,
      await api.post(c.get("session").token, "/admin/users", body),
    );
  });

  app.get("/console/api/users/:id", async (c) => {
    const { api } = c.get("deps");
    const id = intParam(c, "id");
    if (id === null) return c.json({ message: "Invalid id" }, 400);
    return relay(
      c,
      await api.get(c.get("session").token, `/admin/users/${id}`),
    );
  });

  app.delete("/console/api/users/:id", async (c) => {
    const { api } = c.get("deps");
    const id = intParam(c, "id");
    if (id === null) return c.json({ message: "Invalid id" }, 400);
    return relay(
      c,
      await api.delete(c.get("session").token, `/admin/users/${id}`),
    );
  });

  // ---- Policy document (ADR-035) ----

  /**
   * ポリシーは 1 本のテキスト文書として読み書きする。ルール行ごとの
   * endpoint は作らない — 「誰が何にアクセスできるか」を 1 つの成果物として
   * 読める / diff できることが設計の目的で、行 API を生やすと旧 permission
   * 行の山に戻る。
   */
  app.get("/console/api/policy", async (c) => {
    const { api } = c.get("deps");
    return relay(c, await api.get(c.get("session").token, "/admin/policy"));
  });

  app.put("/console/api/policy", async (c) => {
    const { api } = c.get("deps");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    return relay(
      c,
      await api.put(c.get("session").token, "/admin/policy", body),
    );
  });

  app.get("/console/api/policy/versions", async (c) => {
    const { api } = c.get("deps");
    return relay(
      c,
      await api.get(c.get("session").token, "/admin/policy/versions"),
    );
  });

  app.get("/console/api/policy/versions/:version", async (c) => {
    const { api } = c.get("deps");
    const version = intParam(c, "version");
    if (version === null) return c.json({ message: "Invalid version" }, 400);
    return relay(
      c,
      await api.get(
        c.get("session").token,
        `/admin/policy/versions/${version}`,
      ),
    );
  });

  // ---- Assignments (user × role) ----

  app.get("/console/api/assignments", async (c) => {
    const { api } = c.get("deps");
    const q = userIdQuery(c);
    if (q === null) return c.json({ message: "Invalid userId" }, 400);
    return relay(
      c,
      await api.get(c.get("session").token, `/admin/assignments${q}`),
    );
  });

  app.post("/console/api/assignments", async (c) => {
    const { api } = c.get("deps");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    return relay(
      c,
      await api.post(c.get("session").token, "/admin/assignments", body),
    );
  });

  app.delete("/console/api/assignments/:userId/:role", async (c) => {
    const { api } = c.get("deps");
    const userId = intParam(c, "userId");
    if (userId === null) return c.json({ message: "Invalid userId" }, 400);
    const role = c.req.param("role" as never) as string | undefined;
    // ロール名は上流のパスに載るので、ここで形式を固定する。
    if (role === undefined || !ROLE_NAME_RE.test(role)) {
      return c.json({ message: "Invalid role" }, 400);
    }
    return relay(
      c,
      await api.delete(
        c.get("session").token,
        `/admin/assignments/${userId}/${encodeURIComponent(role)}`,
      ),
    );
  });

  // ---- Assertions (割り当て層の契約) ----

  app.get("/console/api/assertions", async (c) => {
    const { api } = c.get("deps");
    return relay(c, await api.get(c.get("session").token, "/admin/assertions"));
  });

  app.post("/console/api/assertions", async (c) => {
    const { api } = c.get("deps");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    return relay(
      c,
      await api.post(c.get("session").token, "/admin/assertions", body),
    );
  });

  app.delete("/console/api/assertions/:id", async (c) => {
    const { api } = c.get("deps");
    const id = intParam(c, "id");
    if (id === null) return c.json({ message: "Invalid id" }, 400);
    return relay(
      c,
      await api.delete(c.get("session").token, `/admin/assertions/${id}`),
    );
  });

  // ---- Diagnostics ----

  /** 前方診断: 「このユーザーはこのパスに何ができるか」。 */
  app.get("/console/api/diagnostics/effective", async (c) => {
    const { api } = c.get("deps");
    const userIdRaw = c.req.query("userId");
    const userId = parseInt(userIdRaw ?? "", 10);
    if (!Number.isFinite(userId)) {
      return c.json({ message: "userId query required (number)" }, 400);
    }
    const path = c.req.query("path");
    if (path === undefined || path === "") {
      return c.json({ message: "path query required" }, 400);
    }
    return relay(
      c,
      await api.get(
        c.get("session").token,
        `/admin/diagnostics/effective?userId=${userId}&path=${
          encodeURIComponent(path)
        }`,
      ),
    );
  });

  /** 逆方向診断: 「このパスに届くのは誰か」。 */
  app.get("/console/api/diagnostics/who", async (c) => {
    const { api } = c.get("deps");
    const path = c.req.query("path");
    if (path === undefined || path === "") {
      return c.json({ message: "path query required" }, 400);
    }
    const level = c.req.query("level") ?? "read";
    if (!ACCESS_LEVELS.has(level)) {
      return c.json({ message: "Invalid level" }, 400);
    }
    return relay(
      c,
      await api.get(
        c.get("session").token,
        `/admin/diagnostics/who?path=${
          encodeURIComponent(path)
        }&level=${level}`,
      ),
    );
  });

  /**
   * ルールを書く時のパス選択用。`/admin/*` 以外で console が叩く唯一の
   * endpoint (ADR-033)。構造だけを返し、`/content/*` は決して中継しない。
   */
  app.get("/console/api/tree", async (c) => {
    const { api } = c.get("deps");
    return relay(c, await api.get(c.get("session").token, "/tree"));
  });

  // ---- Enrollments ----

  app.post("/console/api/enrollments", async (c) => {
    const { api } = c.get("deps");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    return relay(
      c,
      await api.post(c.get("session").token, "/admin/enrollments", body),
    );
  });

  app.get("/console/api/enrollments", async (c) => {
    const { api } = c.get("deps");
    const q = userIdQuery(c);
    if (q === null) return c.json({ message: "Invalid userId" }, 400);
    return relay(
      c,
      await api.get(c.get("session").token, `/admin/enrollments${q}`),
    );
  });

  // ---- Tokens ----

  app.get("/console/api/tokens", async (c) => {
    const { api } = c.get("deps");
    const q = userIdQuery(c);
    if (q === null) return c.json({ message: "Invalid userId" }, 400);
    return relay(c, await api.get(c.get("session").token, `/admin/tokens${q}`));
  });

  app.delete("/console/api/tokens/:hash", async (c) => {
    const { api } = c.get("deps");
    const hash = c.req.param("hash");
    if (!HASH_RE.test(hash)) {
      return c.json({ message: "tokenHash must be 64-char hex" }, 400);
    }
    return relay(
      c,
      await api.delete(c.get("session").token, `/admin/tokens/${hash}`),
    );
  });

  // ---- Devices ----

  app.get("/console/api/devices", async (c) => {
    const { api } = c.get("deps");
    const q = userIdQuery(c);
    if (q === null) return c.json({ message: "Invalid userId" }, 400);
    return relay(
      c,
      await api.get(c.get("session").token, `/admin/devices${q}`),
    );
  });

  // ---- Audit ----

  app.get("/console/api/audit", async (c) => {
    const { api } = c.get("deps");
    const raw = c.req.query("limit");
    let suffix = "";
    if (raw !== undefined && raw !== "") {
      const limit = parseInt(raw, 10);
      if (!Number.isFinite(limit)) {
        return c.json({ message: "limit must be a number" }, 400);
      }
      suffix = `?limit=${limit}`;
    }
    return relay(
      c,
      await api.get(c.get("session").token, `/admin/audit${suffix}`),
    );
  });
}
