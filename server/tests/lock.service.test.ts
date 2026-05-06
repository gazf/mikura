import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  acquireLock,
  getAllLocks,
  getLock,
  isLockedByOther,
  refreshDeviceLocks,
  releaseDeviceLocks,
  releaseLock,
} from "../src/services/lock.service.ts";
import { Keys } from "../src/kv/keys.ts";
import type { LockData } from "../src/types.ts";
import { withTestKv } from "./_helpers.ts";

const USER_A = 1;
const USER_B = 2;
const DEV_X = "device-xxxxxxxx";
const DEV_Y = "device-yyyyyyyy";
const PATH = "/foo.txt";

Deno.test("acquireLock: new lock succeeds and is stored", async () => {
  await withTestKv(async (kv) => {
    const result = await acquireLock(PATH, USER_A, DEV_X);
    assert(result.success);
    assertEquals(result.lock?.userId, USER_A);
    assertEquals(result.lock?.deviceId, DEV_X);

    const stored = await kv.get<LockData>(Keys.lock(PATH));
    assertEquals(stored.value?.userId, USER_A);
    assertEquals(stored.value?.deviceId, DEV_X);

    // device_locks 逆引きインデックスも書かれる
    const reverse = await kv.get(Keys.deviceLock(DEV_X, PATH));
    assert(reverse.versionstamp !== null);
  });
});

Deno.test("acquireLock: same user same device renews acquiredAt unchanged", async () => {
  await withTestKv(async () => {
    const first = await acquireLock(PATH, USER_A, DEV_X);
    assert(first.success);
    const acquiredAt = first.lock!.acquiredAt;

    await new Promise((r) => setTimeout(r, 5));
    const second = await acquireLock(PATH, USER_A, DEV_X);
    assert(second.success);
    assertEquals(second.lock?.acquiredAt, acquiredAt);
  });
});

Deno.test("acquireLock: same user different device takes over (new deviceId stored)", async () => {
  await withTestKv(async (kv) => {
    await acquireLock(PATH, USER_A, DEV_X);
    const result = await acquireLock(PATH, USER_A, DEV_Y);
    assert(result.success);
    assertEquals(result.lock?.deviceId, DEV_Y);

    // 旧 deviceId の逆引きは消える、新 deviceId の逆引きは残る
    const oldReverse = await kv.get(Keys.deviceLock(DEV_X, PATH));
    const newReverse = await kv.get(Keys.deviceLock(DEV_Y, PATH));
    assertEquals(oldReverse.versionstamp, null);
    assert(newReverse.versionstamp !== null);
  });
});

Deno.test("acquireLock: different user is rejected with existing lock", async () => {
  await withTestKv(async () => {
    await acquireLock(PATH, USER_A, DEV_X);
    const result = await acquireLock(PATH, USER_B, DEV_Y);
    assertFalse(result.success);
    assertEquals(result.lock?.userId, USER_A);
    assertEquals(result.message, "Locked by another user");
  });
});

Deno.test("releaseLock: holder can release", async () => {
  await withTestKv(async (kv) => {
    await acquireLock(PATH, USER_A, DEV_X);
    const ok = await releaseLock(PATH, USER_A, DEV_X);
    assert(ok);

    const stored = await kv.get(Keys.lock(PATH));
    assertEquals(stored.versionstamp, null);
    const reverse = await kv.get(Keys.deviceLock(DEV_X, PATH));
    assertEquals(reverse.versionstamp, null);
  });
});

Deno.test("releaseLock: different user cannot release", async () => {
  await withTestKv(async (kv) => {
    await acquireLock(PATH, USER_A, DEV_X);
    const ok = await releaseLock(PATH, USER_B, DEV_Y);
    assertFalse(ok);

    const stored = await kv.get(Keys.lock(PATH));
    assert(stored.value !== null);
  });
});

Deno.test("releaseLock: same user different device deletes main lock but keeps current device's reverse index", async () => {
  // 取り戻しシナリオの逆: 旧端末の close 通知が後で届いた時に現端末の逆引きを
  // 巻き込まないようにする。
  await withTestKv(async (kv) => {
    await acquireLock(PATH, USER_A, DEV_X); // X が取得
    await acquireLock(PATH, USER_A, DEV_Y); // Y が取り戻し
    // X が遅れて release を投げてきたケース
    const ok = await releaseLock(PATH, USER_A, DEV_X);
    assert(ok); // userId 一致なら release 自体は許可

    // Y の逆引きは残っているべき
    const yReverse = await kv.get(Keys.deviceLock(DEV_Y, PATH));
    assert(yReverse.versionstamp !== null);
    // メインの ["locks", path] は消える
    const stored = await kv.get(Keys.lock(PATH));
    assertEquals(stored.versionstamp, null);
  });
});

