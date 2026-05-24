/**
 * /uploads/* (ADR-025) の責務をルート経由で観測する。
 *
 *   - POST /uploads は write lock holder の同一 device しか許可しない (403)。
 *   - PATCH /uploads/:id は任意 offset への書込みを反映する (random write の素通し)。
 *   - finalize で temp → 実 path に原子 rename され、ダウンロードで内容が取得できる。
 *   - abort で session が破棄される。
 *   - device mismatch (start と PATCH で別 deviceId) は 403。
 *
 * 注意: DATA_ROOT はモジュール初期化時に固定なので、`data/__test_uploads__/`
 * 配下に固定ディレクトリを切ってテスト用に使う。
 */
import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import app from "../src/app.ts";
import { acquireLock, releaseLock } from "../src/services/lock.service.ts";
import { createAppToken } from "../src/services/auth.service.ts";
import {
  _listSessionsForTesting,
  abortDeviceSessions,
  refreshDeviceSessions,
} from "../src/services/upload.service.ts";
import { seedUser, withTestKv } from "./_helpers.ts";
import { Keys } from "../src/kv/keys.ts";

const FIXTURE_DIR = "__test_uploads__";

interface Tokens {
  alice: string;
  bob: string;
}

async function setupUsers(kv: Deno.Kv): Promise<Tokens> {
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
  const a = await createAppToken(1, "alice");
  const b = await createAppToken(2, "bob");
  return { alice: a.raw, bob: b.raw };
}

async function ensureFixtureDir(): Promise<{ cleanup: () => Promise<void> }> {
  const root = path.join(Deno.cwd(), "data", FIXTURE_DIR);
  await Deno.mkdir(root, { recursive: true });
  return {
    cleanup: async () => {
      try {
        await Deno.remove(root, { recursive: true });
      } catch { /* ignore */ }
      // ADR-025: temp は DATA_ROOT 外側 (cwd/staging) に置く設計なので
      // テスト後に毎回掃除しておく。
      try {
        await Deno.remove(path.join(Deno.cwd(), "staging"), {
          recursive: true,
        });
      } catch { /* ignore */ }
    },
  };
}

function authHeaders(token: string, deviceId: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "X-Device-Id": deviceId,
  };
}

async function startUpload(
  token: string,
  deviceId: string,
  path_: string,
  baseFromExisting = false,
): Promise<{ status: number; uploadId?: string }> {
  const res = await app.fetch(
    new Request("http://localhost/uploads", {
      method: "POST",
      headers: {
        ...authHeaders(token, deviceId),
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: path_, baseFromExisting }),
    }),
  );
  if (res.status !== 201) {
    await res.body?.cancel();
    return { status: res.status };
  }
  const json = await res.json() as { uploadId: string };
  return { status: 201, uploadId: json.uploadId };
}

