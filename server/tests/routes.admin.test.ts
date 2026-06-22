/**
 * /admin/* ルーティングの責務 (end-to-end):
 *   - 全 endpoint で root に admin permission を持つ user のみ通る (= 403 fallback)
 *   - User / Group / UserGroup / Permission / Enrollment / Token の CRUD が KV state を正しく更新
 *   - cascade delete (user, group) が関連 entry を巻き取る
 *   - revoke-token, list-tokens 系は metadata のみ返し raw を漏らさない
 */

import { assert, assertEquals } from "@std/assert";
import app from "../src/app.ts";
import { createAppToken, hashToken } from "../src/services/auth.service.ts";
import { Keys } from "../src/kv/keys.ts";
import type { Group, Permission, TokenData, User } from "../src/types.ts";
import { seedUser, withTestKv } from "./_helpers.ts";

const ADMIN_DEVICE = "dev-admin-0000000000000001";
const NON_ADMIN_DEVICE = "dev-user-00000000000000001";

function req(
  method: string,
  path: string,
  token: string,
  deviceId: string,
  body?: unknown,
): Request {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Device-Id": deviceId,
    },
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

interface Ctx {
  adminToken: string;
  nonAdminToken: string;
}

async function setup(kv: Deno.Kv): Promise<Ctx> {
  await seedUser(kv, {
    userId: 1,
    userName: "admin",
    groupId: 1,
    groupName: "admins",
    permissions: [{ path: "/", accessLevel: "admin" }],
  });
  await seedUser(kv, {
    userId: 2,
    userName: "carol",
    groupId: 2,
    groupName: "users",
    permissions: [{ path: "/", accessLevel: "write" }],
  });
  const a = await createAppToken(1, "admin-test");
  const b = await createAppToken(2, "carol-test");
  return { adminToken: a.raw, nonAdminToken: b.raw };
}

// ---- Auth gate ----

Deno.test("/admin/users: 非 admin は 403", async () => {
  await withTestKv(async (kv) => {
    const { nonAdminToken } = await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/users", nonAdminToken, NON_ADMIN_DEVICE),
    );
    assertEquals(res.status, 403);
  });
});

// ---- Users ----

Deno.test("POST /admin/users: 新規 user 作成 + name index 反映", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("POST", "/admin/users", adminToken, ADMIN_DEVICE, { name: "dave" }),
    );
    assertEquals(res.status, 201);
    const body = (await res.json()) as { id: number; name: string };
    assertEquals(body.name, "dave");
    assert(body.id > 0);

    // KV state
    const stored = await kv.get<User>(Keys.user(body.id));
    assertEquals(stored.value?.name, "dave");
    const byName = await kv.get<number>(Keys.userByName("dave"));
    assertEquals(byName.value, body.id);
  });
});

Deno.test("POST /admin/users: 既存 name は 409", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("POST", "/admin/users", adminToken, ADMIN_DEVICE, { name: "admin" }),
    );
    assertEquals(res.status, 409);
  });
});

Deno.test("GET /admin/users: 全 user を列挙", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/users", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    const list = (await res.json()) as Array<{ id: number; name: string }>;
    assertEquals(list.length, 2);
    assert(list.some((u) => u.name === "admin"));
    assert(list.some((u) => u.name === "carol"));
  });
});

Deno.test("DELETE /admin/users/:id: cascade で tokens / user_groups を削除", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("DELETE", "/admin/users/2", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);

    // user / userByName 消滅
    assertEquals((await kv.get<User>(Keys.user(2))).value, null);
    assertEquals((await kv.get<number>(Keys.userByName("carol"))).value, null);
    // user_groups 消滅
    let groupCount = 0;
    for await (
      const _ of kv.list<true>({ prefix: Keys.userGroupsPrefix(2) })
    ) {
      groupCount++;
    }
    assertEquals(groupCount, 0);
    // tokens (forward index) も消滅
    let tokenCount = 0;
    for await (
      const _ of kv.list<true>({ prefix: Keys.tokensByUserPrefix(2) })
    ) {
      tokenCount++;
    }
    assertEquals(tokenCount, 0);
  });
});

Deno.test("DELETE /admin/users/:id: 自分自身は削除不可 (400)", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("DELETE", "/admin/users/1", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 400);
  });
});

// ---- Groups & User-Groups ----

