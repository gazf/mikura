import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  checkPermission,
  createAppToken,
  hashToken,
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
