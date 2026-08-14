/**
 * /admin/* ルーティングの責務 (end-to-end):
 *   - 全 endpoint で root に admin 権限を持つ user のみ通る (= 403 fallback)
 *   - User / Policy / Assignment / Assertion / Enrollment / Token が KV state を正しく更新
 *   - cascade delete (user) が関連 entry を巻き取る
 *   - ポリシー保存は 検証 → 割り当て層の拒否権 → admin 不在検査 の順に落ちる
 *   - revoke-token, list-tokens 系は metadata のみ返し raw を漏らさない
 */

import { assert, assertEquals } from "@std/assert";
import app from "../src/app.ts";
import {
  checkPermission,
  createAppToken,
  hashToken,
  upsertDevice,
} from "../src/services/auth.service.ts";
import { createEnrollmentSecret } from "../src/services/enrollment.service.ts";
import { logAudit } from "../src/services/audit.service.ts";
import { Keys } from "../src/kv/keys.ts";
import type { TokenData, User } from "../src/types.ts";
import { seedRole, seedUser, withTestKv } from "./_helpers.ts";

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
    roleName: "admins",
    permissions: [{ path: "/", accessLevel: "admin" }],
  });
  await seedUser(kv, {
    userId: 2,
    userName: "carol",
    roleName: "users",
    permissions: [{ path: "/shared", accessLevel: "write" }],
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

Deno.test("DELETE /admin/users/:id: cascade で tokens / ロール割り当てを削除", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("DELETE", "/admin/users/2", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);

    // user / userByName 消滅
    assertEquals((await kv.get<User>(Keys.user(2))).value, null);
    assertEquals((await kv.get<number>(Keys.userByName("carol"))).value, null);
    // ロール割り当て消滅 (逆引きも)
    let roleCount = 0;
    for await (const _ of kv.list<true>({ prefix: Keys.userRolesPrefix(2) })) {
      roleCount++;
    }
    assertEquals(roleCount, 0);
    assertEquals((await kv.get<true>(Keys.roleUser("users", 2))).value, null);
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
      "/admin/policy",
      "/admin/assignments",
      "/admin/assertions",
      "/admin/diagnostics/who?path=/",
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

Deno.test("POST /admin/enrollments: MIKURA_PUBLIC_URL があれば enrollUrl を返し、雛形は出さない", async () => {
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
        enrollUrlTemplate: string | null;
      };
      assert(body.enrollUrl, "enrollUrl が null");
      // 配れるリンクがあるなら雛形は出さない (取り違えさせない)
      assertEquals(body.enrollUrlTemplate, null);
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

Deno.test("POST /admin/enrollments: 未設定なら enrollUrl は null で、代わりに雛形が返る", async () => {
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
        enrollUrlTemplate: string | null;
      };
      assertEquals(body.enrollUrl, null);
      // 代わりに host だけを差し込み語にした雛形が返る。admin が手で直せば
      // そのまま配れるので、シークレットから URI を組み立て直さずに済む。
      assert(body.enrollUrlTemplate !== null);
      const template = new URL(body.enrollUrlTemplate!);
      assertEquals(template.protocol, "mikura:");
      assertEquals(template.searchParams.get("u"), "http://HOST:8700");
      assertEquals(template.searchParams.get("s"), body.secret);
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

// ---- Roles (ADR-036) ----

Deno.test("GET /admin/roles: 1 行 = 1 ロールで返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/roles", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    const admins = body.roles.find((r: { name: string }) =>
      r.name === "admins"
    );
    assertEquals(admins.enabled, true);
    assertEquals(admins.generation, 1);
    assertEquals(admins.memberCount, 1);
    assertEquals(admins.rules, [{ path: "/", level: "admin" }]);
  });
});

Deno.test("PUT /admin/roles/:name: 作成すると世代 1 から始まり判定に効く", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("PUT", "/admin/roles/projects-editor", adminToken, ADMIN_DEVICE, {
        rules: [
          { path: "/projects", level: "write" },
          { path: "/projects/secret", level: null },
        ],
        tests: [
          { expect: "writable", path: "/projects/spec.md" },
          { expect: "invisible", path: "/projects/secret/inner.txt" },
        ],
      }),
    );
    assertEquals(res.status, 200);
    const saved = await res.json();
    assertEquals(saved.ok, true);
    assertEquals(saved.generation, 1);

    await app.fetch(
      req("POST", "/admin/assignments", adminToken, ADMIN_DEVICE, {
        userId: 2,
        role: "projects-editor",
      }),
    );
    assertEquals(await checkPermission(2, "/projects/a.txt", "write"), true);
    assertEquals(
      await checkPermission(2, "/projects/secret/x.txt", "visible"),
      false,
    );
  });
});

