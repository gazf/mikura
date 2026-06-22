/**
 * Admin endpoints: User / Group / Permission / Enrollment / Token の CRUD。
 *
 * 認可: root (`/`) に対する `admin` permission を持つ user のみ全 endpoint を
 * 叩ける。これは既存 `checkPermission` を介して行うので、KV 直アクセスではなく
 * 通常の auth pipeline を通る。
 *
 * 設計判断:
 *   - permission の path は slash を含むので URL param に置けず、body / query で受ける。
 *   - cascade delete (user → tokens/devices/user_groups/enrollments、group →
 *     user_groups/permissions) は best-effort で逐次削除。大量データでは
 *     pagination が必要だが mikura の想定規模では list 一括で十分。
 *   - response shape は plain JSON object (Hono 慣用)。raw token / raw enrollment
 *     secret は POST 直後の response にしか出さない (= 後から取得する経路は無い)。
 */

import { Hono } from "hono";
import {
  type AuthUser,
  checkPermission,
  type PermissionContext,
  revokeToken,
} from "../services/auth.service.ts";
import {
  createEnrollmentSecret,
  listEnrollmentsByUser,
} from "../services/enrollment.service.ts";
import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import type {
  AccessLevel,
  EnrollmentSecret,
  Group,
  Permission,
  TokenData,
  User,
} from "../types.ts";

type Env = {
  Variables: {
    user: AuthUser;
    permCtx: PermissionContext;
  };
};

/** root に対する admin permission を持つことを確認。無ければ 403 を返す。 */
async function requireAdmin(
  user: AuthUser,
  permCtx: PermissionContext,
): Promise<{ ok: true } | { ok: false; status: 403 }> {
  const ok = await checkPermission(user.id, "/", "admin", permCtx);
  return ok ? { ok: true } : { ok: false, status: 403 };
}

/** counter を atomic に increment。seed.ts と同じロジック。 */
async function nextId(kv: Deno.Kv, entity: string): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await kv.get<number>(Keys.counter(entity));
    const next = (cur.value ?? 0) + 1;
    const res = await kv
      .atomic()
      .check(cur)
      .set(Keys.counter(entity), next)
      .commit();
    if (res.ok) return next;
  }
  throw new Error(`nextId(${entity}): contention exhausted`);
}

const VALID_ACCESS_LEVELS: ReadonlySet<AccessLevel> = new Set([
  "read",
  "write",
  "admin",
]);

function isValidAccessLevel(v: unknown): v is AccessLevel {
  return typeof v === "string" && VALID_ACCESS_LEVELS.has(v as AccessLevel);
}

/** Path validation: file.service.resolveAndValidate の subset (= 文字列のみ)。 */
function isValidPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0) return false;
  if (!p.startsWith("/")) return false;
  if (p.includes("\0")) return false;
  // ".." segment 拒否 (file.service と同じ規律)
  const parts = p.split("/").filter(Boolean);
  if (parts.includes("..") || parts.includes(".")) return false;
  return true;
}

