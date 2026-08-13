/**
 * ADR-035 がファイル系ルートに与える変化:
 *   - /tree と /files のディレクトリ一覧は「名前だけ見える」ノードも返す。これが
 *     無いと /alice/docs への grant は /alice が不可視で到達できず死ぬ
 *   - 権限の無い兄弟は名前ごと消える (= Access-Based Enumeration)
 *   - ルールが名前を挙げているパスは rename / delete を拒否する (409)
 *
 * 注意: DATA_ROOT は file.service.ts の import 時に固定されるため、既定の
 * `<cwd>/data/` 配下に実ファイルを一時生成して動かす。
 */
import { assert, assertEquals } from "@std/assert";
import * as path from "@std/path";
import app from "../src/app.ts";
import { createAppToken } from "../src/services/auth.service.ts";
import { seedUser, withTestKv } from "./_helpers.ts";

const FIXTURE = "__test_policy_files__";
const DEVICE = "dev-policy-000000000000001";

async function setupFixture(): Promise<() => Promise<void>> {
  const root = path.join(Deno.cwd(), "data", FIXTURE);
  await Deno.mkdir(path.join(root, "docs"), { recursive: true });
  await Deno.mkdir(path.join(root, "private"), { recursive: true });
  await Deno.mkdir(path.join(root, "pinned"), { recursive: true });
  await Deno.writeTextFile(path.join(root, "docs", "note.txt"), "note");
  await Deno.writeTextFile(path.join(root, "private", "secret.txt"), "secret");
  return async () => {
    try {
      await Deno.remove(root, { recursive: true });
    } catch { /* ignore */ }
  };
}

function authReq(
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Request {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Device-Id": DEVICE,
    },
  };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] =
      "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

interface TreeNode {
  path: string;
}

Deno.test("/tree: grant の祖先は名前だけ返り、兄弟は消える", async () => {
  const cleanup = await setupFixture();
  try {
    await withTestKv(async (kv) => {
      await seedUser(kv, {
        userId: 1,
        userName: "alice",
        permissions: [{ path: `/${FIXTURE}/docs`, accessLevel: "read" }],
      });
      const token = (await createAppToken(1, "alice")).raw;

      const res = await app.fetch(
        authReq("GET", "http://localhost/tree", token),
      );
      assertEquals(res.status, 200);
      const paths = ((await res.json()) as TreeNode[]).map((n) => n.path);

      // 祖先は到達のために見える
      assert(paths.includes(`/${FIXTURE}`));
      // grant 本体とその中身は見える
      assert(paths.includes(`/${FIXTURE}/docs`));
      assert(paths.includes(`/${FIXTURE}/docs/note.txt`));
      // 兄弟は名前ごと消える
      assert(!paths.some((p) => p.startsWith(`/${FIXTURE}/private`)));
    });
  } finally {
    await cleanup();
  }
});

Deno.test("/files: 名前だけ見えるディレクトリは開けるが、中身は可視分だけ", async () => {
  const cleanup = await setupFixture();
  try {
    await withTestKv(async (kv) => {
      await seedUser(kv, {
        userId: 1,
        userName: "alice",
        permissions: [{ path: `/${FIXTURE}/docs`, accessLevel: "read" }],
      });
      const token = (await createAppToken(1, "alice")).raw;

      const res = await app.fetch(
        authReq("GET", `http://localhost/files/${FIXTURE}`, token),
      );
      assertEquals(res.status, 200);
      const names = ((await res.json()) as Array<{ name: string }>)
        .map((e) => e.name);
      assertEquals(names, ["docs"]);

      // 不可視ディレクトリ自体は開けない
      const denied = await app.fetch(
        authReq("GET", `http://localhost/files/${FIXTURE}/private`, token),
      );
      assertEquals(denied.status, 403);
    });
  } finally {
    await cleanup();
  }
});

Deno.test("/files: 名前だけ見えるパスでもファイル本体の読み出しは 403", async () => {
  const cleanup = await setupFixture();
  try {
    await withTestKv(async (kv) => {
      await seedUser(kv, {
        userId: 1,
        userName: "alice",
        permissions: [{ path: `/${FIXTURE}/docs`, accessLevel: "read" }],
      });
      const token = (await createAppToken(1, "alice")).raw;
      const res = await app.fetch(
        authReq(
          "GET",
          `http://localhost/content/${FIXTURE}/private/secret.txt`,
          token,
        ),
      );
      assertEquals(res.status, 403);
    });
  } finally {
    await cleanup();
  }
});

Deno.test("DELETE /files: ルールが名前を挙げているパスは 409 (write を持っていても)", async () => {
  const cleanup = await setupFixture();
  try {
    await withTestKv(async (kv) => {
      await seedUser(kv, {
        userId: 1,
        userName: "alice",
        permissions: [
          { path: "/", accessLevel: "write" },
          { path: `/${FIXTURE}/pinned`, accessLevel: "write" },
        ],
      });
      const token = (await createAppToken(1, "alice")).raw;

      const res = await app.fetch(
        authReq("DELETE", `http://localhost/files/${FIXTURE}/pinned`, token),
      );
      assertEquals(res.status, 409);
      assert((await res.json()).message.includes("アクセス制御ルール"));

      // 配下には伝播しない — 中身は通常の権限で消せる
      const inner = await app.fetch(
        authReq(
          "DELETE",
          `http://localhost/files/${FIXTURE}/docs/note.txt`,
          token,
        ),
      );
      assertEquals(inner.status, 200);
    });
  } finally {
    await cleanup();
  }
});

Deno.test("PATCH /files: ルール保持パスの rename は 409 (削除して作り直す抜け道も塞ぐ)", async () => {
  const cleanup = await setupFixture();
  try {
    await withTestKv(async (kv) => {
      await seedUser(kv, {
        userId: 1,
        userName: "alice",
        permissions: [
          { path: "/", accessLevel: "write" },
          { path: `/${FIXTURE}/pinned`, accessLevel: "write" },
        ],
      });
      const token = (await createAppToken(1, "alice")).raw;

      const res = await app.fetch(
        authReq("PATCH", `http://localhost/files/${FIXTURE}/pinned`, token, {
          newPath: `/${FIXTURE}/renamed`,
        }),
      );
      assertEquals(res.status, 409);

      // 祖先も上向きに固定される
      const ancestor = await app.fetch(
        authReq("PATCH", `http://localhost/files/${FIXTURE}`, token, {
          newPath: `/${FIXTURE}-moved`,
        }),
      );
      assertEquals(ancestor.status, 409);
    });
  } finally {
    await cleanup();
  }
});