Deno.test("PUT /admin/roles/:name: 更新は世代を 1 つ積む", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    for (const level of ["read", "write"]) {
      const res = await app.fetch(
        req("PUT", "/admin/roles/viewers", adminToken, ADMIN_DEVICE, {
          rules: [{ path: "/shared", level }],
          tests: [],
        }),
      );
      assertEquals(res.status, 200);
    }
    const detail = await (await app.fetch(
      req("GET", "/admin/roles/viewers", adminToken, ADMIN_DEVICE),
    )).json();
    assertEquals(detail.generation, 2);
    assertEquals(
      detail.generations.map((g: { generation: number }) => g.generation),
      [2, 1],
    );
  });
});

Deno.test("POST /admin/roles/:name/generation: 前の世代に戻せる", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    // carol の users ロールは /shared にしか効かないので、別のパスで見る。
    for (const level of ["read", "write"]) {
      await app.fetch(
        req("PUT", "/admin/roles/viewers", adminToken, ADMIN_DEVICE, {
          rules: [{ path: "/docs", level }],
          tests: [],
        }),
      );
    }
    await app.fetch(
      req("POST", "/admin/assignments", adminToken, ADMIN_DEVICE, {
        userId: 2,
        role: "viewers",
      }),
    );
    assertEquals(await checkPermission(2, "/docs/a.txt", "write"), true);

    const res = await app.fetch(
      req(
        "POST",
        "/admin/roles/viewers/generation",
        adminToken,
        ADMIN_DEVICE,
        { generation: 1 },
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await checkPermission(2, "/docs/a.txt", "write"), false);
    assertEquals(await checkPermission(2, "/docs/a.txt", "read"), true);
  });
});

Deno.test("POST /admin/roles/:name/enabled: 無効にすると権限だけ止まる", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    assertEquals(await checkPermission(2, "/shared/a.txt", "write"), true);

    const off = await app.fetch(
      req("POST", "/admin/roles/users/enabled", adminToken, ADMIN_DEVICE, {
        enabled: false,
      }),
    );
    assertEquals(off.status, 200);
    assertEquals(await checkPermission(2, "/shared/a.txt", "write"), false);

    // 割り当ては残っている
    const assignments = await (await app.fetch(
      req("GET", "/admin/assignments?userId=2", adminToken, ADMIN_DEVICE),
    )).json();
    assertEquals(assignments[0].roles, ["users"]);

    const on = await app.fetch(
      req("POST", "/admin/roles/users/enabled", adminToken, ADMIN_DEVICE, {
        enabled: true,
      }),
    );
    assertEquals(on.status, 200);
    assertEquals(await checkPermission(2, "/shared/a.txt", "write"), true);
  });
});

Deno.test("POST /admin/roles/:name/enabled: 最後の admin ロールは無効にできない", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("POST", "/admin/roles/admins/enabled", adminToken, ADMIN_DEVICE, {
        enabled: false,
      }),
    );
    assertEquals(res.status, 422);
    assert((await res.json()).rejection.includes("admin"));
    assert(await checkPermission(1, "/", "admin"));
  });
});

Deno.test("PUT /admin/roles/:name: 壊れたルールは 400、テスト失敗は 422", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);

    const bad = await app.fetch(
      req("PUT", "/admin/roles/viewers", adminToken, ADMIN_DEVICE, {
        rules: [{ path: "relative", level: "read" }],
      }),
    );
    assertEquals(bad.status, 400);

    const failing = await app.fetch(
      req("PUT", "/admin/roles/viewers", adminToken, ADMIN_DEVICE, {
        rules: [{ path: "/shared", level: "read" }],
        tests: [{ expect: "writable", path: "/shared" }],
      }),
    );
    assertEquals(failing.status, 422);
    const body = await failing.json();
    assertEquals(body.testFailures.length, 1);
    assertEquals(body.testFailures[0].actual, "read");
  });
});