async function patchChunk(
  token: string,
  deviceId: string,
  uploadId: string,
  offset: number,
  data: Uint8Array,
): Promise<number> {
  const end = offset + data.length - 1;
  const res = await app.fetch(
    new Request(`http://localhost/uploads/${uploadId}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(token, deviceId),
        "Content-Range": `bytes ${offset}-${end}/*`,
      },
      body: data.slice().buffer,
    }),
  );
  await res.body?.cancel();
  return res.status;
}

async function finalize(
  token: string,
  deviceId: string,
  uploadId: string,
  size: number,
): Promise<{ status: number; size?: number }> {
  const res = await app.fetch(
    new Request(`http://localhost/uploads/${uploadId}/finalize`, {
      method: "POST",
      headers: {
        ...authHeaders(token, deviceId),
        "content-type": "application/json",
      },
      body: JSON.stringify({ size }),
    }),
  );
  if (res.status !== 200) {
    await res.body?.cancel();
    return { status: res.status };
  }
  const json = await res.json() as { size: number };
  return { status: 200, size: json.size };
}

async function downloadContent(
  token: string,
  deviceId: string,
  filePath: string,
): Promise<Uint8Array> {
  const res = await app.fetch(
    new Request(`http://localhost/content${filePath}`, {
      method: "GET",
      headers: authHeaders(token, deviceId),
    }),
  );
  assertEquals(res.status, 200);
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf;
}

Deno.test("POST /uploads: lock holder の同一 device は session を開ける", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/x.bin`;
    try {
      await acquireLock(target, 1, "dev-alice");
      const r = await startUpload(tokens.alice, "dev-alice", target);
      assertEquals(r.status, 201);
      assert(r.uploadId);
    } finally {
      await fx.cleanup();
    }
  });
});

Deno.test("POST /uploads: lock 不在では 403 (write lock 必須の責務)", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    try {
      const r = await startUpload(
        tokens.alice,
        "dev-alice",
        `/${FIXTURE_DIR}/y.bin`,
      );
      assertEquals(r.status, 403);
    } finally {
      await fx.cleanup();
    }
  });
});

Deno.test("POST /uploads: 他者がロック中なら 403", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/z.bin`;
    try {
      await acquireLock(target, 2, "dev-bob");
      const r = await startUpload(tokens.alice, "dev-alice", target);
      assertEquals(r.status, 403);
    } finally {
      await fx.cleanup();
    }
  });
});

Deno.test("PATCH random offset → finalize: 内容がそのまま反映される", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/random.bin`;
    try {
      await acquireLock(target, 1, "dev-alice");
      const start = await startUpload(tokens.alice, "dev-alice", target);
      assertEquals(start.status, 201);
      const id = start.uploadId!;

      // 順序を入れ替えて書く: 後ろを先、先頭は最後。pass-through 設計で
      // どの順で来てもサーバ temp file の seek+write が吸収するはず。
      assertEquals(
        await patchChunk(
          tokens.alice,
          "dev-alice",
          id,
          100,
          new Uint8Array([0xAA, 0xBB]),
        ),
        200,
      );
      assertEquals(
        await patchChunk(
          tokens.alice,
          "dev-alice",
          id,
          0,
          new Uint8Array([0x01, 0x02, 0x03]),
        ),
        200,
      );

      const fin = await finalize(tokens.alice, "dev-alice", id, 102);
      assertEquals(fin.status, 200);
      assertEquals(fin.size, 102);

      const got = await downloadContent(tokens.alice, "dev-alice", target);
      assertEquals(got.length, 102);
      assertEquals(Array.from(got.subarray(0, 3)), [0x01, 0x02, 0x03]);
      assertEquals(Array.from(got.subarray(100, 102)), [0xAA, 0xBB]);
      // 中間の sparse 領域は OS のファイルシステム挙動により 0 埋め (POSIX)。
      assertEquals(got[50], 0);
    } finally {
      await releaseLock(target, 1, "dev-alice");
      await fx.cleanup();
    }
  });
});

Deno.test("finalize size: 末尾切詰めが効く (ftruncate 相当)", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/trunc.bin`;
    try {
      await acquireLock(target, 1, "dev-alice");
      const start = await startUpload(tokens.alice, "dev-alice", target);
      const id = start.uploadId!;
      const big = new Uint8Array(200);
      big.fill(0x42);
      assertEquals(
        await patchChunk(tokens.alice, "dev-alice", id, 0, big),
        200,
      );

      // 100 bytes に切詰めて確定。
      const fin = await finalize(tokens.alice, "dev-alice", id, 100);
      assertEquals(fin.status, 200);
      assertEquals(fin.size, 100);

      const got = await downloadContent(tokens.alice, "dev-alice", target);
      assertEquals(got.length, 100);
    } finally {
      await releaseLock(target, 1, "dev-alice");
      await fx.cleanup();
    }
  });
});

Deno.test("DELETE /uploads/:id: abort で session が破棄される", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/cancel.bin`;
    try {
      await acquireLock(target, 1, "dev-alice");
      const start = await startUpload(tokens.alice, "dev-alice", target);
      const id = start.uploadId!;
      await patchChunk(
        tokens.alice,
        "dev-alice",
        id,
        0,
        new Uint8Array([1, 2, 3]),
      );

      const res = await app.fetch(
        new Request(`http://localhost/uploads/${id}`, {
          method: "DELETE",
          headers: authHeaders(tokens.alice, "dev-alice"),
        }),
      );
      await res.body?.cancel();
      assertEquals(res.status, 204);

      // abort 後の PATCH は 404 になる (session が見つからない)。
      const reuse = await patchChunk(
        tokens.alice,
        "dev-alice",
        id,
        0,
        new Uint8Array([9]),
      );
      assertEquals(reuse, 404);

      // 実 path には何も残っていない。
      const dl = await app.fetch(
        new Request(`http://localhost/content${target}`, {
          method: "GET",
          headers: authHeaders(tokens.alice, "dev-alice"),
        }),
      );
      await dl.body?.cancel();
      assertEquals(dl.status, 404);
    } finally {
      await releaseLock(target, 1, "dev-alice");
      await fx.cleanup();
    }
  });
});

Deno.test("PATCH: device mismatch は 403 (session は始めた device 専用)", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/owned.bin`;
    try {
      await acquireLock(target, 1, "dev-alice");
      const start = await startUpload(tokens.alice, "dev-alice", target);
      const id = start.uploadId!;

      // 同じユーザーでも別 device からは 403 (alice が別 PC から触る等)。
      const status = await patchChunk(
        tokens.alice,
        "dev-alice-other",
        id,
        0,
        new Uint8Array([1]),
      );
      assertEquals(status, 403);
    } finally {
      await releaseLock(target, 1, "dev-alice");
      await fx.cleanup();
    }
  });
});

Deno.test("abortDeviceSessions: 当該 device の全 session が消える (terminate 連動)", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    try {
      await acquireLock(`/${FIXTURE_DIR}/a.bin`, 1, "dev-alice");
      await acquireLock(`/${FIXTURE_DIR}/b.bin`, 1, "dev-alice");
      const a = await startUpload(
        tokens.alice,
        "dev-alice",
        `/${FIXTURE_DIR}/a.bin`,
      );
      const b = await startUpload(
        tokens.alice,
        "dev-alice",
        `/${FIXTURE_DIR}/b.bin`,
      );
      assert(a.uploadId && b.uploadId);

      assertEquals((await _listSessionsForTesting("dev-alice")).length, 2);

      const aborted = await abortDeviceSessions("dev-alice");
      assertEquals(aborted, 2);
      assertEquals((await _listSessionsForTesting("dev-alice")).length, 0);
    } finally {
      await fx.cleanup();
    }
  });
});

Deno.test("temp 領域は DATA_ROOT の外 (STAGING_ROOT) に置かれる: /tree や listDirectory に混じらない", async () => {
  // 構造的責務: ADR-025 の temp は cwd/staging/<id> (sibling of cwd/data)。
  // 中に入れる設計だと /tree, listDirectory, watchFs 全部でフィルタが要るうえ
  // Docker でボリューム永続化粒度を分けられない。外側に置けば全 API surface
  // で「filter する責務」自体が消える、というのが本テストの観測対象。
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/secret.bin`;
    try {
      await acquireLock(target, 1, "dev-alice");
      const start = await startUpload(tokens.alice, "dev-alice", target);
      const id = start.uploadId!;
      await patchChunk(
        tokens.alice,
        "dev-alice",
        id,
        0,
        new Uint8Array([1, 2, 3]),
      );

      // temp file は cwd/staging/<id> に存在し、cwd/data 配下には出ない。
      const tempPath = path.join(Deno.cwd(), "staging", id);
      const dataPollutedPath = path.join(Deno.cwd(), "data", "staging", id);
      assertEquals(
        (await Deno.stat(tempPath)).isFile,
        true,
        "temp file should live in cwd/staging/<id>",
      );
      let pollutedExists = false;
      try {
        await Deno.stat(dataPollutedPath);
        pollutedExists = true;
      } catch { /* expected */ }
      assertEquals(pollutedExists, false, "must not appear under data/");

      // /tree と listDirectory は DATA_ROOT を見るだけなので、構造的に
      // /staging* が混ざる経路がない。
      const tree = await app.fetch(
        new Request("http://localhost/tree", {
          headers: authHeaders(tokens.alice, "dev-alice"),
        }),
      );
      const entries = (await tree.json()) as Array<{ path: string }>;
      assertEquals(
        entries.filter((e) =>
          e.path.startsWith("/staging") ||
          e.path.startsWith("/uploads") ||
          e.path.startsWith("/.uploads")
        ).length,
        0,
      );

      const ls = await app.fetch(
        new Request("http://localhost/files/", {
          headers: authHeaders(tokens.alice, "dev-alice"),
        }),
      );
      const items = (await ls.json()) as Array<{ name: string }>;
      assertEquals(
        items.filter((i) =>
          i.name === "staging" || i.name === "uploads" || i.name === ".uploads"
        ).length,
        0,
      );
    } finally {
      await releaseLock(target, 1, "dev-alice");
      await fx.cleanup();
    }
  });
});

