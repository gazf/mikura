/**
 * /admin/* ルーティングの責務 (end-to-end):
 *   - 全 endpoint で root に admin permission を持つ user のみ通る (= 403 fallback)
 *   - User / Group / UserGroup / Permission / Enrollment / Token の CRUD が KV state を正しく更新
 *   - cascade delete (user, group) が関連 entry を巻き取る
 *   - revoke-token, list-tokens 系は metadata のみ返し raw を漏らさない
 */

import { assert, assertEquals } from "@std/assert";
import app from "../src/app.ts";
import {
  createAppToken,
  hashToken,
  upsertDevice,
} from "../src/services/auth.service.ts";
import { createEnrollmentSecret } from "../src/services/enrollment.service.ts";
import { logAudit } from "../src/services/audit.service.ts";
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

// ---- Console 向け読み出し系 (ADR-033) ----
//
// 以下は admin console がマトリクス / 一覧画面を組み立てるために追加した
// 読み出し専用 endpoint 群。責務は「絞り込みの有無で同じ endpoint が両方を
// 賄えること」と「絞り込み指定の typo が静かに全件へ倒れないこと」。

Deno.test("GET /admin/user-groups/:userId: 所属 group を name 付きで返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    // carol (id=2) を admins(1) にも所属させる
    await kv.set(Keys.userGroup(2, 1), true);

    const res = await app.fetch(
      req("GET", "/admin/user-groups/2", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as Array<
      { groupId: number; groupName: string | null }
    >;
    const byId = new Map(body.map((m) => [m.groupId, m.groupName]));
    assertEquals(byId.get(1), "admins");
    assertEquals(byId.get(2), "users");
  });
});

Deno.test("GET /admin/user-groups/:userId: group が消えていても membership は返す (name=null)", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    // membership だけ残して group 本体を消す (cascade 漏れ相当の状態)
    await kv.set(Keys.userGroup(2, 99), true);

    const res = await app.fetch(
      req("GET", "/admin/user-groups/2", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as Array<
      { groupId: number; groupName: string | null }
    >;
    const orphan = body.find((m) => m.groupId === 99);
    assert(orphan, "orphan membership が落ちている");
    assertEquals(orphan.groupName, null);
  });
});

Deno.test("GET /admin/permissions: path 省略で全件、指定で絞り込み", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    await kv.set(Keys.permission("/shared", 2), { accessLevel: "read" });

    const all = await app.fetch(
      req("GET", "/admin/permissions", adminToken, ADMIN_DEVICE),
    );
    assertEquals(all.status, 200);
    const allBody = (await all.json()) as Array<
      { path: string; groupId: number; accessLevel: string }
    >;
    // setup が張る "/" 2 件 + 追加の /shared 1 件
    assertEquals(allBody.length, 3);

    const scoped = await app.fetch(
      req("GET", "/admin/permissions?path=/shared", adminToken, ADMIN_DEVICE),
    );
    const scopedBody = (await scoped.json()) as Array<
      { path: string; groupId: number; accessLevel: string }
    >;
    assertEquals(scopedBody, [{
      path: "/shared",
      groupId: 2,
      accessLevel: "read",
    }]);
  });
});

Deno.test("GET /admin/permissions: 不正 path は 400 (全件へ倒さない)", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/permissions?path=../etc", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("GET /admin/enrollments: userId 省略で全 user 分", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    await createEnrollmentSecret(1, 1, 7);
    await createEnrollmentSecret(2, 1, 7);

    const all = await app.fetch(
      req("GET", "/admin/enrollments", adminToken, ADMIN_DEVICE),
    );
    assertEquals(all.status, 200);
    const allBody = (await all.json()) as Array<{ userId: number }>;
    assertEquals(allBody.length, 2);

    const scoped = await app.fetch(
      req("GET", "/admin/enrollments?userId=2", adminToken, ADMIN_DEVICE),
    );
    const scopedBody = (await scoped.json()) as Array<{ userId: number }>;
    assertEquals(scopedBody.length, 1);
    assertEquals(scopedBody[0].userId, 2);
  });
});