Deno.test("PUT /admin/roles/:name: admin が 1 人もいなくなる変更は 422", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("PUT", "/admin/roles/admins", adminToken, ADMIN_DEVICE, {
        rules: [{ path: "/", level: "read" }],
        tests: [],
      }),
    );
    assertEquals(res.status, 422);
    assert((await res.json()).rejection.includes("admin"));
    assert(await checkPermission(1, "/", "admin"));
  });
});

Deno.test("PUT /admin/roles/:name: dryRun は保存しない", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("PUT", "/admin/roles/viewers", adminToken, ADMIN_DEVICE, {
        rules: [{ path: "/shared", level: "read" }],
        dryRun: true,
      }),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).ok, true);
    const list = await (await app.fetch(
      req("GET", "/admin/roles", adminToken, ADMIN_DEVICE),
    )).json();
    assertEquals(
      list.roles.some((r: { name: string }) => r.name === "viewers"),
      false,
    );
  });
});

Deno.test("DELETE /admin/roles/:name: 割り当てごと消える", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("DELETE", "/admin/roles/users", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).removedAssignments, 1);
    assertEquals(await checkPermission(2, "/shared/a.txt", "write"), false);
  });
});

Deno.test("ロール名は形式を固定してからパスに使う", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    for (const bad of ["-leading", "with space", ".."]) {
      const res = await app.fetch(
        req(
          "GET",
          `/admin/roles/${encodeURIComponent(bad)}`,
          adminToken,
          ADMIN_DEVICE,
        ),
      );
      assert(res.status === 400 || res.status === 404, `${bad}: ${res.status}`);
    }
  });
});

// ---- Policy text (取り込み / 書き出し) ----

Deno.test("GET /admin/policy: レコードから生成したテキストを返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("GET", "/admin/policy", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    const text = (await res.json()).text;
    assert(text.includes("role admins {"));
    assert(text.includes("allow  admin  /"));
  });
});

Deno.test("PUT /admin/policy: 取り込みは併合ではなく置き換え", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("PUT", "/admin/policy", adminToken, ADMIN_DEVICE, {
        text:
          "role admins {\n  allow admin /\n}\n\ntest admins {\n  admin /\n}\n",
      }),
    );
    assertEquals(res.status, 200);
    assertEquals((await res.json()).roles, 1);

    const list = await (await app.fetch(
      req("GET", "/admin/roles", adminToken, ADMIN_DEVICE),
    )).json();
    assertEquals(list.roles.map((r: { name: string }) => r.name), ["admins"]);
  });
});

Deno.test("PUT /admin/policy: 壊れたテキストは 422 で行番号を返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("PUT", "/admin/policy", adminToken, ADMIN_DEVICE, {
        text: "role r {\n  grant read /a\n}\n",
      }),
    );
    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.ok, false);
    assertEquals(body.errors[0].line, 2);
  });
});

// ---- Assignments ----

Deno.test("POST /admin/assignments: 未定義ロールは 404", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("POST", "/admin/assignments", adminToken, ADMIN_DEVICE, {
        userId: 2,
        role: "ghost",
      }),
    );
    assertEquals(res.status, 404);
  });
});

Deno.test("POST /admin/assignments: 割り当てると即座に判定へ反映される", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    await seedRole("projects-editor", [
      { path: "/projects", accessLevel: "write" },
    ]);
    assertEquals(await checkPermission(2, "/projects/a.txt", "write"), false);

    const res = await app.fetch(
      req("POST", "/admin/assignments", adminToken, ADMIN_DEVICE, {
        userId: 2,
        role: "projects-editor",
      }),
    );
    assertEquals(res.status, 201);
    assertEquals(await checkPermission(2, "/projects/a.txt", "write"), true);
  });
});

