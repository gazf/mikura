/**
 * file.service と upload.service が API 経由のファイル変更で
 * broadcastFileEvent を発火する責務をテストする:
 *   - renameEntry: 旧 path の deleted + 新 path の created を発火する
 *     (Deno.watchFs の rename 取りこぼし対策、実機回帰の防止)
 *   - finalizeSession: 確定 path の modified を発火する
 *     (staging→storage の rename を別 client に伝える)
 */
import { assertEquals } from "@std/assert";
import * as path from "@std/path";
import {
  createFolder,
  deleteFile,
  renameEntry,
  writeFile,
} from "../src/services/file.service.ts";
import {
  createSession,
  finalizeSession,
  writeChunk,
} from "../src/services/upload.service.ts";
import { acquireLock } from "../src/services/lock.service.ts";
import { registerSocket } from "../src/services/wsBroadcast.service.ts";
import { seedUser, withTestKv } from "./_helpers.ts";

const FIXTURE_DIR = "__test_file_broadcast__";

interface SentMsg {
  event: string;
  path: string;
  type?: string;
  size?: number;
  lastModified?: string;
}

class FakeSocket {
  readyState = WebSocket.OPEN;
  sent: SentMsg[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
}

async function setupListener(kv: Deno.Kv): Promise<FakeSocket> {
  // 別 user listener (read 権限) + 操作する側の alice (write 権限)。
  await seedUser(kv, {
    userId: 100,
    userName: "listener",
    groupId: 100,
    groupName: "listener-g",
    permissions: [{ path: "/", accessLevel: "read" }],
  });
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

async function ensureFixtureDir(): Promise<{ cleanup: () => Promise<void> }> {
  const root = path.join(Deno.cwd(), "data", FIXTURE_DIR);
  await Deno.mkdir(root, { recursive: true });
  return {
    cleanup: async () => {
      try {
        await Deno.remove(root, { recursive: true });
      } catch { /* ignore */ }
      try {
        await Deno.remove(path.join(Deno.cwd(), "staging"), {
          recursive: true,
        });
      } catch { /* ignore */ }
    },
  };
}

// broadcast は fire-and-forget なので microtask を流す。
const flush = () => new Promise((r) => setTimeout(r, 10));

Deno.test("renameEntry: 旧 path deleted + 新 path created を broadcast (rename 取りこぼし対策)", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    const fx = await ensureFixtureDir();
    try {
      const src = `/${FIXTURE_DIR}/old.bin`;
      const dst = `/${FIXTURE_DIR}/new.bin`;
      await Deno.writeFile(
        path.join(Deno.cwd(), "data", FIXTURE_DIR, "old.bin"),
        new Uint8Array([1, 2, 3]),
      );

      sock.sent.length = 0; // setup ぶんを捨てる
      await renameEntry(src, dst);
      await flush();

      // 旧 path の deleted と 新 path の created の 2 イベント。
      const deleted = sock.sent.find((m) => m.event === "deleted");
      const created = sock.sent.find((m) => m.event === "created");
      assertEquals(deleted?.path, src);
      assertEquals(created?.path, dst);
      assertEquals(created?.type, "file");
      assertEquals(created?.size, 3);
    } finally {
      await fx.cleanup();
    }
  });
});

Deno.test("writeFile (legacy single PUT): modified を broadcast", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/put.bin`;
    try {
      sock.sent.length = 0;
      const data = new Uint8Array([7, 8, 9]);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(data);
          c.close();
        },
      });
      await writeFile(target, stream);
      await flush();

      const modified = sock.sent.find((m) => m.event === "modified");
      assertEquals(modified?.path, target);
      assertEquals(modified?.size, 3);
    } finally {
      await fx.cleanup();
    }
  });
});

Deno.test("deleteFile: deleted を broadcast", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/del.bin`;
    try {
      await Deno.writeFile(
        path.join(Deno.cwd(), "data", FIXTURE_DIR, "del.bin"),
        new Uint8Array([1]),
      );
      sock.sent.length = 0;
      await deleteFile(target);
      await flush();

      const deleted = sock.sent.find((m) => m.event === "deleted");
      assertEquals(deleted?.path, target);
    } finally {
      await fx.cleanup();
    }
  });
});

