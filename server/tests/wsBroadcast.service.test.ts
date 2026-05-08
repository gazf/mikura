import { assertEquals } from "@std/assert";
import {
  broadcastFileEvent,
  broadcastLockEvent,
  registerSocket,
  unregisterSocket,
} from "../src/services/wsBroadcast.service.ts";
import { seedUser, withTestKv } from "./_helpers.ts";

interface SentMsg {
  event: string;
  path: string;
  type?: string;
  size?: number;
  lastModified?: string;
  originatorDeviceId?: string;
  holder?: { userId: number; deviceId: string; name: string };
}

class FakeSocket {
  readyState = WebSocket.OPEN;
  sent: SentMsg[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}

function fakeSocket(): WebSocket {
  return new FakeSocket() as unknown as WebSocket;
}

// ----- register / unregister: 責務 = peer 集合の正しい管理 -----

Deno.test("register/unregister: peers are tracked individually", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 2,
      userName: "bob",
      groupId: 20,
      groupName: "g",
      permissions: [{ path: "/", accessLevel: "read" }],
    });
    const a = { socket: fakeSocket(), userId: 1, deviceId: "dev-aaaaaaaa" };
    const b = { socket: fakeSocket(), userId: 2, deviceId: "dev-bbbbbbbb" };
    registerSocket(a);
    registerSocket(b);
    unregisterSocket(a);
    // a を抜いた後の broadcast は b にだけ届くこと
    await broadcastLockEvent("lock_acquired", "/x", {
      userId: 99,
      deviceId: "dev-xxxxxxxx",
    });
    assertEquals((a.socket as unknown as FakeSocket).sent.length, 0);
    assertEquals((b.socket as unknown as FakeSocket).sent.length, 1);
  });
});

// ----- broadcast: 認可フィルタが効くこと -----

Deno.test("broadcast: peers without read permission do not receive", async () => {
  await withTestKv(async (kv) => {
    // alice は /public 配下のみ read 可。bob は /private のみ read 可
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-g",
      permissions: [{ path: "/public", accessLevel: "read" }],
    });
    await seedUser(kv, {
      userId: 2,
      userName: "bob",
      groupId: 20,
      groupName: "bob-g",
      permissions: [{ path: "/private", accessLevel: "read" }],
    });

    const alice = { socket: fakeSocket(), userId: 1, deviceId: "dev-aaaaaaaa" };
    const bob = { socket: fakeSocket(), userId: 2, deviceId: "dev-bbbbbbbb" };
    registerSocket(alice);
    registerSocket(bob);

    await broadcastLockEvent("lock_acquired", "/private/secret.txt", {
      userId: 99,
      deviceId: "dev-xxxxxxxx",
    });

    // alice は read 権限なし → 受信しない
    assertEquals((alice.socket as unknown as FakeSocket).sent.length, 0);
    // bob は read 権限あり → 1 件受信
    assertEquals((bob.socket as unknown as FakeSocket).sent.length, 1);
  });
});

Deno.test("broadcast: closed sockets are skipped without error", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "g",
      permissions: [{ path: "/", accessLevel: "read" }],
    });

    const aliveSocket = new FakeSocket();
    const closedSocket = new FakeSocket();
    closedSocket.close();

    registerSocket({
      socket: aliveSocket as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-1",
    });
    registerSocket({
      socket: closedSocket as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-2",
    });

    await broadcastLockEvent("lock_released", "/x.txt", {
      userId: 99,
      deviceId: "dev-xxxxxxxx",
    });

    assertEquals(aliveSocket.sent.length, 1);
    assertEquals(closedSocket.sent.length, 0);
  });
});

// ----- broadcast: ペイロード構造がプロトコル仕様と一致 -----

