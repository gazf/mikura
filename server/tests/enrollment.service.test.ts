/**
 * `enrollment.service` の責務:
 *   - createEnrollmentSecret: raw secret 発行 + KV に hash 保存 + expiresAt 計算
 *   - consumeEnrollment: atomic に消費 + token 発行 (boundDeviceId 設定)
 *   - 二度目 consume / 期限切れ / 不正 secret / 削除済み user は失敗
 *   - admin が outstanding を見るための listEnrollmentsByUser
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  consumeEnrollment,
  createEnrollmentSecret,
  EnrollmentError,
  listEnrollmentsByUser,
} from "../src/services/enrollment.service.ts";
import { Keys } from "../src/kv/keys.ts";
import type { EnrollmentSecret, TokenData } from "../src/types.ts";
import { seedUser, withTestKv } from "./_helpers.ts";

async function seed(kv: Deno.Kv): Promise<void> {
  await seedUser(kv, {
    userId: 1,
    userName: "alice",
    groupId: 10,
    groupName: "alice-g",
    permissions: [{ path: "/", accessLevel: "write" }],
  });
}

Deno.test("createEnrollmentSecret: raw + hash + expiresAt", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    const result = await createEnrollmentSecret(1, 1, 7);
    assert(result.raw.length > 0);
    assertEquals(result.secretHash.length, 64); // SHA256 hex
    // expiresAt は now + 7 日 ± 数秒
    const expMs = Date.parse(result.expiresAt);
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    assert(Math.abs(expMs - (Date.now() + sevenDays)) < 5000);

    // KV に hash 経路で取れる
    const stored = await kv.get<EnrollmentSecret>(
      Keys.enrollment(result.secretHash),
    );
    assert(stored.value);
    assertEquals(stored.value.userId, 1);
    assertEquals(stored.value.consumedAt, undefined);
  });
});

Deno.test("createEnrollmentSecret: user_not_found は EnrollmentError", async () => {
  await withTestKv(async (_kv) => {
    await assertRejects(
      () => createEnrollmentSecret(999, 1, 7),
      EnrollmentError,
      "user_not_found",
    );
  });
});

Deno.test("consumeEnrollment: token 発行 + boundDeviceId 設定", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    const { raw } = await createEnrollmentSecret(1, 1, 7);
    const deviceId = "dev-alice-pc-00000001";
    const result = await consumeEnrollment(raw, deviceId);
    assertEquals(result.userId, 1);
    assertEquals(result.userName, "alice");
    assert(result.rawToken.length > 0);
    assertEquals(result.tokenHash.length, 64);

    // 発行された token は boundDeviceId を持っている
    const tokenEntry = await kv.get<TokenData>(Keys.token(result.tokenHash));
    assert(tokenEntry.value);
    assertEquals(tokenEntry.value.boundDeviceId, deviceId);
    assertEquals(tokenEntry.value.userId, 1);
  });
});

Deno.test("consumeEnrollment: 二度目は already_consumed で失敗", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    const { raw } = await createEnrollmentSecret(1, 1, 7);
    await consumeEnrollment(raw, "dev-alice-pc-00000001");
    await assertRejects(
      () => consumeEnrollment(raw, "dev-other-pc-00000001"),
      EnrollmentError,
      "already_consumed",
    );
  });
});

Deno.test("consumeEnrollment: 期限切れ secret は invalid_or_expired", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    const { raw, secretHash } = await createEnrollmentSecret(1, 1, 7);
    // 期限を過去にすり替え
    const cur = await kv.get<EnrollmentSecret>(Keys.enrollment(secretHash));
    await kv.set(
      Keys.enrollment(secretHash),
      {
        ...cur.value!,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      } satisfies EnrollmentSecret,
    );
    await assertRejects(
      () => consumeEnrollment(raw, "dev-pc-00000001-test"),
      EnrollmentError,
      "invalid_or_expired",
    );
  });
});

Deno.test("consumeEnrollment: 存在しない raw は invalid_or_expired", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    await assertRejects(
      () => consumeEnrollment(crypto.randomUUID(), "dev-pc-00000001-test"),
      EnrollmentError,
      "invalid_or_expired",
    );
  });
});

Deno.test("listEnrollmentsByUser: outstanding と consumed を両方返す", async () => {
  await withTestKv(async (kv) => {
    await seed(kv);
    const a = await createEnrollmentSecret(1, 1, 7);
    const b = await createEnrollmentSecret(1, 1, 7);
    // a を consume、b は未消費
    await consumeEnrollment(a.raw, "dev-consumed-0000000001");

    const list = await listEnrollmentsByUser(1);
    assertEquals(list.length, 2);
    const aRec = list.find((e) => e.secretHash === a.secretHash);
    const bRec = list.find((e) => e.secretHash === b.secretHash);
    assert(aRec);
    assert(bRec);
    assert(aRec.consumedAt);
    assertEquals(aRec.consumedByDeviceId, "dev-consumed-0000000001");
    assertEquals(bRec.consumedAt, undefined);
  });
});