Deno.test("createFolder: directory created を broadcast", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/subdir`;
    try {
      sock.sent.length = 0;
      await createFolder(target);
      await flush();

      const created = sock.sent.find((m) => m.event === "created");
      assertEquals(created?.path, target);
      assertEquals(created?.type, "directory");
    } finally {
      await fx.cleanup();
    }
  });
});

Deno.test("originator 端末は自身の操作 broadcast を受け取らない (#1 回帰防止)", async () => {
  await withTestKv(async (kv) => {
    // 自分自身も WSS 接続している状態 — listener は別端末。
    await seedUser(kv, {
      userId: 100,
      userName: "listener",
      groupId: 100,
      groupName: "listener-g",
      permissions: [{ path: "/", accessLevel: "read" }],
    });
    await seedUser(kv, {
      userId: 1,
      userName: "alice",
      groupId: 10,
      groupName: "alice-g",
      permissions: [{ path: "/", accessLevel: "write" }],
    });
    const listenerSock = new FakeSocket();
    const aliceSock = new FakeSocket();
    registerSocket({
      socket: listenerSock as unknown as WebSocket,
      userId: 100,
      deviceId: "dev-listener",
    });
    registerSocket({
      socket: aliceSock as unknown as WebSocket,
      userId: 1,
      deviceId: "dev-alice",
    });

    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/originator.bin`;
    try {
      // 1) writeFile (originator=dev-alice): alice は受け取らない、listener は受け取る。
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array([1, 2, 3]));
          c.close();
        },
      });
      await writeFile(target, stream, "dev-alice");
      await flush();
      assertEquals(
        aliceSock.sent.find((m) => m.event === "modified"),
        undefined,
      );
      assertEquals(
        listenerSock.sent.find((m) => m.event === "modified")?.path,
        target,
      );

      // 2) deleteFile (originator=dev-alice): 同上。
      aliceSock.sent.length = 0;
      listenerSock.sent.length = 0;
      await deleteFile(target, "dev-alice");
      await flush();
      assertEquals(
        aliceSock.sent.find((m) => m.event === "deleted"),
        undefined,
      );
      assertEquals(
        listenerSock.sent.find((m) => m.event === "deleted")?.path,
        target,
      );

      // 3) createFolder (originator=dev-alice): 同上。
      const dirTarget = `/${FIXTURE_DIR}/originator-dir`;
      aliceSock.sent.length = 0;
      listenerSock.sent.length = 0;
      await createFolder(dirTarget, "dev-alice");
      await flush();
      assertEquals(
        aliceSock.sent.find((m) => m.event === "created"),
        undefined,
      );
      assertEquals(
        listenerSock.sent.find((m) => m.event === "created")?.path,
        dirTarget,
      );
    } finally {
      await fx.cleanup();
    }
  });
});

Deno.test("finalizeSession: 確定 path の modified を broadcast (staging→storage rename)", async () => {
  await withTestKv(async (kv) => {
    const sock = await setupListener(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/uploaded.bin`;
    try {
      await acquireLock(target, 1, "dev-alice");
      const session = await createSession(target, 1, "dev-alice");
      const data = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD]);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(data);
          c.close();
        },
      });
      await writeChunk(session.uploadId, "dev-alice", 0, stream);

      sock.sent.length = 0; // setup ぶんを捨てる
      await finalizeSession(session.uploadId, "dev-alice", 4);
      await flush();

      const modified = sock.sent.find((m) => m.event === "modified");
      assertEquals(modified?.path, target);
      assertEquals(modified?.type, "file");
      assertEquals(modified?.size, 4);
    } finally {
      await fx.cleanup();
    }
  });
});