Deno.test("GET /admin/enrollments: userId が数値でなければ 400", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/enrollments?userId=abc", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("GET /admin/enrollments: raw secret は返さない", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const issued = await createEnrollmentSecret(2, 1, 7);

    const res = await app.fetch(
      req("GET", "/admin/enrollments", adminToken, ADMIN_DEVICE),
    );
    const text = await res.text();
    assert(
      !text.includes(issued.raw),
      "enrollment 一覧に raw secret が漏れている",
    );
    assert(text.includes(issued.secretHash));
  });
});

Deno.test("GET /admin/tokens: userId 省略で全 user 分", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    // setup が admin/carol 各 1 本作っている + carol にもう 1 本
    await createAppToken(2, "carol-second");

    const all = await app.fetch(
      req("GET", "/admin/tokens", adminToken, ADMIN_DEVICE),
    );
    assertEquals(all.status, 200);
    const allBody = (await all.json()) as Array<
      { userId: number; tokenHash: string }
    >;
    assertEquals(allBody.length, 3);
    // tokenHash が全件で埋まっていること (全件 scan 側の key 抽出の回帰防止)
    assert(allBody.every((t) => typeof t.tokenHash === "string"));

    const scoped = await app.fetch(
      req("GET", "/admin/tokens?userId=2", adminToken, ADMIN_DEVICE),
    );
    const scopedBody = (await scoped.json()) as Array<{ userId: number }>;
    assertEquals(scopedBody.length, 2);
    assert(scopedBody.every((t) => t.userId === 2));
  });
});

Deno.test("GET /admin/devices: userId 省略で全件、指定で絞り込み", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    await upsertDevice("dev-alpha-000000000000001", 1, "192.0.2.10");
    await upsertDevice("dev-beta-0000000000000001", 2, "192.0.2.11");

    const all = await app.fetch(
      req("GET", "/admin/devices", adminToken, ADMIN_DEVICE),
    );
    assertEquals(all.status, 200);
    const allBody = (await all.json()) as Array<
      { deviceId: string; userId: number }
    >;
    // seed した 2 台 + このリクエスト自身の device。authMiddleware の
    // upsertDevice が「今喋っている端末」も登録するので、admin console から
    // 一覧を見ると自分の端末が必ず 1 台混ざる。
    const ids = new Set(allBody.map((d) => d.deviceId));
    assertEquals(ids.size, 3);
    assert(ids.has("dev-alpha-000000000000001"));
    assert(ids.has("dev-beta-0000000000000001"));
    assert(ids.has(ADMIN_DEVICE));

    const scoped = await app.fetch(
      req("GET", "/admin/devices?userId=2", adminToken, ADMIN_DEVICE),
    );
    const scopedBody = (await scoped.json()) as Array<{ deviceId: string }>;
    assertEquals(scopedBody.length, 1);
    assertEquals(scopedBody[0].deviceId, "dev-beta-0000000000000001");
  });
});

Deno.test("GET /admin/audit: 新しい順 + limit で切る", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    // timestamp は ISO 文字列 key なので、同一 ms に潰れないよう順に書く
    await logAudit(1, "POST /a", "/a", "192.0.2.1");
    await new Promise((r) => setTimeout(r, 2));
    await logAudit(1, "POST /b", "/b", "192.0.2.1");
    await new Promise((r) => setTimeout(r, 2));
    await logAudit(1, "POST /c", "/c", "192.0.2.1");

    const res = await app.fetch(
      req("GET", "/admin/audit?limit=2", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as Array<
      { action: string; timestamp: string }
    >;
    assertEquals(body.length, 2);
    assertEquals(body[0].action, "POST /c");
    assertEquals(body[1].action, "POST /b");
    assert(typeof body[0].timestamp === "string");
  });
});

