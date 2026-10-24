/**
 * session の責務:
 *   - login の可否判定を console 側で持たず、`GET /admin/whoami` の結果に従う
 *     (認可の SSOT は API サーバの requireAdmin 1 箇所 — ADR-033)
 *   - admin token は session の中だけに存在し、cookie にも応答本文にも出ない
 *   - idle / 絶対寿命で失効する
 */

import { assert, assertEquals } from "@std/assert";
import { SESSION_COOKIE, SessionStore } from "../src/session/store.ts";
import { makeHarness, req } from "./_helpers.ts";

const TOKEN = "paste-me-admin-token";

Deno.test("login: whoami が 200 なら session を張り cookie を返す", async () => {
  const h = makeHarness();
  h.api.stub("GET", "/admin/whoami", {
    status: 200,
    body: { id: 4, name: "operator", deviceId: "mikura-console" },
  });

  const res = await h.app.fetch(
    req("POST", "/auth/session", { body: { token: TOKEN } }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { userId: 4, userName: "operator" });

  const cookie = res.headers.get("set-cookie") ?? "";
  assert(cookie.includes(SESSION_COOKIE));
  assert(cookie.includes("HttpOnly"), "HttpOnly が付いていない");
  assert(cookie.includes("SameSite=Strict"), "SameSite=Strict が付いていない");
  // token そのものが cookie に載っていないこと
  assert(!cookie.includes(TOKEN), "cookie に admin token が載っている");
});

Deno.test("login: whoami が 401 ならログインさせない", async () => {
  const h = makeHarness();
  h.api.stub("GET", "/admin/whoami", { status: 401, message: "Invalid" });
  const res = await h.app.fetch(
    req("POST", "/auth/session", { body: { token: TOKEN } }),
  );
  assertEquals(res.status, 401);
  assertEquals(res.headers.get("set-cookie"), null);
});

Deno.test("login: whoami が 403 (admin でない) ならログインさせない", async () => {
  const h = makeHarness();
  h.api.stub("GET", "/admin/whoami", { status: 403, message: "Forbidden" });
  const res = await h.app.fetch(
    req("POST", "/auth/session", { body: { token: TOKEN } }),
  );
  assertEquals(res.status, 403);
  assertEquals(res.headers.get("set-cookie"), null);
});

Deno.test("login: API サーバに繋がらなければ 502 (console 自体は落ちない)", async () => {
  const h = makeHarness();
  h.api.stub("GET", "/admin/whoami", {
    status: 502,
    message: "API server unreachable",
  });
  const res = await h.app.fetch(
    req("POST", "/auth/session", { body: { token: TOKEN } }),
  );
  assertEquals(res.status, 502);
});

Deno.test("login: token が空なら upstream を叩かない", async () => {
  const h = makeHarness();
  for (const body of [{}, { token: "" }, { token: "   " }]) {
    const res = await h.app.fetch(req("POST", "/auth/session", { body }));
    assertEquals(res.status, 400);
  }
  assertEquals(h.api.calls.length, 0);
});

Deno.test("whoami: 未ログインは 401 / ログイン済みは userName を返す", async () => {
  const h = makeHarness();
  const anon = await h.app.fetch(req("GET", "/auth/session"));
  assertEquals(anon.status, 401);

  const known = await h.app.fetch(
    req("GET", "/auth/session", { cookie: h.cookie }),
  );
  assertEquals(known.status, 200);
  assertEquals(await known.json(), { userId: 1, userName: "admin" });
});

Deno.test("logout: session が破棄され cookie も落ちる", async () => {
  const h = makeHarness();
  assertEquals(h.sessions.size, 1);

  const res = await h.app.fetch(
    req("DELETE", "/auth/session", { cookie: h.cookie }),
  );
  assertEquals(res.status, 200);
  assertEquals(h.sessions.size, 0);
  assert((res.headers.get("set-cookie") ?? "").includes("Max-Age=0"));

  // 同じ cookie では通らなくなる
  const after = await h.app.fetch(
    req("GET", "/console/api/users", { cookie: h.cookie }),
  );
  assertEquals(after.status, 401);
});

// ---- SessionStore 単体 ----

Deno.test("SessionStore: idle timeout で失効する", () => {
  let now = 1_000_000;
  const store = new SessionStore({
    idleMs: 1000,
    absoluteMs: 100_000,
    now: () => now,
  });
  const id = store.create("t", 1, "admin");

  now += 900;
  assert(store.get(id), "idle 内なのに失効している");

  // get() が lastSeenAt を更新するので、そこから再度 idle を測る
  now += 900;
  assert(store.get(id), "アクセスのたびに idle は延びるはず");

  now += 1100;
  assertEquals(store.get(id), undefined);
});

Deno.test("SessionStore: 絶対寿命は操作中でも延びない", () => {
  let now = 1_000_000;
  const store = new SessionStore({
    idleMs: 10_000,
    absoluteMs: 5_000,
    now: () => now,
  });
  const id = store.create("t", 1, "admin");

  for (let i = 0; i < 4; i++) {
    now += 1000;
    assert(store.get(id), `${i} 回目で失効している`);
  }
  now += 2000; // 合計 6000 > absoluteMs
  assertEquals(store.get(id), undefined);
});

Deno.test("SessionStore: 失効した session は sweep で回収される", () => {
  let now = 0;
  const store = new SessionStore({
    idleMs: 100,
    absoluteMs: 1000,
    now: () => now,
  });
  store.create("t", 1, "a");
  store.create("t", 2, "b");
  assertEquals(store.size, 2);

  now += 500;
  store.get("nonexistent"); // sweep のトリガ
  assertEquals(store.size, 0);
});

Deno.test("SessionStore: 未知 / undefined の id は undefined", () => {
  const store = new SessionStore({ idleMs: 1000, absoluteMs: 1000 });
  assertEquals(store.get(undefined), undefined);
  assertEquals(store.get("nope"), undefined);
});

Deno.test("SessionStore: id は毎回異なる", () => {
  const store = new SessionStore({ idleMs: 1000, absoluteMs: 1000 });
  const ids = new Set(
    Array.from({ length: 50 }, () => store.create("t", 1, "a")),
  );
  assertEquals(ids.size, 50);
});
