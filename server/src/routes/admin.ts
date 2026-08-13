/**
 * Admin endpoints: User / Policy / Assignment / Assertion / Enrollment / Token。
 *
 * 認可: root (`/`) に対する `admin` 権限を持つ user のみ全 endpoint を叩ける。
 * これは既存 `checkPermission` を介して行うので、KV 直アクセスではなく通常の
 * auth pipeline を通る。
 *
 * 設計判断:
 *   - ポリシー (ADR-035) は 1 本のテキスト文書として読み書きする。ルールを
 *     行単位で編集する API は作らない — 「誰が何にアクセスできるか」を 1 つの
 *     成果物として読める / diff できることがこの設計の目的そのもので、行 API を
 *     生やすと旧 permission 行の山に戻る。
 *   - cascade delete (user → tokens/devices/roles/enrollments) は best-effort で
 *     逐次削除。大量データでは pagination が必要だが mikura の想定規模では
 *     list 一括で十分。
 *   - response shape は plain JSON object (Hono 慣用)。raw token / raw enrollment
 *     secret は POST 直後の response にしか出さない (= 後から取得する経路は無い)。
 */

import { Hono } from "hono";
import {
  type AuthUser,
  checkPermission,
  revokeToken,
} from "../services/auth.service.ts";
import {
  createEnrollmentSecret,
  listEnrollmentsByUser,
} from "../services/enrollment.service.ts";
import {
  assignRole,
  createAssertion,
  deleteAssertion,
  getActivePolicy,
  getActivePolicyWithVersion,
  getPolicyVersion,
  getUserRoles,
  listAssertions,
  listAssignments,
  listPolicyVersions,
  savePolicy,
  unassignAllRoles,
  unassignRole,
} from "../services/policy.service.ts";
import { TEST_EXPECTATIONS, type TestExpectation } from "../policy/document.ts";
import {
  effectiveLevel,
  explainAccess,
  hasAccess,
} from "../policy/evaluate.ts";
import { findDanglingRules, validatePolicy } from "../policy/validate.ts";
import { foldAscii } from "../policy/paths.ts";
import { getTree } from "../services/file.service.ts";
import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import { buildEnrollUrl, getPublicBaseUrl } from "../util/enrollUrl.ts";
import type {
  AccessLevel,
  AuditEntry,
  DeviceData,
  EnrollmentSecret,
  TokenData,
  User,
} from "../types.ts";

type Env = {
  Variables: {
    user: AuthUser;
  };
};