export function registerAdminRoutes(app: Hono<Env>) {
  // ---- Users ----

  app.post("/admin/users", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    let body: { name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    const name = body.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 64) {
      return c.json({ message: "name required (1-64 chars)" }, 400);
    }

    const kv = await getKv();
    // Name uniqueness check (atomic 区間外だが、commit 時に check で race-safe)
    const existing = await kv.get<number>(Keys.userByName(name));
    if (existing.value !== null) {
      return c.json({ message: "User with this name already exists" }, 409);
    }

    const id = await nextId(kv, "users");
    const newUser: User = {
      id,
      name,
      // password login は廃止予定。enrollment-only なので空文字。
      passwordHash: "",
      createdAt: new Date().toISOString(),
    };
    const res = await kv
      .atomic()
      .check(existing) // userByName が後から書かれていないことを確認
      .set(Keys.user(id), newUser)
      .set(Keys.userByName(name), id)
      .commit();
    if (!res.ok) {
      return c.json({ message: "Race: try again" }, 409);
    }
    return c.json({ id, name, createdAt: newUser.createdAt }, 201);
  });

  app.get("/admin/users", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const kv = await getKv();
    const users: User[] = [];
    const iter = kv.list<User>({ prefix: ["users"] });
    for await (const entry of iter) {
      // ["users", id] 以外 (例: ["users_by_name", ...]) は別 prefix なので拾わない。
      users.push(entry.value);
    }
    return c.json(users.map((u) => ({
      id: u.id,
      name: u.name,
      createdAt: u.createdAt,
    })));
  });

  app.get("/admin/users/:id", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ message: "Invalid id" }, 400);
    const kv = await getKv();
    const entry = await kv.get<User>(Keys.user(id));
    if (!entry.value) return c.json({ message: "Not found" }, 404);
    return c.json({
      id: entry.value.id,
      name: entry.value.name,
      createdAt: entry.value.createdAt,
    });
  });

  app.delete("/admin/users/:id", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ message: "Invalid id" }, 400);
    if (id === user.id) {
      return c.json({ message: "Cannot delete yourself" }, 400);
    }
    const kv = await getKv();
    const target = await kv.get<User>(Keys.user(id));
    if (!target.value) return c.json({ message: "Not found" }, 404);

    // Cascade: tokens / devices / user_groups / enrollments
    const tx = kv.atomic()
      .delete(Keys.user(id))
      .delete(Keys.userByName(target.value.name));

    for await (
      const e of kv.list<true>({ prefix: Keys.tokensByUserPrefix(id) })
    ) {
      const hash = e.key[2] as string;
      tx.delete(Keys.token(hash));
      tx.delete(Keys.tokenByUser(id, hash));
    }
    for await (
      const e of kv.list<true>({ prefix: Keys.devicesByUserPrefix(id) })
    ) {
      const deviceId = e.key[2] as string;
      tx.delete(Keys.device(deviceId));
      tx.delete(Keys.deviceByUser(id, deviceId));
    }
    for await (
      const e of kv.list<true>({ prefix: Keys.userGroupsPrefix(id) })
    ) {
      const groupId = e.key[2] as number;
      tx.delete(Keys.userGroup(id, groupId));
    }
    for await (
      const e of kv.list<true>({ prefix: Keys.enrollmentsByUserPrefix(id) })
    ) {
      const hash = e.key[2] as string;
      tx.delete(Keys.enrollment(hash));
      tx.delete(Keys.enrollmentByUser(id, hash));
    }

    const res = await tx.commit();
    if (!res.ok) return c.json({ message: "Race: try again" }, 409);
    return c.json({ deleted: id }, 200);
  });

  // ---- Groups ----

  app.post("/admin/groups", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    let body: { name?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    const name = body.name;
    if (typeof name !== "string" || name.length === 0 || name.length > 64) {
      return c.json({ message: "name required (1-64 chars)" }, 400);
    }

    const kv = await getKv();
    const id = await nextId(kv, "groups");
    const g: Group = { id, name };
    await kv.set(Keys.group(id), g);
    return c.json(g, 201);
  });

  app.get("/admin/groups", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const kv = await getKv();
    const groups: Group[] = [];
    for await (const e of kv.list<Group>({ prefix: ["groups"] })) {
      groups.push(e.value);
    }
    return c.json(groups);
  });

  app.delete("/admin/groups/:id", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ message: "Invalid id" }, 400);
    const kv = await getKv();
    const target = await kv.get<Group>(Keys.group(id));
    if (!target.value) return c.json({ message: "Not found" }, 404);

    // Cascade: user_groups (全 user で本 group を参照する entry を引き、削除する)
    // permissions (全 path で本 group の permission を削除する)
    const tx = kv.atomic().delete(Keys.group(id));

    // user_groups は ["user_groups", userId, groupId] なので、groupId 指定の
    // 直接 lookup ができない (prefix が userId)。全 user の user_groups を walk。
    // mikura の規模では問題ない。
    for await (const e of kv.list<User>({ prefix: ["users"] })) {
      const userId = e.value.id;
      const got = await kv.get<true>(Keys.userGroup(userId, id));
      if (got.value) tx.delete(Keys.userGroup(userId, id));
    }

    // permissions は ["permissions", path, groupId] なので、こちらも path 単位の
    // walk が必要。permission 数が膨大ならインデックス追加検討。
    for await (
      const e of kv.list<Permission>({ prefix: ["permissions"] })
    ) {
      // key shape: ["permissions", path, groupId]
      const keyGroupId = e.key[2] as number;
      if (keyGroupId === id) tx.delete(e.key);
    }

    const res = await tx.commit();
    if (!res.ok) return c.json({ message: "Race: try again" }, 409);
    return c.json({ deleted: id }, 200);
  });

  // ---- User-Group membership ----

  app.post("/admin/user-groups", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    let body: { userId?: unknown; groupId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    const userId = body.userId;
    const groupId = body.groupId;
    if (typeof userId !== "number" || typeof groupId !== "number") {
      return c.json({ message: "userId / groupId required (number)" }, 400);
    }
    const kv = await getKv();
    const [u, g] = await Promise.all([
      kv.get<User>(Keys.user(userId)),
      kv.get<Group>(Keys.group(groupId)),
    ]);
    if (!u.value) return c.json({ message: "user not found" }, 404);
    if (!g.value) return c.json({ message: "group not found" }, 404);
    await kv.set(Keys.userGroup(userId, groupId), true);
    return c.json({ userId, groupId }, 201);
  });

  app.delete("/admin/user-groups/:userId/:groupId", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const userId = parseInt(c.req.param("userId"), 10);
    const groupId = parseInt(c.req.param("groupId"), 10);
    if (!Number.isFinite(userId) || !Number.isFinite(groupId)) {
      return c.json({ message: "Invalid id" }, 400);
    }
    const kv = await getKv();
    await kv.delete(Keys.userGroup(userId, groupId));
    return c.json({ removed: { userId, groupId } });
  });

  // ---- Permissions ----

  app.put("/admin/permissions", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    let body: { path?: unknown; groupId?: unknown; accessLevel?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    if (!isValidPath(body.path)) {
      return c.json(
        { message: "path required (absolute, no .. / no null)" },
        400,
      );
    }
    if (typeof body.groupId !== "number") {
      return c.json({ message: "groupId required (number)" }, 400);
    }
    if (!isValidAccessLevel(body.accessLevel)) {
      return c.json(
        { message: "accessLevel required (read / write / admin)" },
        400,
      );
    }
    const kv = await getKv();
    const g = await kv.get<Group>(Keys.group(body.groupId));
    if (!g.value) return c.json({ message: "group not found" }, 404);

    const perm: Permission = { accessLevel: body.accessLevel };
    await kv.set(Keys.permission(body.path, body.groupId), perm);
    return c.json({
      path: body.path,
      groupId: body.groupId,
      accessLevel: body.accessLevel,
    });
  });

  app.delete("/admin/permissions", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const path = c.req.query("path");
    const groupIdStr = c.req.query("groupId");
    if (!isValidPath(path)) {
      return c.json({ message: "path query required (absolute)" }, 400);
    }
    const groupId = parseInt(groupIdStr ?? "", 10);
    if (!Number.isFinite(groupId)) {
      return c.json({ message: "groupId query required (number)" }, 400);
    }
    const kv = await getKv();
    await kv.delete(Keys.permission(path, groupId));
    return c.json({ removed: { path, groupId } });
  });

  // ---- Enrollments ----

  app.post("/admin/enrollments", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    let body: { userId?: unknown; ttlDays?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    if (typeof body.userId !== "number") {
      return c.json({ message: "userId required (number)" }, 400);
    }
    const ttlDays = typeof body.ttlDays === "number" ? body.ttlDays : 7;
    if (ttlDays < 1 || ttlDays > 90) {
      return c.json({ message: "ttlDays must be 1..90" }, 400);
    }

    try {
      const result = await createEnrollmentSecret(
        body.userId,
        user.id,
        ttlDays,
      );
      return c.json({
        secret: result.raw,
        secretHash: result.secretHash,
        expiresAt: result.expiresAt,
      }, 201);
    } catch (e) {
      if (e instanceof Error && e.message === "user_not_found") {
        return c.json({ message: "user not found" }, 404);
      }
      throw e;
    }
  });

  app.get("/admin/enrollments", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const userIdStr = c.req.query("userId");
    const userId = parseInt(userIdStr ?? "", 10);
    if (!Number.isFinite(userId)) {
      return c.json({ message: "userId query required (number)" }, 400);
    }
    const list = await listEnrollmentsByUser(userId);
    // raw secret は server に存在しないので、metadata だけ返す。
    return c.json(list.map((e: EnrollmentSecret) => ({
      secretHash: e.secretHash,
      userId: e.userId,
      createdBy: e.createdBy,
      createdAt: e.createdAt,
      expiresAt: e.expiresAt,
      consumedAt: e.consumedAt,
      consumedByDeviceId: e.consumedByDeviceId,
    })));
  });

  // ---- Tokens ----

  app.get("/admin/tokens", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const userIdStr = c.req.query("userId");
    const userId = parseInt(userIdStr ?? "", 10);
    if (!Number.isFinite(userId)) {
      return c.json({ message: "userId query required (number)" }, 400);
    }
    const kv = await getKv();
    const tokens: Array<TokenData & { tokenHash: string }> = [];
    for await (
      const e of kv.list<true>({ prefix: Keys.tokensByUserPrefix(userId) })
    ) {
      const hash = e.key[2] as string;
      const got = await kv.get<TokenData>(Keys.token(hash));
      if (got.value) tokens.push({ ...got.value, tokenHash: hash });
    }
    // raw token は返さない (hash と metadata のみ)。
    return c.json(tokens);
  });

  app.delete("/admin/tokens/:tokenHash", async (c) => {
    const user = c.get("user");
    const permCtx = c.get("permCtx");
    const auth = await requireAdmin(user, permCtx);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const tokenHash = c.req.param("tokenHash");
    if (!tokenHash || tokenHash.length !== 64) {
      return c.json({ message: "tokenHash must be 64-char hex" }, 400);
    }
    const ok = await revokeToken(tokenHash);
    return c.json({ revoked: ok });
  });
}
