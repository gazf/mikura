/**
 * console の**権限境界**の責務 (ADR-033):
 *   - session が無ければ `/console/api/*` は一切通らない
 *   - CSRF ヘッダが無ければ通らない
 *   - 中継されるのは `/admin/*` と `GET /tree` のみ。`/content/*` `/files/*`
 *     `/volume` `/locks/*` には決して到達しない
 *   - パス / query に流し込む値は形式検証を通ってから組み立てられる
 *
 * ここが崩れると「管理 UI がファイル流出経路になる」ので、素通しプロキシに
 * 退化していないことを構造として押さえる。
 */

import { assert, assertEquals } from "@std/assert";
import { makeHarness, req } from "./_helpers.ts";

// ---- 認証・CSRF ゲート ----

Deno.test("session が無ければ /console/api/* は 401 (upstream に届かない)", async () => {
  const h = makeHarness();
  const res = await h.app.fetch(req("GET", "/console/api/users"));
  assertEquals(res.status, 401);
  assertEquals(h.api.calls.length, 0);
});

Deno.test("CSRF ヘッダが無ければ /console/api/* は 403 (upstream に届かない)", async () => {
  const h = makeHarness();
  const res = await h.app.fetch(
    req("GET", "/console/api/users", { cookie: h.cookie, csrf: false }),
  );
  assertEquals(res.status, 403);
  assertEquals(h.api.calls.length, 0);
});

Deno.test("CSRF ヘッダが無ければ login も 403", async () => {
  const h = makeHarness();
  const res = await h.app.fetch(
    req("POST", "/auth/session", { csrf: false, body: { token: "x" } }),
  );
  assertEquals(res.status, 403);
  assertEquals(h.api.calls.length, 0);
});

// ---- 中継先の閉じ込め ----

Deno.test("ファイル内容系のパスは中継されない (route が存在しない)", async () => {
  const h = makeHarness();
  const forbidden = [
    "/console/api/content/secret.txt",
    "/console/api/files/",
    "/console/api/volume",
    "/console/api/locks/foo.txt",
    "/console/api/events",
    // 二重 admin。素通しプロキシなら通ってしまう形
    "/console/api/admin/users",
  ];
  for (const path of forbidden) {
    const res = await h.app.fetch(req("GET", path, { cookie: h.cookie }));
    assertEquals(res.status, 404, `${path} が 404 になっていない`);
  }
  assertEquals(h.api.calls.length, 0);
});

Deno.test("中継先は /admin/* と GET /tree に限られる", async () => {
  const h = makeHarness();
  const calls: Array<[string, string]> = [
    ["GET", "/console/api/users"],
    ["GET", "/console/api/users/2"],
    ["GET", "/console/api/policy"],
    ["GET", "/console/api/roles"],
    ["GET", "/console/api/roles/viewers"],
    ["GET", "/console/api/roles/viewers/generations"],
    ["GET", "/console/api/assignments"],
    ["GET", "/console/api/assertions"],
    ["GET", "/console/api/diagnostics/effective?userId=1&path=/a"],
    ["GET", "/console/api/diagnostics/who?path=/a"],
    ["GET", "/console/api/tree"],
    ["GET", "/console/api/enrollments"],
    ["GET", "/console/api/tokens"],
    ["GET", "/console/api/devices"],
    ["GET", "/console/api/audit"],
  ];
  for (const [method, path] of calls) {
    await h.app.fetch(req(method, path, { cookie: h.cookie }));
  }
  for (const upstream of h.api.paths) {
    assert(
      upstream.startsWith("/admin/") || upstream === "/tree",
      `想定外の upstream path: ${upstream}`,
    );
  }
});

Deno.test("session の token が upstream に渡る (browser には返さない)", async () => {
  const h = makeHarness();
  await h.app.fetch(req("GET", "/console/api/users", { cookie: h.cookie }));
  assertEquals(h.api.lastCall?.token, h.adminToken);

  // 応答本文に token が混ざっていないこと
  const res = await h.app.fetch(
    req("GET", "/console/api/users", { cookie: h.cookie }),
  );
  const text = await res.text();
  assert(!text.includes(h.adminToken), "応答に admin token が漏れている");
});

// ---- パス・query の組み立て ----

Deno.test("数値でない id はパスに載る前に 400 (upstream に届かない)", async () => {
  const h = makeHarness();
  const bad = [
    ["GET", "/console/api/users/abc"],
    ["DELETE", "/console/api/users/abc"],
    ["DELETE", "/console/api/assertions/abc"],
    ["DELETE", "/console/api/assignments/xyz/viewers"],
  ];
  for (const [method, path] of bad) {
    const res = await h.app.fetch(req(method, path, { cookie: h.cookie }));
    assertEquals(res.status, 400, `${method} ${path} が 400 になっていない`);
  }
  assertEquals(h.api.calls.length, 0);
});

