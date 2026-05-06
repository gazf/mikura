/**
 * /locks/* ルーティングの責務をエンドツーエンドで検証する:
 *   - 認証 (Bearer token) + X-Device-Id ヘッダの両方を要求する
 *   - write 権限がないと 403 を返す
 *   - 既存ロック (他ユーザー) がある時は 409 を返す
 *   - 自ユーザーの取得は 200、Lock データを返す
 *   - DELETE は holder に限り 200、それ以外は 403
 *
 * Hono の app.fetch にリクエストを直接食わせる方式 (実 listener 不要)。
 */
import { assert, assertEquals } from "@std/assert";
import app from "../src/app.ts";
import { createAppToken } from "../src/services/auth.service.ts";
import { Keys } from "../src/kv/keys.ts";
import type { LockData } from "../src/types.ts";
import { seedUser, withTestKv } from "./_helpers.ts";

interface Ctx {
  kv: Deno.Kv;
  aliceToken: string;
  bobToken: string;
}

async function setup(kv: Deno.Kv): Promise<Ctx> {
  await seedUser(kv, {
    userId: 1,
    userName: "alice",
    groupId: 10,
    groupName: "alice-g",
    permissions: [{ path: "/", accessLevel: "write" }],
  });
  await seedUser(kv, {
    userId: 2,
    userName: "bob",
    groupId: 20,
    groupName: "bob-g",
    permissions: [{ path: "/", accessLevel: "write" }],
  });
  const a = await createAppToken(1, "alice-token");
  const b = await createAppToken(2, "bob-token");
  return { kv, aliceToken: a.raw, bobToken: b.raw };
}

function lockReq(
  method: "POST" | "DELETE" | "GET",
  path: string,
  token: string,
  deviceId: string,
) {
  return new Request(`http://localhost/locks${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Device-Id": deviceId,
    },
  });
}

Deno.test("POST /locks/*: missing X-Device-Id is rejected with 400", async () => {
  await withTestKv(async (kv) => {
    const { aliceToken } = await setup(kv);
    const res = await app.fetch(
      new Request("http://localhost/locks/foo.txt", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}` },
      }),
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("POST /locks/*: invalid token is rejected with 401", async () => {
  await withTestKv(async (kv) => {
    await setup(kv);
    const res = await app.fetch(
      lockReq("POST", "/foo.txt", "bogus-token", "dev-alice-xx"),
    );
    assertEquals(res.status, 401);
  });
});

Deno.test("POST /locks/*: forbidden when user lacks write permission", async () => {
  await withTestKv(async (kv) => {
    // read のみのユーザー
    await seedUser(kv, {
      userId: 3,
      userName: "charlie",
      groupId: 30,
      groupName: "charlie-g",
      permissions: [{ path: "/", accessLevel: "read" }],
    });
    const { raw } = await createAppToken(3, "c-token");
    const res = await app.fetch(
      lockReq("POST", "/foo.txt", raw, "dev-charlie"),
    );
    assertEquals(res.status, 403);
  });
});

Deno.test("POST /locks/*: success stores lock with deviceId from header", async () => {
  await withTestKv(async (kv) => {
    const { aliceToken } = await setup(kv);
    const res = await app.fetch(
      lockReq("POST", "/foo.txt", aliceToken, "dev-alice-xx"),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as LockData;
    assertEquals(body.userId, 1);
    assertEquals(body.deviceId, "dev-alice-xx");

    const stored = await kv.get<LockData>(Keys.lock("/foo.txt"));
    assertEquals(stored.value?.userId, 1);
    assertEquals(stored.value?.deviceId, "dev-alice-xx");
  });
});

Deno.test("POST /locks/*: 409 when other user holds the lock", async () => {
  await withTestKv(async (kv) => {
    const { aliceToken, bobToken } = await setup(kv);
    await app.fetch(lockReq("POST", "/foo.txt", aliceToken, "dev-alice-pc"));
    const res = await app.fetch(
      lockReq("POST", "/foo.txt", bobToken, "dev-bob-pc"),
    );
    assertEquals(res.status, 409);
    const body = await res.json() as { lock: LockData };
    assertEquals(body.lock.userId, 1);
  });
});

Deno.test("DELETE /locks/*: only holder can release; other user gets 403", async () => {
  await withTestKv(async (kv) => {
    const { aliceToken, bobToken } = await setup(kv);
    await app.fetch(lockReq("POST", "/foo.txt", aliceToken, "dev-alice-pc"));

    const denied = await app.fetch(
      lockReq("DELETE", "/foo.txt", bobToken, "dev-bob-pc"),
    );
    assertEquals(denied.status, 403);

    const ok = await app.fetch(
      lockReq("DELETE", "/foo.txt", aliceToken, "dev-alice-pc"),
    );
    assertEquals(ok.status, 200);

    const stored = await kv.get(Keys.lock("/foo.txt"));
    assertEquals(stored.versionstamp, null);
  });
});

Deno.test("GET /locks/*: returns locked=false when none, locked=true with lock when held", async () => {
  await withTestKv(async (kv) => {
    const { aliceToken } = await setup(kv);
    let res = await app.fetch(
      lockReq("GET", "/foo.txt", aliceToken, "dev-alice-pc"),
    );
    assertEquals((await res.json()).locked, false);

    await app.fetch(lockReq("POST", "/foo.txt", aliceToken, "dev-alice-pc"));
    res = await app.fetch(
      lockReq("GET", "/foo.txt", aliceToken, "dev-alice-pc"),
    );
    const body = await res.json() as { locked: boolean; lock: LockData };
    assert(body.locked);
    assertEquals(body.lock.userId, 1);
    assertEquals(body.lock.deviceId, "dev-alice-pc");
  });
});