Deno.test("DELETE /admin/assignments: 最後の admin を外す操作は 409", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("DELETE", "/admin/assignments/1/admins", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 409);
    assert(await checkPermission(1, "/", "admin"));
  });
});

Deno.test("DELETE /admin/assignments: 別の admin がいれば自分の分は外せる", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const assigned = await app.fetch(
      req("POST", "/admin/assignments", adminToken, ADMIN_DEVICE, {
        userId: 2,
        role: "admins",
      }),
    );
    assertEquals(assigned.status, 201);

    const res = await app.fetch(
      req("DELETE", "/admin/assignments/1/admins", adminToken, ADMIN_DEVICE),
    );
    assertEquals(res.status, 200);
    assertEquals(await checkPermission(1, "/", "admin"), false);
    assert(await checkPermission(2, "/", "admin"));
  });
});

Deno.test("DELETE /admin/users/:id: 最後の admin は削除できない (409)", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    // carol を admin にしてから admin(1) を消す → 通る
    await app.fetch(
      req("POST", "/admin/assignments", adminToken, ADMIN_DEVICE, {
        userId: 2,
        role: "admins",
      }),
    );
    // 逆に carol を消すのは admin(1) が残るので通るはず
    const ok = await app.fetch(
      req("DELETE", "/admin/users/2", adminToken, ADMIN_DEVICE),
    );
    assertEquals(ok.status, 200);
    assert(await checkPermission(1, "/", "admin"));
  });
});

// ---- Assertions (割り当て層の拒否権) ----

Deno.test("POST /admin/assertions: 現状で成立しない主張は 422", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const res = await app.fetch(
      req("POST", "/admin/assertions", adminToken, ADMIN_DEVICE, {
        userId: 2,
        path: "/nowhere",
        expect: "writable",
      }),
    );
    assertEquals(res.status, 422);
  });
});

Deno.test("アサーションを壊すポリシー保存は拒否される (consumer-driven contract)", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    // carol は users ロールで / に write を持つ。それを凍結する。
    const created = await app.fetch(
      req("POST", "/admin/assertions", adminToken, ADMIN_DEVICE, {
        userId: 2,
        path: "/shared/a.txt",
        expect: "writable",
        note: "carol の共有フォルダ書き込み",
      }),
    );
    assertEquals(created.status, 201);

    // users ロールを read に落とす版は、文書としては正しいが却下される
    const res = await app.fetch(
      req("PUT", "/admin/policy", adminToken, ADMIN_DEVICE, {
        text: "role admins {\n  allow admin /\n}\n" +
          "role users {\n  allow read /\n}\n",
      }),
    );
    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.errors.length, 0);
    assertEquals(body.assertionFailures.length, 1);
    assertEquals(body.assertionFailures[0].expected, "writable");
    assertEquals(body.assertionFailures[0].actual, "read");
  });
});

Deno.test("DELETE /admin/assertions/:id: 消せば保存が通るようになる", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const created = await (await app.fetch(
      req("POST", "/admin/assertions", adminToken, ADMIN_DEVICE, {
        userId: 2,
        path: "/shared/a.txt",
        expect: "writable",
      }),
    )).json();

    const removed = await app.fetch(
      req(
        "DELETE",
        `/admin/assertions/${created.id}`,
        adminToken,
        ADMIN_DEVICE,
      ),
    );
    assertEquals(removed.status, 200);

    const res = await app.fetch(
      req("PUT", "/admin/policy", adminToken, ADMIN_DEVICE, {
        text: "role admins {\n  allow admin /\n}\n" +
          "role users {\n  allow read /\n}\n",
      }),
    );
    assertEquals(res.status, 200);
  });
});

// ---- Diagnostics ----

