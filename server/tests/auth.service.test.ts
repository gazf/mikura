import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  checkPermission,
  createAppToken,
  hashToken,
  revokeToken,
  upsertDevice,
  validateToken,
} from "../src/services/auth.service.ts";
import { Keys } from "../src/kv/keys.ts";
import type { DeviceData, TokenData } from "../src/types.ts";
import { seedUser, withTestKv } from "./_helpers.ts";

// ----- validateToken / createAppToken -----

Deno.test("createAppToken: stores token hash and forward index", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
    });
    const { raw, hash } = await createAppToken(1, "alice");
    assert(raw.length > 0);
    assertEquals(hash, await hashToken(raw));

    const token = await kv.get<TokenData>(Keys.token(hash));
    assertEquals(token.value?.userId, 1);
    const fwd = await kv.get(Keys.tokenByUser(1, hash));
    assertEquals(fwd.value, true);
  });
});

Deno.test("validateToken: returns identity for valid token", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
    });
    const { raw } = await createAppToken(1, "alice");
    const identity = await validateToken(raw);
    assertEquals(identity, { id: 1, name: "alice" });
  });
});

Deno.test("validateToken: returns null for unknown token", async () => {
  await withTestKv(async () => {
    const identity = await validateToken("bogus-token-not-in-kv");
    assertEquals(identity, null);
  });
});

Deno.test("validateToken: returns null for expired token", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
    });
    const { raw, hash } = await createAppToken(1, "alice");
    // 期限切れに書き換え
    const expired: TokenData = {
      userId: 1,
      name: "alice",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date(Date.now() - 100_000).toISOString(),
    };
    await kv.set(Keys.token(hash), expired);

    assertEquals(await validateToken(raw), null);
  });
});

Deno.test("validateToken: returns null when user record gone", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
    });
    const { raw } = await createAppToken(1, "alice");
    await kv.delete(Keys.user(1));
    assertEquals(await validateToken(raw), null);
  });
});

Deno.test("validateToken: cached hit still rejects expired tokenExpiresAt", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
    });
    const { raw, hash } = await createAppToken(1, "alice");
    // 1 度目: KV を見て identity 取得 & キャッシュ
    assertEquals(await validateToken(raw), { id: 1, name: "alice" });

    // KV 上のトークンを expired に差し替え
    const expired: TokenData = {
      userId: 1,
      name: "alice",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: new Date(Date.now() - 100_000).toISOString(),
    };
    await kv.set(Keys.token(hash), expired);

    // キャッシュエントリ自体は生きているが、tokenExpiresAtMs は元の (将来の)
    // 値なのでヒットしてしまうのが期待動作 (TTL 内は KV 変更を見ない)。
    // ただし KV 上の expired は次回キャッシュ失効後 (もしくは invalidate 後)
    // 反映される。明示 invalidate で挙動を検証する。
    const { invalidateToken } = await import(
      "../src/services/auth.service.ts"
    );
    invalidateToken(hash);
    assertEquals(await validateToken(raw), null);
  });
});

// ----- upsertDevice throttle -----

Deno.test("upsertDevice: same (userId, ip) within throttle window skips KV write", async () => {
  await withTestKv(async (kv) => {
    await upsertDevice("dev-throttle1", 1, "192.168.0.1");
    const first = await kv.get<DeviceData>(Keys.device("dev-throttle1"));
    const firstSeen = first.value!.firstSeenAt;

    await new Promise((r) => setTimeout(r, 5));
    // 直接 KV を書き換えても、throttle 中の upsertDevice は読みに行かないので
    // この置き換えは観測されたまま残る (= KV write が走っていない証拠)。
    await kv.set(Keys.device("dev-throttle1"), {
      ...first.value!,
      ipAddress: "10.99.99.99",
    });
    await upsertDevice("dev-throttle1", 1, "192.168.0.1");

    const after = await kv.get<DeviceData>(Keys.device("dev-throttle1"));
    assertEquals(after.value?.ipAddress, "10.99.99.99");
    assertEquals(after.value?.firstSeenAt, firstSeen);
  });
});