/** root に対する admin 権限を持つことを確認。無ければ 403 を返す。 */
async function requireAdmin(
  user: AuthUser,
): Promise<{ ok: true } | { ok: false; status: 403 }> {
  const ok = await checkPermission(user.id, "/", "admin");
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

/**
 * 「省略可能な `userId` query」を解釈する。console の一覧画面は全件を、
 * user 詳細画面は絞り込みを要求するので、同じ endpoint で両方を賄う。
 *
 * 未指定 (`undefined`) と不正値 (`"abc"`) を区別するのが要点 — 後者を
 * 「全件」に倒すと、typo が静かに全件表示になってしまう。
 */
function parseOptionalUserId(
  raw: string | undefined,
):
  | { ok: true; userId: number | undefined }
  | { ok: false; message: string } {
  if (raw === undefined || raw === "") return { ok: true, userId: undefined };
  const userId = parseInt(raw, 10);
  if (!Number.isFinite(userId)) {
    return { ok: false, message: "userId query must be a number if present" };
  }
  return { ok: true, userId };
}

function isTestExpectation(v: unknown): v is TestExpectation {
  return typeof v === "string" &&
    (TEST_EXPECTATIONS as readonly string[]).includes(v);
}

/**
 * ポリシー原文の上限。KV の 1 値は 64KiB までで、想定規模 (数十ユーザー /
 * 数十ロール) なら 2 桁 KB にも届かない。上限が無いと保存が KV 層のエラーで
 * 落ちて、理由が利用者に伝わらない。
 */
const POLICY_MAX_BYTES = 32 * 1024;

function countMembers(
  assignments: ReadonlyMap<number, readonly string[]>,
  roleName: string,
): number {
  let n = 0;
  for (const [, roles] of assignments) if (roles.includes(roleName)) n++;
  return n;
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
  // ---- Identity ----

  /**
   * 「この token は誰のもので、admin 権限があるか」を 1 往復で確かめる。
   *
   * console の login はこれ 1 本で済む: 401 なら token が無効、403 なら
   * admin ではない、200 なら本人が判る。`GET /admin/users` で代用すると
   * 全 user を引いた上で「呼び出し元が誰か」は依然として判らない。
   */
  app.get("/admin/whoami", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    return c.json({ id: user.id, name: user.name, deviceId: user.deviceId });
  });

  // ---- Users ----

  app.post("/admin/users", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
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
    const auth = await requireAdmin(user);
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
    const auth = await requireAdmin(user);
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
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ message: "Invalid id" }, 400);
    if (id === user.id) {
      return c.json({ message: "Cannot delete yourself" }, 400);
    }
    const kv = await getKv();
    const target = await kv.get<User>(Keys.user(id));
    if (!target.value) return c.json({ message: "Not found" }, 404);

    // ロール割り当ての解除は「admin が 1 人もいなくなる」検査を伴うので、
    // 他の cascade より先に、専用の経路で落とす。
    const unassigned = await unassignAllRoles(id);
    if (!unassigned.ok) return c.json({ message: unassigned.error }, 409);

    // Cascade: tokens / devices / enrollments
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

  // ---- Policy document (ADR-035) ----

  /**
   * 適用中のポリシー原文と、その静的な健康診断。
   *
   * `warnings` は保存を止めない指摘 (何も削らない deny 等)、`dangling` は
   * 実在しないパスを指しているルール。タイポ・大小文字違い・削除・API 外の
   * `mv` の 4 つが 1 つの信号にまとまる。
   */
  app.get("/admin/policy", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const { version, policy } = await getActivePolicyWithVersion();
    const assignments = await listAssignments();
    const assignedRoleNames = new Set<string>();
    for (const [, roles] of assignments) {
      for (const r of roles) assignedRoleNames.add(r);
    }

    const validation = validatePolicy(policy.text, { assignedRoleNames });
    const record = version > 0 ? await getPolicyVersion(version) : null;

    let dangling: Array<{ role: string; path: string; line: number }> = [];
    try {
      const tree = await getTree();
      dangling = findDanglingRules(policy, tree.map((n) => n.path));
    } catch (e) {
      // ツリーが読めない (ストレージ未マウント等) 場合、孤立検査だけ諦める。
      // ポリシー本体の表示は落とさない。
      console.error("dangling rule scan failed:", e);
    }

    return c.json({
      version,
      text: policy.text,
      createdAt: record?.createdAt ?? null,
      createdBy: record?.createdBy ?? null,
      // コンソールはロール単位のフォームで編集するが、保存は文書まるごとの
      // PUT に戻る。そのために「このロールは原文の何行目から何行目か」を返す
      // — フォームの結果をその範囲だけ差し替えれば、手書きのコメントや
      // ロールの並び順が保たれる (全体を再生成するとコメントが消える)。
      roles: policy.document.roles.map((r) => ({
        name: r.name,
        line: r.line,
        endLine: r.endLine,
        rules: r.rules.map((rule) => ({ path: rule.path, level: rule.level })),
        tests: policy.document.tests
          .filter((t) => foldAscii(t.role) === foldAscii(r.name))
          .map((t) => ({
            line: t.line,
            endLine: t.endLine,
            cases: t.cases.map((c) => ({ expect: c.expect, path: c.path })),
          })),
        memberCount: countMembers(assignments, r.name),
      })),
      warnings: validation.warnings,
      dangling,
    });
  });

  /**
   * ポリシーの差し替え。`dryRun` を渡すと KV に触らず検証結果だけ返す。
   *
   * 検証の順序は 構文 → ロール単体テスト → 割り当て層の拒否権 → admin 不在検査。
   * 最後の 2 つは文書の外側の理由なので、文書だけ見ても分からない。
   * 却下は全部 422 (= 形式は JSON として正しいが内容が受け入れられない)。
   */
  app.put("/admin/policy", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    let body: { text?: unknown; expectedVersion?: unknown; dryRun?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    if (typeof body.text !== "string") {
      return c.json({ message: "text required (string)" }, 400);
    }
    if (body.text.length > POLICY_MAX_BYTES) {
      return c.json(
        { message: `text must be <= ${POLICY_MAX_BYTES} bytes` },
        400,
      );
    }
    if (
      body.expectedVersion !== undefined &&
      typeof body.expectedVersion !== "number"
    ) {
      return c.json({ message: "expectedVersion must be a number" }, 400);
    }

    const result = await savePolicy({
      text: body.text,
      createdBy: user.id,
      expectedVersion: body.expectedVersion as number | undefined,
    }, { dryRun: body.dryRun === true });

    return c.json(result, result.ok ? 200 : 422);
  });

  /** 版の一覧 (diff / rollback 用)。本文は含めない。 */
  app.get("/admin/policy/versions", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const versions = await listPolicyVersions();
    const current = (await getActivePolicyWithVersion()).version;
    return c.json(versions.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      createdBy: v.createdBy,
      bytes: v.text.length,
      current: v.version === current,
    })));
  });

  app.get("/admin/policy/versions/:version", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const version = parseInt(c.req.param("version"), 10);
    if (!Number.isFinite(version)) {
      return c.json({ message: "Invalid version" }, 400);
    }
    const record = await getPolicyVersion(version);
    if (!record) return c.json({ message: "Not found" }, 404);
    return c.json(record);
  });

  // ---- Assignments (user × role) ----

  /** `userId` query は任意。省略時は全ユーザー分。 */
  app.get("/admin/assignments", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const scope = parseOptionalUserId(c.req.query("userId"));
    if (!scope.ok) return c.json({ message: scope.message }, 400);

    if (scope.userId !== undefined) {
      const roles = await getUserRoles(scope.userId);
      return c.json([{ userId: scope.userId, roles: [...roles] }]);
    }
    const assignments = await listAssignments();
    return c.json(
      [...assignments].map(([userId, roles]) => ({
        userId,
        roles: [...roles],
      })),
    );
  });

  app.post("/admin/assignments", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    let body: { userId?: unknown; role?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    if (typeof body.userId !== "number") {
      return c.json({ message: "userId required (number)" }, 400);
    }
    if (typeof body.role !== "string" || body.role.length === 0) {
      return c.json({ message: "role required (string)" }, 400);
    }

    const kv = await getKv();
    const target = await kv.get<User>(Keys.user(body.userId));
    if (!target.value) return c.json({ message: "user not found" }, 404);

    const res = await assignRole(body.userId, body.role);
    if (!res.ok) return c.json({ message: res.error }, 404);
    return c.json({ userId: body.userId, role: body.role }, 201);
  });

  /**
   * 割り当ての解除。**admin が 1 人もいなくなる変更は 409 で拒否する**。
   *
   * 旧実装の「自分自身の admin を失う変更を弾く」より弱いようでいて、守り
   * たかったもの (= 誰も管理操作できない状態) をそのまま述べている。role は
   * 単調なので、旧モデルにあった「グループを足したら権限が減る」経路は無い。
   */
  app.delete("/admin/assignments/:userId/:role", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const userId = parseInt(c.req.param("userId"), 10);
    if (!Number.isFinite(userId)) {
      return c.json({ message: "Invalid userId" }, 400);
    }
    const role = c.req.param("role");
    const res = await unassignRole(userId, role);
    if (!res.ok) return c.json({ message: res.error }, 409);
    return c.json({ removed: { userId, role } });
  });

  // ---- Assertions (割り当て層の契約) ----

  /**
   * 「このユーザーのこのパスは少なくとも / ちょうどこの水準」。ポリシーの新版が
   * これを壊すなら保存を拒否する — 提供側 (ロール定義) は消費者を知らないが、
   * 消費者は破壊的変更を拒否できる、という形。
   */
  app.get("/admin/assertions", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);
    return c.json(await listAssertions());
  });

  app.post("/admin/assertions", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    let body: {
      userId?: unknown;
      path?: unknown;
      expect?: unknown;
      note?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ message: "Invalid JSON body" }, 400);
    }
    if (typeof body.userId !== "number") {
      return c.json({ message: "userId required (number)" }, 400);
    }
    if (!isValidPath(body.path)) {
      return c.json(
        { message: "path required (absolute, no .. / no null)" },
        400,
      );
    }
    if (!isTestExpectation(body.expect)) {
      return c.json(
        { message: `expect must be one of ${TEST_EXPECTATIONS.join(" / ")}` },
        400,
      );
    }
    if (body.note !== undefined && typeof body.note !== "string") {
      return c.json({ message: "note must be a string" }, 400);
    }

    const res = await createAssertion({
      userId: body.userId,
      path: body.path,
      expect: body.expect,
      note: body.note,
    });
    if (!res.ok) return c.json({ message: res.error }, 422);
    return c.json(res.assertion, 201);
  });

  app.delete("/admin/assertions/:id", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ message: "Invalid id" }, 400);
    await deleteAssertion(id);
    return c.json({ removed: id });
  });

  // ---- Diagnostics ----

  /**
   * 前方診断 — 「tanaka は /projects/a.txt に書けるか」。role ごとの決め手と
   * なったルールまで返すので、「なぜ」に答えられる。
   */
  app.get("/admin/diagnostics/effective", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const userId = parseInt(c.req.query("userId") ?? "", 10);
    if (!Number.isFinite(userId)) {
      return c.json({ message: "userId query required (number)" }, 400);
    }
    const path = c.req.query("path");
    if (!isValidPath(path)) {
      return c.json({ message: "path query required (absolute)" }, 400);
    }

    const policy = await getActivePolicy();
    const roles = await getUserRoles(userId);
    const explained = explainAccess(policy, roles, path);
    return c.json({
      userId,
      path,
      effective: explained.effective ?? "invisible",
      perRole: explained.perRole,
    });
  });

  /**
   * 逆方向診断 — 「/hr を読めるのは誰か」。deny が **減算ではなく継承の切断**
   * だからこそ有限で答えられる。減算型の deny なら「どこにも deny が無いこと」
   * の証明が要り、探索が閉じない。監査で実際に問われるのはこちら側で、AD の
   * 無い Samba では答えられない問いでもある。
   */
  app.get("/admin/diagnostics/who", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const path = c.req.query("path");
    if (!isValidPath(path)) {
      return c.json({ message: "path query required (absolute)" }, 400);
    }
    const level = c.req.query("level") ?? "read";
    if (level !== "visible" && !isValidAccessLevel(level)) {
      return c.json(
        { message: "level must be visible / read / write / admin" },
        400,
      );
    }

    const policy = await getActivePolicy();
    const assignments = await listAssignments();
    const kv = await getKv();
    const out: Array<
      {
        userId: number;
        name: string | null;
        effective: string;
        roles: string[];
      }
    > = [];
    for (const [userId, roles] of assignments) {
      const effective = effectiveLevel(policy, roles, path);
      if (!hasAccess(effective, level)) continue;
      const record = await kv.get<User>(Keys.user(userId));
      out.push({
        userId,
        name: record.value?.name ?? null,
        effective: effective ?? "invisible",
        roles: [...roles],
      });
    }
    return c.json({ path, level, users: out });
  });

  // ---- Enrollments ----

  app.post("/admin/enrollments", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
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
        // ADR-034: 配布物を 1 本の URI にする。MIKURA_PUBLIC_URL 未設定時は
        // null (= 推測した URL を配るくらいなら console 側で気付かせる)。
        enrollUrl: buildEnrollUrl(getPublicBaseUrl(), result.raw),
      }, 201);
    } catch (e) {
      if (e instanceof Error && e.message === "user_not_found") {
        return c.json({ message: "user not found" }, 404);
      }
      throw e;
    }
  });

  /**
   * `userId` query は **任意**。省略時は全 user 分を返す (= console の
   * 「未消費の招待一覧」画面用)。指定時は従来通り該当 user のみ。
   */
  app.get("/admin/enrollments", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const scope = parseOptionalUserId(c.req.query("userId"));
    if (!scope.ok) return c.json({ message: scope.message }, 400);

    let list: EnrollmentSecret[];
    if (scope.userId !== undefined) {
      list = await listEnrollmentsByUser(scope.userId);
    } else {
      const kv = await getKv();
      list = [];
      for await (
        const e of kv.list<EnrollmentSecret>({
          prefix: Keys.enrollmentsAllPrefix(),
        })
      ) {
        list.push(e.value);
      }
    }
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

  /** `userId` query は任意。省略時は全 user 分 (= console のトークン一覧)。 */
  app.get("/admin/tokens", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const scope = parseOptionalUserId(c.req.query("userId"));
    if (!scope.ok) return c.json({ message: scope.message }, 400);

    const kv = await getKv();
    const tokens: Array<TokenData & { tokenHash: string }> = [];
    if (scope.userId !== undefined) {
      for await (
        const e of kv.list<true>({
          prefix: Keys.tokensByUserPrefix(scope.userId),
        })
      ) {
        const hash = e.key[2] as string;
        const got = await kv.get<TokenData>(Keys.token(hash));
        if (got.value) tokens.push({ ...got.value, tokenHash: hash });
      }
    } else {
      // 全件は ["tokens", hash] を直接舐める (逆引き index 経由の N+1 を回避)。
      for await (
        const e of kv.list<TokenData>({ prefix: Keys.tokensAllPrefix() })
      ) {
        tokens.push({ ...e.value, tokenHash: e.key[1] as string });
      }
    }
    // raw token は返さない (hash と metadata のみ)。
    return c.json(tokens);
  });

  app.delete("/admin/tokens/:tokenHash", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const tokenHash = c.req.param("tokenHash");
    if (!tokenHash || tokenHash.length !== 64) {
      return c.json({ message: "tokenHash must be 64-char hex" }, 400);
    }
    const ok = await revokeToken(tokenHash);
    return c.json({ revoked: ok });
  });

  // ---- Devices ----

  /**
   * `authMiddleware` の `upsertDevice` が書いている device registry の読み出し。
   * 書く経路だけあって読む経路が無かった。console の「このユーザーがどの端末
   * から繋いでいるか」画面用。
   *
   * `userId` query は任意 (省略時は全件)。
   */
  app.get("/admin/devices", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const scope = parseOptionalUserId(c.req.query("userId"));
    if (!scope.ok) return c.json({ message: scope.message }, 400);

    const kv = await getKv();
    const devices: DeviceData[] = [];
    if (scope.userId !== undefined) {
      for await (
        const e of kv.list<true>({
          prefix: Keys.devicesByUserPrefix(scope.userId),
        })
      ) {
        const deviceId = e.key[2] as string;
        const got = await kv.get<DeviceData>(Keys.device(deviceId));
        if (got.value) devices.push(got.value);
      }
    } else {
      for await (
        const e of kv.list<DeviceData>({ prefix: Keys.devicesAllPrefix() })
      ) {
        devices.push(e.value);
      }
    }
    return c.json(devices);
  });

  // ---- Audit ----

  /**
   * 監査ログの読み出し。key が ["audit", ISO timestamp, id] で、ISO 文字列は
   * 辞書順 = 時系列順なので、`reverse: true` がそのまま「新しい順」になる。
   *
   * `limit` は既定 100 / 上限 1000。audit は現状 TTL を持たず単調増加する
   * ので、全件返す経路は最初から作らない。
   */
  app.get("/admin/audit", async (c) => {
    const user = c.get("user");
    const auth = await requireAdmin(user);
    if (!auth.ok) return c.json({ message: "Forbidden" }, auth.status);

    const limitStr = c.req.query("limit");
    let limit = 100;
    if (limitStr !== undefined && limitStr !== "") {
      limit = parseInt(limitStr, 10);
      if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
        return c.json({ message: "limit must be 1..1000" }, 400);
      }
    }

    const kv = await getKv();
    const entries: Array<AuditEntry & { timestamp: string }> = [];
    for await (
      const e of kv.list<AuditEntry>(
        { prefix: Keys.auditPrefix() },
        { reverse: true, limit },
      )
    ) {
      entries.push({ ...e.value, timestamp: e.key[1] as string });
    }
    return c.json(entries);
  });
}
