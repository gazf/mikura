import { Hono } from "hono";
import {
  abortSession,
  createSession,
  finalizeSession,
  UploadServiceError,
  writeChunk,
} from "../services/upload.service.ts";
import { checkPermission } from "../services/auth.service.ts";
import type { AuthUser } from "../services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
  };
};

// PATCH の Content-Range: bytes <off>-<end>/<total|*> を offset 抽出のために緩く parse。
const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/;

function handleError(e: unknown, fallback = 500) {
  if (e instanceof UploadServiceError) {
    return { message: e.message, status: e.statusCode };
  }
  return {
    message: e instanceof Error ? e.message : "Internal error",
    status: fallback,
  };
}

export function registerUploadRoutes(app: Hono<Env>) {
  // POST /uploads — start session. body: { path, baseFromExisting? }
  app.post("/uploads", async (c) => {
    const user = c.get("user");
    let body: { path?: string; baseFromExisting?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    const filePath = body.path;
    if (typeof filePath !== "string" || !filePath.startsWith("/")) {
      return c.json({ message: "path required (absolute, leading /)" }, 400);
    }

    if (!(await checkPermission(user.id, filePath, "write"))) {
      return c.json({ message: "Forbidden" }, 403);
    }

    try {
      const session = await createSession(
        filePath,
        user.id,
        user.deviceId,
        body.baseFromExisting === true,
      );
      return c.json({ uploadId: session.uploadId, path: session.path }, 201);
    } catch (e) {
      const err = handleError(e);
      return c.json({ message: err.message }, err.status as 400);
    }
  });

  // PATCH /uploads/:uploadId — write a chunk at offset given by Content-Range.
  app.patch("/uploads/:uploadId", async (c) => {
    const user = c.get("user");
    const uploadId = c.req.param("uploadId");

    const range = c.req.header("Content-Range");
    if (!range) {
      return c.json(
        { message: "Content-Range header required (bytes <off>-<end>/*)" },
        400,
      );
    }
    const match = range.match(CONTENT_RANGE_RE);
    if (!match) {
      return c.json({ message: "Invalid Content-Range format" }, 400);
    }
    const offset = parseInt(match[1], 10);

    const body = c.req.raw.body;
    if (!body) return c.json({ message: "Body required" }, 400);

    try {
      // body を直接 service 層に渡す: file.write へストリーミングされ、
      // HTTP body 全体を RAM に展開しない。
      const result = await writeChunk(uploadId, user.deviceId, offset, body);
      return c.json(result, 200);
    } catch (e) {
      const err = handleError(e);
      return c.json({ message: err.message }, err.status as 400);
    }
  });

  // POST /uploads/:uploadId/finalize  body: { size }
  app.post("/uploads/:uploadId/finalize", async (c) => {
    const user = c.get("user");
    const uploadId = c.req.param("uploadId");
    let body: { size?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    if (typeof body.size !== "number") {
      return c.json({ message: "size required" }, 400);
    }
    try {
      const result = await finalizeSession(uploadId, user.deviceId, body.size);
      return c.json(result, 200);
    } catch (e) {
      const err = handleError(e);
      return c.json({ message: err.message }, err.status as 400);
    }
  });

  // DELETE /uploads/:uploadId — abort.
  app.delete("/uploads/:uploadId", async (c) => {
    const user = c.get("user");
    const uploadId = c.req.param("uploadId");
    try {
      await abortSession(uploadId, user.deviceId);
      return c.body(null, 204);
    } catch (e) {
      const err = handleError(e);
      return c.json({ message: err.message }, err.status as 400);
    }
  });
}
