/**
 * POST /enroll の責務 (end-to-end):
 *   - body validation: secret / deviceId 未指定や format 不正は 400
 *   - 正常 enrollment は 201 で bearerToken + userId + userName を返す
 *   - 二度目は 410 (already_consumed)、message は generic に畳まれる
 *   - 不正 secret も同じ 410 (enumeration を防ぐ意図)
 *   - middleware の auth skip 経路 (token ヘッダ無くても通る)
 */

import { assert, assertEquals } from "@std/assert";
import app from "../src/app.ts";
import { createEnrollmentSecret } from "../src/services/enrollment.service.ts";
import { seedUser, withTestKv } from "./_helpers.ts";

const TEST_DEVICE_ID = "dev-enroll-test-0000000001";

function enrollReq(body: unknown): Request {
  return new Request("http://localhost/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seed(kv: Deno.Kv): Promise<void> {
  await seedUser(kv, {
    userId: 1,
    userName: "alice",
  });
}

Deno.test("POST /enroll: body 無しは 400", async () => {
  await withTestKv(async (_kv) => {
    const res = await app.fetch(
      new Request("http://localhost/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("POST /enroll: secret 未指定は 400", async () => {
  await withTestKv(async (_kv) => {
    const res = await app.fetch(enrollReq({ deviceId: TEST_DEVICE_ID }));
    assertEquals(res.status, 400);
  });
});

Deno.test("POST /enroll: deviceId format 不正は 400", async () => {
  await withTestKv(async (_kv) => {
    const res = await app.fetch(
      enrollReq({ secret: "x", deviceId: "short" }),
    );
    assertEquals(res.status, 400);
  });
});

Deno.test("POST /enroll: 正常 enrollment で 201 + bearerToken 返却", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    const enroll = await createEnrollmentSecret(1, 1, 7);
    const res = await app.fetch(
      enrollReq({ secret: enroll.raw, deviceId: TEST_DEVICE_ID }),
    );
    assertEquals(res.status, 201);
    const body = (await res.json()) as {
      bearerToken: string;
      userId: number;
      userName: string;
    };
    assert(body.bearerToken.length > 0);
    assertEquals(body.userId, 1);
    assertEquals(body.userName, "alice");
  });
});

Deno.test("POST /enroll: 二度目 consume は 410", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    const enroll = await createEnrollmentSecret(1, 1, 7);
    const first = await app.fetch(
      enrollReq({ secret: enroll.raw, deviceId: TEST_DEVICE_ID }),
    );
    assertEquals(first.status, 201);
    await first.body?.cancel();
    const second = await app.fetch(
      enrollReq({ secret: enroll.raw, deviceId: TEST_DEVICE_ID }),
    );
    assertEquals(second.status, 410);
  });
});

Deno.test("POST /enroll: 不正 secret も 410 (enumeration 防止)", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    const res = await app.fetch(
      enrollReq({
        secret: crypto.randomUUID(),
        deviceId: TEST_DEVICE_ID,
      }),
    );
    assertEquals(res.status, 410);
  });
});

Deno.test("POST /enroll: auth middleware を skip する (Authorization 無しで通る)", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    const enroll = await createEnrollmentSecret(1, 1, 7);
    // Authorization header を一切付けない
    const res = await app.fetch(
      new Request("http://localhost/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: enroll.raw,
          deviceId: TEST_DEVICE_ID,
        }),
      }),
    );
    assertEquals(res.status, 201);
  });
});

// ───────── deviceId は 1 ユーザーに固定する (マルチアカウント分離) ─────────
//
// deviceId は client が名乗るだけで、以前は一意性の検査が無かった。そのため
// **被害者の deviceId を名乗って自分のアカウントを enroll** でき、device 単位の
// 診断・監査 (devices 一覧、mismatch ログ) が成立しなくなっていた。
// ロック / upload session の所有は (userId, deviceId) で見るようになったが、
// 入口でも閉じる。

Deno.test("POST /enroll: 他ユーザーが使っている deviceId は拒否する", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, { userId: 1, userName: "alice" });
    await seedUser(kv, { userId: 2, userName: "mallory" });

    const shared = "dev-collision-000000000001";

    // alice が先にその deviceId で enroll
    const a = await createEnrollmentSecret(1, 60_000);
    assertEquals(
      (await app.fetch(enrollReq({ secret: a.raw, deviceId: shared }))).status,
      201,
    );

    // mallory が同じ deviceId を名乗る → 409
    const m = await createEnrollmentSecret(2, 60_000);
    const res = await app.fetch(enrollReq({ secret: m.raw, deviceId: shared }));
    assertEquals(res.status, 409);
    await res.body?.cancel();
  });
});

Deno.test("POST /enroll: 同じユーザーの同じ端末は再 enroll できる", async () => {
  // 端末の再セットアップやトークン再発行を壊さないこと。
  await withTestKv(async (kv) => {
    await seedUser(kv, { userId: 1, userName: "alice" });
    const device = "dev-reenroll-00000000001";

    const first = await createEnrollmentSecret(1, 60_000);
    assertEquals(
      (await app.fetch(enrollReq({ secret: first.raw, deviceId: device })))
        .status,
      201,
    );

    const second = await createEnrollmentSecret(1, 60_000);
    const res = await app.fetch(
      enrollReq({ secret: second.raw, deviceId: device }),
    );
    assertEquals(res.status, 201);
    await res.body?.cancel();
  });
});