Deno.test("releaseLock: no existing lock returns true (idempotent)", async () => {
  await withTestKv(async () => {
    const ok = await releaseLock(PATH, USER_A, DEV_X);
    assert(ok);
  });
});

Deno.test("getLock / isLockedByOther", async () => {
  await withTestKv(async () => {
    assertEquals(await getLock(PATH), null);
    assertFalse(await isLockedByOther(PATH, USER_A));

    await acquireLock(PATH, USER_A, DEV_X);
    const lock = await getLock(PATH);
    assertEquals(lock?.userId, USER_A);
    assertFalse(await isLockedByOther(PATH, USER_A));
    assert(await isLockedByOther(PATH, USER_B));
  });
});

Deno.test("getAllLocks: returns map of all locks", async () => {
  await withTestKv(async () => {
    await acquireLock("/a.txt", USER_A, DEV_X);
    await acquireLock("/b.txt", USER_B, DEV_Y);

    const all = await getAllLocks();
    assertEquals(all.size, 2);
    assertEquals(all.get("/a.txt")?.userId, USER_A);
    assertEquals(all.get("/b.txt")?.userId, USER_B);
  });
});

Deno.test("refreshDeviceLocks: refreshes existing locks for the device", async () => {
  await withTestKv(async (kv) => {
    await acquireLock("/a.txt", USER_A, DEV_X);
    await acquireLock("/b.txt", USER_A, DEV_X);

    const refreshed = await refreshDeviceLocks(DEV_X);
    assertEquals(refreshed, 2);

    // expiresAt が更新されていること (再 set 後の値が前と異なる or 30s 以内)
    const a = await kv.get<LockData>(Keys.lock("/a.txt"));
    const expiresAtMs = new Date(a.value!.expiresAt).getTime();
    assert(expiresAtMs - Date.now() > 25_000); // 概ね 30s 後を指す
  });
});

Deno.test("refreshDeviceLocks: cleans up stale device_locks reverse entries", async () => {
  await withTestKv(async (kv) => {
    await acquireLock(PATH, USER_A, DEV_X);
    // メインを直接消して逆引きだけ残す状態を作る
    await kv.delete(Keys.lock(PATH));

    const refreshed = await refreshDeviceLocks(DEV_X);
    assertEquals(refreshed, 0);

    const reverse = await kv.get(Keys.deviceLock(DEV_X, PATH));
    assertEquals(reverse.versionstamp, null);
  });
});

Deno.test("refreshDeviceLocks: skips locks taken over by another device", async () => {
  await withTestKv(async (kv) => {
    await acquireLock(PATH, USER_A, DEV_X);
    await acquireLock(PATH, USER_A, DEV_Y); // 取り戻し

    // X の逆引きは acquireLock 内で削除済みのはず → refresh 対象 0
    const refreshed = await refreshDeviceLocks(DEV_X);
    assertEquals(refreshed, 0);

    // Y のメインロックには影響なし
    const lock = await kv.get<LockData>(Keys.lock(PATH));
    assertEquals(lock.value?.deviceId, DEV_Y);
  });
});

Deno.test("releaseDeviceLocks: bulk releases all locks held by device", async () => {
  await withTestKv(async (kv) => {
    await acquireLock("/a.txt", USER_A, DEV_X);
    await acquireLock("/b.txt", USER_A, DEV_X);
    await acquireLock("/c.txt", USER_B, DEV_Y); // 別 device

    const released = await releaseDeviceLocks(DEV_X);
    assertEquals(released, 2);

    assertEquals((await kv.get(Keys.lock("/a.txt"))).versionstamp, null);
    assertEquals((await kv.get(Keys.lock("/b.txt"))).versionstamp, null);
    // 別 device のロックは残る
    assert((await kv.get(Keys.lock("/c.txt"))).value !== null);
  });
});

Deno.test("releaseDeviceLocks: cleans up stale reverse entries without main lock", async () => {
  await withTestKv(async (kv) => {
    await acquireLock(PATH, USER_A, DEV_X);
    await kv.delete(Keys.lock(PATH)); // メインを直接消す

    const released = await releaseDeviceLocks(DEV_X);
    assertEquals(released, 0); // 解除済みカウントは 0
    // 逆引きは掃除される
    assertEquals(
      (await kv.get(Keys.deviceLock(DEV_X, PATH))).versionstamp,
      null,
    );
  });
});
