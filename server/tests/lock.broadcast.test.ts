/**
 * lock.service と wsBroadcast.service の連携責務をテストする:
 *   - 新規取得 → lock_acquired emit
 *   - 同一 deviceId による renew → broadcast しない (帯域節約)
 *   - 取り戻し (同一 user, 別 deviceId) → lock_acquired emit
 *   - release → lock_released emit
 *   - releaseDeviceLocks → 解除した各ファイル分の lock_released emit
 */
import { assert, assertEquals } from "@std/assert";
import {
  acquireLock,
  releaseDeviceLocks,
  releaseLock,
} from "../src/services/lock.service.ts";
import { registerSocket } from "../src/services/wsBroadcast.service.ts";
import { seedUser, withTestKv } from "./_helpers.ts";

interface SentMsg {
  event: string;
  path: string;
  holder?: { userId: number; deviceId: string; name: string };
}

class FakeSocket {
  readyState = WebSocket.OPEN;
  sent: SentMsg[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

async function setupListener(kv: Deno.Kv): Promise<FakeSocket> {
  // listener はフルアクセスを持つ別 user として置く (ホルダーと別人)。
  await seedUser(kv, {
    userId: 100,
    userName: "listener",
    groupId: 100,
    groupName: "listener-g",
    permissions: [{ path: "/", accessLevel: "read" }],
  });
  // ホルダーの user 名解決用 (ADR-019 holder.name)
  await seedUser(kv, {
    userId: 1,
    userName: "alice",
    groupId: 10,
    groupName: "alice-g",
    permissions: [{ path: "/", accessLevel: "write" }],
  });

  const sock = new FakeSocket();
  registerSocket({
    socket: sock as unknown as WebSocket,
    userId: 100,
    deviceId: "dev-listener",
  });
  return sock;
}

// broadcast 呼び出しは fire-and-forget なので、microtask を進めて配信完了を待つ。
const flush = () => new Promise((r) => setTimeout(r, 10));

Deno.test("lock.service: new acquire emits lock_acquired", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    await acquireLock("/foo.txt", 1, "dev-alice");
    await flush();

    assertEquals(sock.sent.length, 1);
    assertEquals(sock.sent[0].event, "lock_acquired");
    assertEquals(sock.sent[0].path, "/foo.txt");
    assertEquals(sock.sent[0].holder?.deviceId, "dev-alice");
  });
});

Deno.test("lock.service: renew (same user same device) does NOT emit", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    await acquireLock("/foo.txt", 1, "dev-alice");
    await flush();
    sock.sent.length = 0; // 初回 acquire の broadcast を捨てる

    // 同じ deviceId で再 acquire = renew → broadcast 抑止
    await acquireLock("/foo.txt", 1, "dev-alice");
    await flush();
    assertEquals(sock.sent.length, 0);
  });
});

Deno.test("lock.service: takeover (same user different device) emits lock_acquired", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    await acquireLock("/foo.txt", 1, "dev-alice-pc");
    await flush();
    sock.sent.length = 0;

    await acquireLock("/foo.txt", 1, "dev-alice-laptop");
    await flush();
    assertEquals(sock.sent.length, 1);
    assertEquals(sock.sent[0].event, "lock_acquired");
    assertEquals(sock.sent[0].holder?.deviceId, "dev-alice-laptop");
  });
});

Deno.test("lock.service: rejected acquire (different user) does NOT emit", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    await acquireLock("/foo.txt", 1, "dev-alice");
    await flush();
    sock.sent.length = 0;

    // bob が取りに来るが拒否される → broadcast なし
    await seedUser(kv, {
      userId: 2,
      userName: "bob",
      groupId: 20,
      groupName: "bob-g",
    });
    const result = await acquireLock("/foo.txt", 2, "dev-bob");
    await flush();

    assertEquals(result.success, false);
    assertEquals(sock.sent.length, 0);
  });
});

Deno.test("lock.service: release emits lock_released", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    await acquireLock("/foo.txt", 1, "dev-alice");
    await flush();
    sock.sent.length = 0;

    await releaseLock("/foo.txt", 1, "dev-alice");
    await flush();
    assertEquals(sock.sent.length, 1);
    assertEquals(sock.sent[0].event, "lock_released");
    assertEquals(sock.sent[0].path, "/foo.txt");
  });
});

Deno.test("lock.service: failed release (different user) does NOT emit", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    await seedUser(kv, {
      userId: 2,
      userName: "bob",
      groupId: 20,
      groupName: "bob-g",
    });
    await acquireLock("/foo.txt", 1, "dev-alice");
    await flush();
    sock.sent.length = 0;

    const ok = await releaseLock("/foo.txt", 2, "dev-bob");
    await flush();
    assertEquals(ok, false);
    assertEquals(sock.sent.length, 0);
  });
});

Deno.test("lock.service: releaseDeviceLocks emits one lock_released per file", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    await acquireLock("/a.txt", 1, "dev-alice");
    await acquireLock("/b.txt", 1, "dev-alice");
    await acquireLock("/c.txt", 1, "dev-alice");
    await flush();
    sock.sent.length = 0;

    const released = await releaseDeviceLocks("dev-alice");
    await flush();
    assertEquals(released, 3);
    assertEquals(sock.sent.length, 3);
    assert(sock.sent.every((m) => m.event === "lock_released"));
    const paths = sock.sent.map((m) => m.path).sort();
    assertEquals(paths, ["/a.txt", "/b.txt", "/c.txt"]);
  });
});