Deno.test("tokenHash は 64-char hex のみパスに載せる", async () => {
  const h = makeHarness();
  for (const bad of ["short", "../../admin/users", "Z".repeat(64)]) {
    const res = await h.app.fetch(
      req("DELETE", `/console/api/tokens/${encodeURIComponent(bad)}`, {
        cookie: h.cookie,
      }),
    );
    assertEquals(res.status, 400, `${bad} が 400 になっていない`);
  }
  assertEquals(h.api.calls.length, 0);

  const good = "a".repeat(64);
  await h.app.fetch(
    req("DELETE", `/console/api/tokens/${good}`, { cookie: h.cookie }),
  );
  assertEquals(h.api.lastCall?.path, `/admin/tokens/${good}`);
});

Deno.test("query は再構築される (余計なパラメータを上流に持ち込まない)", async () => {
  const h = makeHarness();
  await h.app.fetch(
    req("GET", "/console/api/tokens?userId=7&path=/etc&limit=999", {
      cookie: h.cookie,
    }),
  );
  assertEquals(h.api.lastCall?.path, "/admin/tokens?userId=7");
});

Deno.test("診断の path は percent-encode されて query 境界を壊さない", async () => {
  const h = makeHarness();
  await h.app.fetch(
    req("GET", "/console/api/diagnostics/who?path=/a%20b%26level%3Dadmin", {
      cookie: h.cookie,
    }),
  );
  const upstream = h.api.lastCall?.path ?? "";
  const params = new URL(`http://x${upstream}`).searchParams;
  assertEquals(params.get("path"), "/a b&level=admin");
  // 生の & が漏れていれば level を admin に差し替えられてしまう
  assertEquals(params.get("level"), "read");
});

Deno.test("ロール名は形式を固定してからパスに載せる", async () => {
  const h = makeHarness();
  const paths = (bad: string) =>
    [
      ["DELETE", `/console/api/assignments/1/${encodeURIComponent(bad)}`],
      ["GET", `/console/api/roles/${encodeURIComponent(bad)}`],
      ["DELETE", `/console/api/roles/${encodeURIComponent(bad)}`],
    ] as const;
  for (const bad of ["../../admin/users", "-leading", "with space"]) {
    for (const [method, path] of paths(bad)) {
      const res = await h.app.fetch(req(method, path, { cookie: h.cookie }));
      assertEquals(res.status, 400, `${method} ${path} が 400 になっていない`);
    }
  }
  assertEquals(h.api.calls.length, 0);

  await h.app.fetch(
    req("DELETE", "/console/api/assignments/1/projects-editor", {
      cookie: h.cookie,
    }),
  );
  assertEquals(h.api.lastCall?.path, "/admin/assignments/1/projects-editor");

  await h.app.fetch(
    req("GET", "/console/api/roles/projects-editor", { cookie: h.cookie }),
  );
  assertEquals(h.api.lastCall?.path, "/admin/roles/projects-editor");
});

Deno.test("診断の level は列挙で閉じる (任意の文字列を上流に流さない)", async () => {
  const h = makeHarness();
  const res = await h.app.fetch(
    req("GET", "/console/api/diagnostics/who?path=/a&level=superuser", {
      cookie: h.cookie,
    }),
  );
  assertEquals(res.status, 400);
  assertEquals(h.api.calls.length, 0);
});

Deno.test("数値でない userId query は 400 (全件に倒さない)", async () => {
  const h = makeHarness();
  for (
    const path of [
      "/console/api/tokens?userId=abc",
      "/console/api/devices?userId=abc",
      "/console/api/enrollments?userId=abc",
    ]
  ) {
    const res = await h.app.fetch(req("GET", path, { cookie: h.cookie }));
    assertEquals(res.status, 400, `${path} が 400 になっていない`);
  }
  assertEquals(h.api.calls.length, 0);
});

Deno.test("userId 省略時は query 無しで中継される", async () => {
  const h = makeHarness();
  await h.app.fetch(req("GET", "/console/api/devices", { cookie: h.cookie }));
  assertEquals(h.api.lastCall?.path, "/admin/devices");
});

// ---- 静的配信 ----

Deno.test("UI シェルは認証なしで配信される (データは含まない)", async () => {
  const h = makeHarness();
  const res = await h.app.fetch(new Request("http://console.test/console/"));
  assertEquals(res.status, 200);
  assertEquals(h.api.calls.length, 0);
});

Deno.test("/ と /console は /console/ にリダイレクト", async () => {
  const h = makeHarness();
  for (const path of ["/", "/console"]) {
    const res = await h.app.fetch(new Request(`http://console.test${path}`));
    assertEquals(res.status, 302);
    assertEquals(res.headers.get("location"), "/console/");
  }
});