Deno.test("GET /admin/audit: limit が範囲外なら 400", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    for (const bad of ["0", "1001", "abc"]) {
      const res = await app.fetch(
        req("GET", `/admin/audit?limit=${bad}`, adminToken, ADMIN_DEVICE),
      );
      assertEquals(res.status, 400, `limit=${bad} が 400 になっていない`);
    }
  });
});

Deno.test("console 向け読み出し endpoint も非 admin は 403", async () => {
  await withTestKv(async (kv) => {
    const { nonAdminToken } = await setup(kv);
    const paths = [
      "/admin/user-groups/2",
      "/admin/permissions",
      "/admin/devices",
      "/admin/audit",
    ];
    for (const p of paths) {
      const res = await app.fetch(
        req("GET", p, nonAdminToken, NON_ADMIN_DEVICE),
      );
      assertEquals(res.status, 403, `${p} が 403 になっていない`);
    }
  });
});

// ---- enrollUrl (ADR-034) ----

Deno.test("POST /admin/enrollments: MIKURA_PUBLIC_URL があれば enrollUrl を返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const prev = Deno.env.get("MIKURA_PUBLIC_URL");
    Deno.env.set("MIKURA_PUBLIC_URL", "https://files.example.com:8700/");
    try {
      const res = await app.fetch(
        req("POST", "/admin/enrollments", adminToken, ADMIN_DEVICE, {
          userId: 2,
        }),
      );
      assertEquals(res.status, 201);
      const body = (await res.json()) as {
        secret: string;
        enrollUrl: string | null;
      };
      assert(body.enrollUrl, "enrollUrl が null");
      const url = new URL(body.enrollUrl);
      assertEquals(url.protocol, "mikura:");
      // 末尾 slash は落ちる
      assertEquals(
        url.searchParams.get("u"),
        "https://files.example.com:8700",
      );
      assertEquals(url.searchParams.get("s"), body.secret);
    } finally {
      if (prev === undefined) Deno.env.delete("MIKURA_PUBLIC_URL");
      else Deno.env.set("MIKURA_PUBLIC_URL", prev);
    }
  });
});

Deno.test("POST /admin/enrollments: MIKURA_PUBLIC_URL 未設定なら enrollUrl は null (推測しない)", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const prev = Deno.env.get("MIKURA_PUBLIC_URL");
    Deno.env.delete("MIKURA_PUBLIC_URL");
    try {
      const res = await app.fetch(
        req("POST", "/admin/enrollments", adminToken, ADMIN_DEVICE, {
          userId: 2,
        }),
      );
      assertEquals(res.status, 201);
      const body = (await res.json()) as {
        secret: string;
        enrollUrl: string | null;
      };
      assertEquals(body.enrollUrl, null);
      // raw secret 自体は従来通り返る (CLI / init.json 経路の互換)
      assert(body.secret.length > 0);
    } finally {
      if (prev !== undefined) Deno.env.set("MIKURA_PUBLIC_URL", prev);
    }
  });
});

// ---- whoami (console login の入口) ----

Deno.test("GET /admin/whoami: 呼び出し元の identity を返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/whoami", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      id: 1,
      name: "admin",
      deviceId: ADMIN_DEVICE,
    });
  });
});

Deno.test("GET /admin/whoami: admin でなければ 403 (console はここで弾く)", async () => {
  await withTestKv(async (kv) => {
    const { nonAdminToken } = await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/whoami", nonAdminToken, NON_ADMIN_DEVICE),
    );
    assertEquals(res.status, 403);
  });
});

Deno.test("GET /admin/whoami: 無効な token は 401", async () => {
  await withTestKv(async (kv) => {
    await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/whoami", "not-a-real-token", ADMIN_DEVICE),
    );
    assertEquals(res.status, 401);
  });
});