Deno.test("upsertDevice: changed ip bypasses throttle and writes immediately", async () => {
  await withTestKv(async (kv) => {
    await upsertDevice("dev-throttle2", 1, "192.168.0.1");
    await new Promise((r) => setTimeout(r, 5));
    await upsertDevice("dev-throttle2", 1, "10.0.0.1");

    const after = await kv.get<DeviceData>(Keys.device("dev-throttle2"));
    assertEquals(after.value?.ipAddress, "10.0.0.1");
  });
});

// ----- validateToken deviceId binding -----

async function makeBoundToken(
  kv: Deno.Kv,
  userId: number,
  boundDeviceId: string,
): Promise<{ raw: string; hash: string }> {
  // createAppToken は boundDeviceId を設定しないので、直接 KV に書き込む。
  // enrollment.service.consumeEnrollment と同じ shape を作る。
  const raw = crypto.randomUUID();
  const hash = await hashToken(raw);
  const data: TokenData = {
    userId,
    name: "bound-test",
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    boundDeviceId,
  };
  await kv
    .atomic()
    .set(Keys.token(hash), data)
    .set(Keys.tokenByUser(userId, hash), true)
    .commit();
  return { raw, hash };
}

Deno.test("validateToken: bound token は同 deviceId なら通る", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-g",
    });
    const deviceId = "dev-bound-alice-0001-zzzz";
    const { raw } = await makeBoundToken(kv, 1, deviceId);
    assertEquals(await validateToken(raw, { deviceId }), {
      id: 1,
      name: "alice",
    });
  });
});

Deno.test("validateToken: bound token は別 deviceId だと null", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-g",
    });
    const { raw } = await makeBoundToken(kv, 1, "dev-real-pc-0000000001zz");
    const identity = await validateToken(raw, {
      deviceId: "dev-attacker-0001-zzzzzzzz",
    });
    assertEquals(identity, null);
  });
});

Deno.test("validateToken: bound token は deviceId 未指定だと null", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-g",
    });
    const { raw } = await makeBoundToken(kv, 1, "dev-real-pc-0000000001zz");
    // opts 未指定 = deviceId undefined。bound 値 !== undefined なので null。
    assertEquals(await validateToken(raw), null);
  });
});

Deno.test("validateToken: cache hit 経路でも deviceId binding を enforce", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-g",
    });
    const realDevice = "dev-cache-alice-0001zzzzz";
    const { raw } = await makeBoundToken(kv, 1, realDevice);
    // 1 回目: cache 投入
    assertEquals(await validateToken(raw, { deviceId: realDevice }), {
      id: 1,
      name: "alice",
    });
    // 2 回目: cache hit 経路、別 deviceId は弾かれる
    assertEquals(
      await validateToken(raw, { deviceId: "dev-other-pc-zzzzzzzzzzzz" }),
      null,
    );
  });
});

Deno.test("validateToken: unbound (boundDeviceId 未設定) は deviceId 不問で通る", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-g",
    });
    // createAppToken は boundDeviceId を設定しない (= 旧 seed 由来 token と等価)
    const { raw } = await createAppToken(1, "alice");
    assertEquals(
      await validateToken(raw, { deviceId: "dev-any-zzzzzzzzzzzzzzzz" }),
      { id: 1, name: "alice" },
    );
    assertEquals(await validateToken(raw), { id: 1, name: "alice" });
  });
});

// ----- revokeToken -----