Deno.test("baseFromExisting=true: 既存ファイルを temp に複製してから session を始める (modify-in-place)", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/modify.txt`;
    try {
      // 既存ファイルを置く。
      await Deno.writeFile(
        path.join(Deno.cwd(), "data", FIXTURE_DIR, "modify.txt"),
        new Uint8Array([0x10, 0x20, 0x30, 0x40, 0x50]),
      );
      await acquireLock(target, 1, "dev-alice");

      const start = await startUpload(
        tokens.alice,
        "dev-alice",
        target,
        /* baseFromExisting */ true,
      );
      assertEquals(start.status, 201);
      const id = start.uploadId!;

      // 中央 1 byte だけ書き換えて finalize。base が複製されているので
      // 他の byte は元のまま残るはず (modify-in-place の責務)。
      assertEquals(
        await patchChunk(
          tokens.alice,
          "dev-alice",
          id,
          2,
          new Uint8Array([0xFF]),
        ),
        200,
      );
      const fin = await finalize(tokens.alice, "dev-alice", id, 5);
      assertEquals(fin.status, 200);

      const got = await downloadContent(tokens.alice, "dev-alice", target);
      assertEquals(Array.from(got), [0x10, 0x20, 0xFF, 0x40, 0x50]);
    } finally {
      await releaseLock(target, 1, "dev-alice");
      await fx.cleanup();
    }
  });
});

Deno.test("refreshDeviceSessions: alive marker の TTL を延長する (heartbeat 連動)", async () => {
  await withTestKv(async (kv) => {
    const tokens = await setupUsers(kv);
    const fx = await ensureFixtureDir();
    const target = `/${FIXTURE_DIR}/hb.bin`;
    try {
      await acquireLock(target, 1, "dev-alice");
      const start = await startUpload(tokens.alice, "dev-alice", target);
      assert(start.uploadId);

      // TTL 延長は Deno KV の expireIn 更新で行うため、外から残り時間は
      // 観測できない。代わりに alive marker (Keys.uploadByDevice) を再 set
      // した結果として versionstamp が advance することを検証する。
      const aliveKey = Keys.uploadByDevice("dev-alice", start.uploadId);
      const before = await kv.get(aliveKey);
      assert(
        before.versionstamp !== null,
        "alive marker should exist after startUpload",
      );

      const refreshed = await refreshDeviceSessions("dev-alice");
      assertEquals(refreshed, 1);

      const after = await kv.get(aliveKey);
      assert(
        after.versionstamp !== null,
        "alive marker should still exist after refresh",
      );
      assert(
        after.versionstamp !== before.versionstamp,
        "alive marker versionstamp should change after re-set",
      );
    } finally {
      await releaseLock(target, 1, "dev-alice");
      await fx.cleanup();
    }
  });
});
