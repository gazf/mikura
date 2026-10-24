import { assertEquals } from "@std/assert";
import {
  broadcastFileEvent,
  broadcastLockEvent,
  isRegisteredPeer,
  type Peer,
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
  closeCode: number | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.readyState = WebSocket.CLOSED;
    this.closeCode = code;
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
      permissions: [{ path: "/public", accessLevel: "read" }],
    });
    await seedUser(kv, {
      userId: 2,
      userName: "bob",
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

// ----- 同一 deviceId の二重接続 (issue #13) -----
//
// heartbeat / terminate は deviceId 単位で lock と upload session を触るので、
// 同じ deviceId で 2 本目が張られると「2 本目が閉じる・terminate を送る」だけで
// 1 本目の作業を壊せる。正規クライアントは単一インスタンス mutex で 2 本張らない
// ため、この状況そのものが token 複製の signal でもある。
// 責務 = 「生きている 1 本目を守りつつ、正規の再接続は妨げない」。

Deno.test("registerSocket: 生きている同一 deviceId の 2 本目を拒否し、1 本目を残す", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      permissions: [{ path: "/", accessLevel: "read" }],
    });

    const first: Peer = { socket: fakeSocket(), userId: 1, deviceId: "dev-1" };
    const second: Peer = { socket: fakeSocket(), userId: 1, deviceId: "dev-1" };

    assertEquals(registerSocket(first), { ok: true });
    assertEquals(registerSocket(second), {
      ok: false,
      reason: "duplicate_device",
    });

    // 1 本目だけが登録されている = deviceId 単位の副作用を実行できるのは 1 本目のみ。
    assertEquals(isRegisteredPeer(first), true);
    assertEquals(isRegisteredPeer(second), false);

    // 配信先としても 1 本目が生きていること。
    await broadcastFileEvent("created", "/a.txt", {
      type: "file",
      size: 1,
      lastModified: "2026-01-01T00:00:00.000Z",
    });
    assertEquals((first.socket as unknown as FakeSocket).sent.length, 1);
  });
});

Deno.test("unregisterSocket: 拒否された 2 本目の close が 1 本目を道連れにしない", async () => {
  await withTestKv(async (kv) => {
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      permissions: [{ path: "/", accessLevel: "read" }],
    });

    const first: Peer = { socket: fakeSocket(), userId: 1, deviceId: "dev-1" };
    const second: Peer = { socket: fakeSocket(), userId: 1, deviceId: "dev-1" };
    registerSocket(first);
    registerSocket(second);

    // 2 本目の socket が閉じたときの後始末。deviceId ではなく identity で
    // 引き当てるので、1 本目の登録は残らなければならない (回帰テスト)。
    unregisterSocket(second);

    assertEquals(isRegisteredPeer(first), true);
    await broadcastFileEvent("deleted", "/a.txt");
    assertEquals((first.socket as unknown as FakeSocket).sent.length, 1);
  });
});

Deno.test("registerSocket: heartbeat が途絶えた peer は置き換える (正規の再接続を妨げない)", async () => {
  // half-open TCP では server 側の socket が OPEN のまま残る。無条件に 2 本目を
  // 拒否すると、一瞬の回線切断が長時間の接続不能に化ける。
  await withTestKv(() => {
    const stale: Peer = { socket: fakeSocket(), userId: 1, deviceId: "dev-1" };
    registerSocket(stale);
    stale.lastSeenMs = Date.now() - 60_000;

    const reconnected: Peer = {
      socket: fakeSocket(),
      userId: 1,
      deviceId: "dev-1",
    };
    assertEquals(registerSocket(reconnected), { ok: true });

    assertEquals(isRegisteredPeer(reconnected), true);
    assertEquals(isRegisteredPeer(stale), false);
    // 置き換えた側で古い socket を閉じる (放置すると fd が残る)。
    assertEquals((stale.socket as unknown as FakeSocket).closeCode, 4409);
  });
});

Deno.test("registerSocket: 既に閉じている peer は heartbeat が新しくても置き換える", async () => {
  await withTestKv(() => {
    const closed: Peer = { socket: fakeSocket(), userId: 1, deviceId: "dev-1" };
    registerSocket(closed);
    closed.socket.close();

    const reconnected: Peer = {
      socket: fakeSocket(),
      userId: 1,
      deviceId: "dev-1",
    };
    assertEquals(registerSocket(reconnected), { ok: true });
    assertEquals(isRegisteredPeer(reconnected), true);
  });
});