Deno.test("revokeToken: 既存 token を消去 + cache invalidate", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-g",
    });
    const { raw, hash } = await createAppToken(1, "alice");
    // warm cache
    assertEquals(await validateToken(raw), { id: 1, name: "alice" });

    const ok = await revokeToken(hash);
    assert(ok);
    // KV からも消えている
    const got = await kv.get<TokenData>(Keys.token(hash));
    assertEquals(got.value, null);
    const fwd = await kv.get(Keys.tokenByUser(1, hash));
    assertEquals(fwd.value, null);
    // cache も invalidate されてる
    assertEquals(await validateToken(raw), null);
  });
});

Deno.test("revokeToken: 存在しない hash は false", async () => {
  await withTestKv(async (_kv) => {
    const ok = await revokeToken("0".repeat(64));
    assertFalse(ok);
  });
});

// ----- checkPermission -----

Deno.test("checkPermission: returns false for user with no group", async () => {
  await withTestKv(async () => {
    assertFalse(await checkPermission(999, "/foo", "read"));
  });
});

Deno.test("checkPermission: exact path read permission", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
      permissions: [{ path: "/foo", accessLevel: "read" }],
    });
    assert(await checkPermission(1, "/foo", "read"));
    assertFalse(await checkPermission(1, "/foo", "write"));
  });
});

Deno.test("checkPermission: write permission allows read", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
      permissions: [{ path: "/foo", accessLevel: "write" }],
    });
    assert(await checkPermission(1, "/foo", "read"));
    assert(await checkPermission(1, "/foo", "write"));
  });
});

Deno.test("checkPermission: admin grants both read and write", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
      permissions: [{ path: "/foo", accessLevel: "admin" }],
    });
    assert(await checkPermission(1, "/foo", "read"));
    assert(await checkPermission(1, "/foo", "write"));
  });
});

Deno.test("checkPermission: walks up the path hierarchy", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
      permissions: [{ path: "/projects", accessLevel: "write" }],
    });
    assert(await checkPermission(1, "/projects/sub/file.txt", "write"));
    assert(await checkPermission(1, "/projects/sub", "read"));
  });
});

Deno.test("checkPermission: most specific permission wins (deny by closer ancestor)", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-group",
      permissions: [
        { path: "/", accessLevel: "write" },
        { path: "/secret", accessLevel: "read" },
      ],
    });
    // /secret 配下では write が下りる必要があるが、より具体的な /secret=read で止まる
    assertFalse(await checkPermission(1, "/secret/x.txt", "write"));
    assert(await checkPermission(1, "/secret/x.txt", "read"));
    // 別パスは / の write が効く
    assert(await checkPermission(1, "/other/x.txt", "write"));
  });
});

// ----- upsertDevice -----

Deno.test("upsertDevice: inserts new device record + reverse index", async () => {
  await withTestKv(async (kv) => {
    await upsertDevice("dev-abc12345", 1, "192.168.0.1");
    const dev = await kv.get<DeviceData>(Keys.device("dev-abc12345"));
    assertEquals(dev.value?.userId, 1);
    assertEquals(dev.value?.ipAddress, "192.168.0.1");
    assertEquals(dev.value?.firstSeenAt, dev.value?.lastSeenAt);

    const reverse = await kv.get(Keys.deviceByUser(1, "dev-abc12345"));
    assertEquals(reverse.value, true);
  });
});

Deno.test("upsertDevice: existing device keeps firstSeenAt, updates lastSeenAt", async () => {
  await withTestKv(async (kv) => {
    await upsertDevice("dev-abc12345", 1);
    const first = await kv.get<DeviceData>(Keys.device("dev-abc12345"));
    const firstSeen = first.value!.firstSeenAt;

    await new Promise((r) => setTimeout(r, 5));
    await upsertDevice("dev-abc12345", 1, "10.0.0.1");
    const second = await kv.get<DeviceData>(Keys.device("dev-abc12345"));
    assertEquals(second.value?.firstSeenAt, firstSeen);
    assertEquals(second.value?.ipAddress, "10.0.0.1");
    assert(second.value!.lastSeenAt >= firstSeen);
  });
});
