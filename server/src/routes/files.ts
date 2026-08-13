import { Hono } from "hono";
import {
  createFolder,
  deleteFile,
  FileServiceError,
  getFileInfo,
  getTree,
  getVolumeStats,
  listDirectory,
  readFile,
  renameEntry,
  statFile,
  writeFile,
} from "../services/file.service.ts";
import { checkPermission } from "../services/auth.service.ts";
import { getAllLocks, isLockedByOther } from "../services/lock.service.ts";
import type { AuthUser } from "../services/auth.service.ts";
import { getActivePolicy } from "../services/policy.service.ts";
import { isPinnedPath, rulesAnchoredAt } from "../policy/evaluate.ts";

type Env = {
  Variables: {
    user: AuthUser;
  };
};

/**
 * ADR-035: ルールが名前を挙げているパスは rename / delete を拒否する。
 * 中身は対象外で通常の権限に従う。禁じるのは「ルールが宙に浮く」変更だけ。
 *
 * これはシステム内で唯一の **構造的な制約** であって権限ではない。したがって
 * 付与レベルと矛盾しうる (`allow write /shared` は削除を含むのに `/shared`
 * 自体は消せない)。この種の制約を 1 つに保つことが「なぜか動かないし誰にも
 * 分からない」体験を避ける条件になっている。
 *
 * 拒否理由は 409 の message に載せるが、WinFsp は NTSTATUS しか返せないので
 * Explorer にはアクセス拒否としてしか届かない。コンソールの 📌 表示と、
 * 将来のトレイ通知が本来の伝達経路。
 */
async function describePin(path: string): Promise<string | null> {
  const policy = await getActivePolicy();
  if (!isPinnedPath(policy, path)) return null;
  const anchored = rulesAnchoredAt(policy, path);
  const detail = anchored.length > 0
    ? `${anchored.map((a) => a.role).join(", ")} のルールが参照しています`
    : "配下のルールが参照しています";
  return `${path} はアクセス制御ルールに使われているため変更できません ` +
    `(${detail})。管理コンソールでルールを移動または削除してください。`;
}

/**
 * `/files/*`, `/folders/*`, `/content/*` の wildcard route から、mount prefix を
 * 剥がして「root 相対のファイルパス」(必ず `/` 始まり) を取り出す。
 *
 * 設計判断:
 *   - 旧実装は per-route で `c.req.path.replace(/^\/files\/?/, "")` + `"/" + ...`
 *     を 7 箇所にコピペしており、prefix だけ違う 3 種の regex literal が散らばっていた。
 *     ヘルパー 1 本に集約することで、追加 route が増えた時の編集箇所を 1 つにする。
 *   - Hono の `*` wildcard は **non-capturing** (= `c.req.param("*")` は常に
 *     undefined)。`:path{.*}` (capturing) は空 path で Hono 内部 crash、
 *     `:path{.+}` は `/files/` で 404 になるため route 定義は `/files/*` を維持し、
 *     mount prefix は呼び出し側で渡す。
 *   - `c.req.path` は Hono が percent-decode 済み (slash 文字 `%2F` のみ保護)。
 *     旧 regex 実装も同じ decoded path に対して動作していたので、本ヘルパーへの
 *     置換で `resolveAndValidate` に渡る文字列は完全に同一 (decode 挙動の差なし)。
 *   - 純関数として書いておけば fixture なしで edge case (末尾 `/`, mount root のみ,
 *     日本語名, `..` 含み) を直接 unit test できる。
 */
export function wildcardPath(reqPath: string, mountPrefix: string): string {
  // mountPrefix は "/files" の形式 (末尾スラッシュなし) を想定。
  //   /files/foo   → after = "/foo"  → "/foo"
  //   /files/      → after = "/"     → "/"
  //   /files       → after = ""      → "/"   (mount root)
  const after = reqPath.slice(mountPrefix.length);
  if (after === "" || after === "/") return "/";
  return after[0] === "/" ? after : "/" + after;
}