Deno.test("POST /admin/groups + user-groups: group 作成 + メンバー追加", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const gRes = await app.fetch(
      req("POST", "/admin/groups", adminToken, ADMIN_DEVICE, {
        name: "devs",
      }),
    );
    assertEquals(gRes.status, 201);
    const group = (await gRes.json()) as Group;

    const ugRes = await app.fetch(
      req("POST", "/admin/user-groups", adminToken, ADMIN_DEVICE, {
        userId: 2,
        groupId: group.id,
      }),
    );
    assertEquals(ugRes.status, 201);

    const ug = await kv.get<true>(Keys.userGroup(2, group.id));
    assertEquals(ug.value, true);
  });
});

// ---- Permissions ----

Deno.test("PUT /admin/permissions: 設定 + KV 反映", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("PUT", "/admin/permissions", adminToken, ADMIN_DEVICE, {
        path: "/shared",
        groupId: 2,
        accessLevel: "read",
      }),
    );
    assertEquals(res.status, 200);
    const stored = await kv.get<Permission>(Keys.permission("/shared", 2));
    assertEquals(stored.value?.accessLevel, "read");
  });
});

Deno.test("PUT /admin/permissions: path traversal は 400", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("PUT", "/admin/permissions", adminToken, ADMIN_DEVICE, {
        path: "/foo/../bar",
        groupId: 2,
        accessLevel: "read",
      }),
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("DELETE /admin/permissions: 削除", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    await kv.set(Keys.permission("/foo", 2), { accessLevel: "read" });
    const url = "/admin/permissions?path=" + encodeURIComponent("/foo") +
      "&groupId=2";
    const res = await app.fetch(req("DELETE", url, adminToken, ADMIN_DEVICE));
    assertEquals(res.status, 200);
    assertEquals((await kv.get(Keys.permission("/foo", 2))).value, null);
  });
});

// ---- Enrollments ----

Deno.test("POST /admin/enrollments: secret + expiresAt 返却", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("POST", "/admin/enrollments", adminToken, ADMIN_DEVICE, {
        userId: 2,
      }),
    );
    assertEquals(res.status, 201);
    const body = (await res.json()) as {
      secret: string;
      secretHash: string;
      expiresAt: string;
    };
    assert(body.secret.length > 0);
    assertEquals(body.secretHash.length, 64);
    // 7 日 default
    const expMs = Date.parse(body.expiresAt);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    assert(Math.abs(expMs - (Date.now() + sevenDays)) < 5000);
    // KV にも entry が立ってる
    const fwd = await kv.get(Keys.enrollmentByUser(2, body.secretHash));
    assertEquals(fwd.value, true);
  });
});

Deno.test("POST /admin/enrollments: ttlDays 範囲外は 400", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("POST", "/admin/enrollments", adminToken, ADMIN_DEVICE, {
        userId: 2,
        ttlDays: 0,
      }),
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("GET /admin/enrollments: list", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    // 2 件発行
    for (let i = 0; i < 2; i++) {
      const r = await app.fetch(
        req("POST", "/admin/enrollments", adminToken, ADMIN_DEVICE, {
          userId: 2,
        }),
      );
      await r.body?.cancel();
    }
    const res = await app.fetch(
      req("GET", "/admin/enrollments?userId=2", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    const list = (await res.json()) as Array<{ secretHash: string }>;
    assertEquals(list.length, 2);
  });
});

// ---- Tokens ----

Deno.test("GET /admin/tokens: list (raw を返さない)", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/tokens?userId=2", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    const list = (await res.json()) as Array<TokenData & { tokenHash: string }>;
    assertEquals(list.length, 1); // setup の carol-test
    assertEquals(list[0].userId, 2);
    assertEquals(list[0].tokenHash.length, 64);
    // raw token は無いことを check
    assert(!("rawToken" in list[0]));
  });
});

Deno.test("DELETE /admin/tokens/:hash: revoke", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const { raw, hash } = await createAppToken(2, "revoke-target");
    // 存在確認
    assertEquals(await hashToken(raw), hash);
    assert((await kv.get<TokenData>(Keys.token(hash))).value);

    const res = await app.fetch(
      req("DELETE", `/admin/tokens/${hash}`, adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as { revoked: boolean };
    assertEquals(body.revoked, true);
    // KV からも消滅
    assertEquals((await kv.get<TokenData>(Keys.token(hash))).value, null);
  });
});

Deno.test("DELETE /admin/tokens/:hash: 64-char 以外は 400", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("DELETE", "/admin/tokens/short", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 400);
  });
});