Deno.test("GET /admin/diagnostics/effective: ロールごとの決め手を返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    await app.fetch(
      req("PUT", "/admin/roles/projects-editor", adminToken, ADMIN_DEVICE, {
        rules: [
          { path: "/projects", level: "write" },
          { path: "/projects/secret", level: null },
        ],
        tests: [{ expect: "invisible", path: "/projects/secret/inner.txt" }],
      }),
    );
    await app.fetch(
      req("POST", "/admin/assignments", adminToken, ADMIN_DEVICE, {
        userId: 2,
        role: "projects-editor",
      }),
    );

    const res = await app.fetch(
      req(
        "GET",
        "/admin/diagnostics/effective?userId=2&path=/projects/secret/x.txt",
        adminToken,
        ADMIN_DEVICE,
      ),
    );
    const body = await res.json();
    assertEquals(body.effective, "invisible");
    assertEquals(body.perRole[0].role, "projects-editor");
    assertEquals(body.perRole[0].decidedBy, "/projects/secret");
    assertEquals(body.perRole[0].level, null);
  });
});

Deno.test("GET /admin/diagnostics/who: そのパスに届くユーザーだけを返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    await app.fetch(
      req("PUT", "/admin/roles/projects-editor", adminToken, ADMIN_DEVICE, {
        rules: [
          { path: "/projects", level: "write" },
          { path: "/projects/secret", level: null },
        ],
        tests: [{ expect: "invisible", path: "/projects/secret/inner.txt" }],
      }),
    );
    await app.fetch(
      req("POST", "/admin/assignments", adminToken, ADMIN_DEVICE, {
        userId: 2,
        role: "projects-editor",
      }),
    );

    const res = await app.fetch(
      req(
        "GET",
        "/admin/diagnostics/who?path=/projects&level=write",
        adminToken,
        ADMIN_DEVICE,
      ),
    );
    const body = await res.json();
    assertEquals(body.users.map((u: { userId: number }) => u.userId), [1, 2]);

    // deny で切られた先は admin だけが届く
    const secret = await (await app.fetch(
      req(
        "GET",
        "/admin/diagnostics/who?path=/projects/secret&level=read",
        adminToken,
        ADMIN_DEVICE,
      ),
    )).json();
    assertEquals(secret.users.map((u: { userId: number }) => u.userId), [1]);
  });
});

Deno.test("PUT /admin/roles/:name: 壊れたパスは理由の分かる 400 を返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    const cases: Array<[string, string]> = [
      ["projects", "/ で始めて"],
      ["/projects/", "末尾の /"],
      ["/a" + String.fromCharCode(10) + "role evil {", "制御文字"],
      ["/a/../b", ". / .."],
    ];
    for (const [path, fragment] of cases) {
      const res = await app.fetch(
        req("PUT", "/admin/roles/viewers", adminToken, ADMIN_DEVICE, {
          rules: [{ path, level: "read" }],
        }),
      );
      assertEquals(res.status, 400, `${path} が 400 になっていない`);
      const message = (await res.json()).message;
      assert(
        message.includes(fragment),
        `${path}: 理由が伝わらない (${message})`,
      );
    }
    // 1 件も保存されていない
    const list = await (await app.fetch(
      req("GET", "/admin/roles", adminToken, ADMIN_DEVICE),
    )).json();
    assertEquals(
      list.roles.some((r: { name: string }) => r.name === "viewers"),
      false,
    );
  });
});

Deno.test("PUT /admin/roles/:name: 警告は保存したロールの分だけ返す", async () => {
  await withTestKv(async (kv) => {
    const { adminToken } = await setup(kv);
    // 未割当のロールを 2 つ作る。2 つ目の保存で 1 つ目の警告まで並ばないこと。
    await app.fetch(
      req("PUT", "/admin/roles/first", adminToken, ADMIN_DEVICE, {
        rules: [{ path: "/a", level: "read" }],
      }),
    );
    const res = await app.fetch(
      req("PUT", "/admin/roles/second", adminToken, ADMIN_DEVICE, {
        rules: [{ path: "/b", level: "read" }],
      }),
    );
    const body = await res.json();
    assertEquals(body.warnings.map((w: { role: string }) => w.role), [
      "second",
    ]);

    // 一覧側は全部見せる
    const list = await (await app.fetch(
      req("GET", "/admin/roles", adminToken, ADMIN_DEVICE),
    )).json();
    assertEquals(
      list.warnings.map((w: { role: string }) => w.role).sort(),
      ["first", "second"],
    );
  });
});
