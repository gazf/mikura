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
import type {
  AuthUser,
  PermissionContext,
} from "../services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
    permCtx: PermissionContext;
  };
};

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
    const permCtx = c.get("permCtx");
    // const t0 = performance.now();
    try {
      const tree = await getTree();
      const locks = await getAllLocks();
      // 各ノードを read 権限でフィルタ + ADR-019 isReadOnly 合成 (他 device がロック中)。
      // permCtx は request スコープの cache。entry 間で parent path の lookup
      // が大量重複するため、これを共有すると /tree の KV op が劇的に減る。
      const checks = await Promise.all(
        tree.map(async (n) => {
          if (
            !(await checkPermission(user.id, n.path, "read", permCtx))
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
    const wildcard = c.req.path.replace(/^\/files\/?/, "");
    const filePath = "/" + wildcard;
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    // const t0 = performance.now();

    if (!(await checkPermission(user.id, filePath, "read", permCtx))) {
      return c.json({ message: "Forbidden" }, 403);
    }

    try {
      const info = await getFileInfo(filePath);
      if (info.type === "directory") {
        const entries = await listDirectory(filePath);
        // console.log(`[diag] GET /files dev=${user.deviceId} ${filePath} dir entries=${entries.length} ${(performance.now() - t0).toFixed(1)}ms`);
        return c.json(entries);
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
    const wildcard = c.req.path.replace(/^\/files\/?/, "");
    const filePath = "/" + wildcard;
    const user = c.get("user");

    if (filePath === "/" || filePath === "") {
      return c.json({ message: "Refusing to delete storage root" }, 400);
    }

    const permCtx = c.get("permCtx");
    if (!(await checkPermission(user.id, filePath, "write", permCtx))) {
      return c.json({ message: "Forbidden" }, 403);
    }

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
    const wildcard = c.req.path.replace(/^\/folders\/?/, "");
    const filePath = "/" + wildcard;
    const user = c.get("user");

    if (filePath === "/" || filePath === "") {
      return c.json({ message: "Refusing to create root" }, 400);
    }

    const permCtx = c.get("permCtx");
    if (!(await checkPermission(user.id, filePath, "write", permCtx))) {
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
    const wildcard = c.req.path.replace(/^\/files\/?/, "");
    const oldPath = "/" + wildcard;
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
    const permCtx = c.get("permCtx");
    if (
      !(await checkPermission(user.id, oldPath, "write", permCtx)) ||
      !(await checkPermission(user.id, newPath, "write", permCtx))
    ) {
      return c.json({ message: "Forbidden" }, 403);
    }

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
    const wildcard = c.req.path.replace(/^\/content\/?/, "");
    const filePath = "/" + wildcard;
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    // const t0 = performance.now();

    if (!(await checkPermission(user.id, filePath, "read", permCtx))) {
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
    const wildcard = c.req.path.replace(/^\/content\/?/, "");
    const filePath = "/" + wildcard;
    const user = c.get("user");
    const permCtx = c.get("permCtx");

    if (!(await checkPermission(user.id, filePath, "write", permCtx))) {
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