export function registerFileRoutes(app: Hono<Env>) {
  // GET /volume — storage が乗っている FS の容量 (Z: ドライブの「ディスクの空き容量」表示用)
  app.get("/volume", async (c) => {
    try {
      const stats = await getVolumeStats();
      return c.json(stats);
    } catch (e) {
      if (e instanceof FileServiceError) {
        return c.json({ message: e.message }, e.statusCode as 400);
      }
      throw e;
    }
  });

  // GET /tree — recursive full tree listing (read 権限のあるノードのみ返す)
  app.get("/tree", async (c) => {
    const user = c.get("user");
    // const t0 = performance.now();
    try {
      const tree = await getTree();
      const locks = await getAllLocks();
      // ADR-035: 名前だけ見えるノード (grant した path の祖先) も返す。これが
      // 無いと /alice/docs への grant は /alice が不可視で到達できず死ぬ。
      // 併せて ADR-019 isReadOnly を合成する (他 device がロック中)。
      const checks = await Promise.all(
        tree.map(async (n) => {
          if (
            !(await checkPermission(user.id, n.path, "visible"))
          ) {
            return null;
          }
          const lock = locks.get(n.path);
          const isReadOnly = lock !== undefined &&
            lock.deviceId !== user.deviceId;
          return { ...n, isReadOnly };
        }),
      );
      const filtered = checks.filter(
        (n): n is (typeof tree)[number] & { isReadOnly: boolean } => n !== null,
      );
      // console.log(`[diag] GET /tree dev=${user.deviceId} entries=${filtered.length} ${(performance.now() - t0).toFixed(1)}ms`);
      return c.json(filtered);
    } catch (e) {
      if (e instanceof FileServiceError) {
        return c.json({ message: e.message }, e.statusCode as 400);
      }
      throw e;
    }
  });

  // GET /files/*path — list directory or get file info
  app.get("/files/*", async (c) => {
    const filePath = wildcardPath(c.req.path, "/files");
    const user = c.get("user");
    // const t0 = performance.now();

    // ADR-035: 名前だけ見えるディレクトリ (grant した path の祖先) は開ける。
    // 中身は 1 件ずつ可視性で絞るので、名前が漏れるのはその grant が既に
    // 含意している祖先だけ。ファイルは read が要る。
    if (!(await checkPermission(user.id, filePath, "visible"))) {
      return c.json({ message: "Forbidden" }, 403);
    }

    try {
      const info = await getFileInfo(filePath);
      if (info.type === "directory") {
        const entries = await listDirectory(filePath);
        const base = filePath === "/" ? "" : filePath.replace(/\/$/, "");
        const visible = await Promise.all(
          entries.map(async (e) =>
            await checkPermission(user.id, `${base}/${e.name}`, "visible")
              ? e
              : null
          ),
        );
        // console.log(`[diag] GET /files dev=${user.deviceId} ${filePath} dir entries=${entries.length} ${(performance.now() - t0).toFixed(1)}ms`);
        return c.json(visible.filter((e) => e !== null));
      }
      if (!(await checkPermission(user.id, filePath, "read"))) {
        return c.json({ message: "Forbidden" }, 403);
      }
      // console.log(`[diag] GET /files dev=${user.deviceId} ${filePath} stat ${(performance.now() - t0).toFixed(1)}ms`);
      return c.json(info);
    } catch (e) {
      if (e instanceof FileServiceError) {
        return c.json({ message: e.message }, e.statusCode as 400);
      }
      throw e;
    }
  });

  // DELETE /files/*path — delete file or directory
  app.delete("/files/*", async (c) => {
    const filePath = wildcardPath(c.req.path, "/files");
    const user = c.get("user");

    if (filePath === "/" || filePath === "") {
      return c.json({ message: "Refusing to delete storage root" }, 400);
    }
    if (!(await checkPermission(user.id, filePath, "write"))) {
      return c.json({ message: "Forbidden" }, 403);
    }
    const pinned = await describePin(filePath);
    if (pinned) return c.json({ message: pinned }, 409);

    try {
      await deleteFile(filePath, user.deviceId);
      return c.json({ message: "Deleted" }, 200);
    } catch (e) {
      if (e instanceof FileServiceError) {
        return c.json({ message: e.message }, e.statusCode as 400);
      }
      throw e;
    }
  });

  // POST /folders/*path — create directory (non-recursive: 親が無ければ 404)
  app.post("/folders/*", async (c) => {
    const filePath = wildcardPath(c.req.path, "/folders");
    const user = c.get("user");

    if (filePath === "/" || filePath === "") {
      return c.json({ message: "Refusing to create root" }, 400);
    }
    if (!(await checkPermission(user.id, filePath, "write"))) {
      return c.json({ message: "Forbidden" }, 403);
    }

    try {
      await createFolder(filePath, user.deviceId);
      return c.json({ message: "Created", path: filePath }, 201);
    } catch (e) {
      if (e instanceof FileServiceError) {
        return c.json({ message: e.message }, e.statusCode as 400);
      }
      throw e;
    }
  });

  // PATCH /files/*path — rename. body: { newPath: string }
  app.patch("/files/*", async (c) => {
    const oldPath = wildcardPath(c.req.path, "/files");
    const user = c.get("user");

    if (oldPath === "/" || oldPath === "") {
      return c.json({ message: "Refusing to rename root" }, 400);
    }

    let body: { newPath?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    const newPath = body?.newPath;
    if (typeof newPath !== "string" || newPath.length === 0) {
      return c.json({ message: "newPath required" }, 400);
    }

    // 移動元/移動先の両方に write 権限が必要
    if (
      !(await checkPermission(user.id, oldPath, "write")) ||
      !(await checkPermission(user.id, newPath, "write"))
    ) {
      return c.json({ message: "Forbidden" }, 403);
    }
    const pinned = await describePin(oldPath);
    if (pinned) return c.json({ message: pinned }, 409);

    try {
      await renameEntry(oldPath, newPath, user.deviceId);
      return c.json({ message: "Renamed", oldPath, newPath }, 200);
    } catch (e) {
      if (e instanceof FileServiceError) {
        return c.json({ message: e.message }, e.statusCode as 400);
      }
      throw e;
    }
  });

  // GET /content/*path — download file content
  app.get("/content/*", async (c) => {
    const filePath = wildcardPath(c.req.path, "/content");
    const user = c.get("user");
    // const t0 = performance.now();

    if (!(await checkPermission(user.id, filePath, "read"))) {
      return c.json({ message: "Forbidden" }, 403);
    }

    try {
      // Parse Range header
      const rangeHeader = c.req.header("Range");
      let offset: number | undefined;
      let length: number | undefined;

      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          offset = parseInt(match[1], 10);
          if (match[2]) {
            length = parseInt(match[2], 10) - offset + 1;
          }
        }
      }

      const { body, size } = await readFile(filePath, offset, length);
      // console.log(`[diag] GET /content dev=${user.deviceId} ${filePath} range=${rangeHeader ?? "-"} size=${size} ${(performance.now() - t0).toFixed(1)}ms`);

      const headers: Record<string, string> = {
        "Content-Type": "application/octet-stream",
      };

      // ADR-021 で X-File-Attributes ヘッダは廃止 (WinFsp に移行して
      // ロック衝突は OpenAsync 段階で STATUS_ACCESS_DENIED で弾けるため
      // RO 属性ヘッダ経由の通知が不要になった、ADR-019 supersede)。

      // body が Uint8Array (eager-read 経路) の場合、length は
      // 実 read バイト数を直接使う。EOF より短く返ったときも整合する。
      const bodyLength = body instanceof Uint8Array
        ? body.byteLength
        : undefined;
      const responseBody = body as BodyInit;

      if (rangeHeader && offset !== undefined) {
        const len = bodyLength ?? length ?? size - offset;
        const end = offset + len - 1;
        headers["Content-Range"] = `bytes ${offset}-${end}/${size}`;
        headers["Content-Length"] = String(len);
        return new Response(responseBody, { status: 206, headers });
      }

      headers["Content-Length"] = String(bodyLength ?? size);
      return new Response(responseBody, { status: 200, headers });
    } catch (e) {
      if (e instanceof FileServiceError) {
        return c.json({ message: e.message }, e.statusCode as 400);
      }
      throw e;
    }
  });

  // PUT /content/*path — upload file
  app.put("/content/*", async (c) => {
    const filePath = wildcardPath(c.req.path, "/content");
    const user = c.get("user");

    if (!(await checkPermission(user.id, filePath, "write"))) {
      return c.json({ message: "Forbidden" }, 403);
    }

    try {
      // Check lock
      if (await isLockedByOther(filePath, user.id)) {
        return c.json({ message: "File is locked by another user" }, 423);
      }

      const body = c.req.raw.body;
      if (!body) {
        return c.json({ message: "Request body required" }, 400);
      }
      await writeFile(filePath, body, user.deviceId);
      // Return up-to-date metadata so the client can refresh its placeholder.
      const stat = await statFile(filePath);
      return c.json(
        {
          size: stat.size,
          lastModified: stat.lastModified,
        },
        200,
      );
    } catch (e) {
      if (e instanceof FileServiceError) {
        return c.json({ message: e.message }, e.statusCode as 400);
      }
      throw e;
    }
  });
}