Deno.test("broadcast: payload contains event/path/holder with resolved name", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "g",
      permissions: [{ path: "/", accessLevel: "read" }],
    });
    // ホルダー (userId=99) のユーザー名を解決させるため User レコードを置く
    await kv.set(
      ["users", 99],
      {
        id: 99,
        name: "holder-user",
        passwordHash: "x",
        createdAt: "2026-01-01",
      },
    );

    const peer = new FakeSocket();
    registerSocket({
      socket: peer as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-1",
    });

    await broadcastLockEvent("lock_acquired", "/foo.txt", {
      userId: 99,
      deviceId: "dev-holder-xxxx",
    });

    assertEquals(peer.sent.length, 1);
    const msg = peer.sent[0];
    assertEquals(msg.event, "lock_acquired");
    assertEquals(msg.path, "/foo.txt");
    assertEquals(msg.holder?.userId, 99);
    assertEquals(msg.holder?.deviceId, "dev-holder-xxxx");
    assertEquals(msg.holder?.name, "holder-user");
  });
});

Deno.test("broadcast: unknown user falls back to user#<id>", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "g",
      permissions: [{ path: "/", accessLevel: "read" }],
    });
    // ホルダーは KV に記録なし

    const peer = new FakeSocket();
    registerSocket({
      socket: peer as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-1",
    });

    await broadcastLockEvent("lock_acquired", "/foo.txt", {
      userId: 999,
      deviceId: "dev-orphan",
    });
    assertEquals(peer.sent[0].holder?.name, "user#999");
  });
});

// ----- broadcast: 0 peer のときに早期リターンできる (no-op) -----

Deno.test("broadcast: no peers does not throw", async () => {
  await withTestKv(async () => {
    await broadcastLockEvent("lock_acquired", "/x", {
      userId: 1,
      deviceId: "d",
    });
    // 例外ゼロで返ってくれば OK
  });
});

// ----- broadcast: 自端末を除外する (#1: originator は自分の event を受け取らない) -----

Deno.test("broadcastLockEvent: holder.deviceId と一致する peer は除外される", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "g",
      permissions: [{ path: "/", accessLevel: "read" }],
    });

    // 同一 user が 2 端末 (holder と他端末) で接続している状態を想定。
    const holderSock = new FakeSocket();
    const otherSock = new FakeSocket();
    registerSocket({
      socket: holderSock as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-holder",
    });
    registerSocket({
      socket: otherSock as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-other",
    });

    await broadcastLockEvent("lock_acquired", "/foo.txt", {
      userId: 1,
      deviceId: "dev-holder",
    });

    // holder は自分が起こした event を受け取らない。
    assertEquals(holderSock.sent.length, 0);
    // 別端末 (read 権限あり) は受け取る。
    assertEquals(otherSock.sent.length, 1);
  });
});

Deno.test("broadcastFileEvent: originatorDeviceId と一致する peer は除外される + payload に originatorDeviceId が載る", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "g",
      permissions: [{ path: "/", accessLevel: "read" }],
    });

    const originSock = new FakeSocket();
    const otherSock = new FakeSocket();
    registerSocket({
      socket: originSock as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-origin",
    });
    registerSocket({
      socket: otherSock as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-other",
    });

    await broadcastFileEvent(
      "modified",
      "/foo.txt",
      { type: "file", size: 42, lastModified: "2026-01-01T00:00:00Z" },
      "dev-origin",
    );

    // 自端末は受け取らない。
    assertEquals(originSock.sent.length, 0);
    // 他端末は受け取り、payload には originatorDeviceId が載る (client 側 defense-in-depth)。
    assertEquals(otherSock.sent.length, 1);
    assertEquals(otherSock.sent[0].originatorDeviceId, "dev-origin");
  });
});

Deno.test("broadcastFileEvent: originatorDeviceId 未指定時 (watcher 経由想定) は全 peer に配信し payload にも載らない", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "g",
      permissions: [{ path: "/", accessLevel: "read" }],
    });

    const a = new FakeSocket();
    const b = new FakeSocket();
    registerSocket({
      socket: a as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-a",
    });
    registerSocket({
      socket: b as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-b",
    });

    await broadcastFileEvent("modified", "/x.txt", {
      type: "file",
      size: 1,
      lastModified: "2026-01-01T00:00:00Z",
    });

    assertEquals(a.sent.length, 1);
    assertEquals(b.sent.length, 1);
    assertEquals(a.sent[0].originatorDeviceId, undefined);
  });
});
