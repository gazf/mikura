/**
 * ADR-035 / ADR-036: ロール定義の保管と、割り当て層の検証。
 *
 * **保管の単位はロール 1 つ = KV 1 レコード** (ADR-036)。ADR-035 は文書全体を
 * 1 つの版として積んでいたが、実運用の操作は常に「このロールを直す」であって
 * 「文書を差し替える」ではなく、世代を戻したい単位もロールだった。文書全体の
 * スナップショットは、1 ロールの直前の姿を見るのに全文の diff を要求する。
 *
 * テキスト文書は **レコードから決定的に導出される派生物** に降格した。取り込み /
 * 書き出し / レビューの表現形式ではあり続けるが、保管場所ではない。この向きに
 * したことで、パーサ・評価器・検証・ロール単体テストは一切変えずに済んでいる
 * (レコード → テキスト → パース → コンパイル)。
 *
 * 層の向き:
 *   割り当て (ユーザー × ロール) → ロール定義   … 依存してよい
 *   ロール定義 → 割り当て                        … 依存してはいけない
 *
 * したがって「tanaka の /hr/payroll.xlsx は invisible」のような主張は
 * ロール定義ではなく **割り当て層** に置く。それでいてロールの変更がこの主張を
 * 壊すなら保存を拒否する — consumer-driven contract と同じ形。
 */
import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import { parsePolicy, type TestExpectation } from "../policy/document.ts";
import {
  type CompiledPolicy,
  type EffectiveLevel,
  effectiveLevel,
  emptyPolicy,
  hasAccess,
} from "../policy/evaluate.ts";
import {
  type RenderableRole,
  renderPolicy,
  type RoleDefinition,
} from "../policy/render.ts";
import type { PolicyIssue } from "../policy/document.ts";
import { type PolicyTestFailure, validatePolicy } from "../policy/validate.ts";
import { foldAscii } from "../policy/paths.ts";

/** ロールの現在の状態。実体 (ルール・テスト) は世代側に置く。 */
export interface RoleRecord {
  readonly name: string;
  readonly enabled: boolean;
  /** 適用中の世代番号。 */
  readonly generation: number;
  readonly updatedAt: string;
  readonly updatedBy: number;
}

export interface RoleGeneration extends RoleDefinition {
  readonly generation: number;
  readonly createdAt: string;
  readonly createdBy: number;
}

export interface RoleView extends RoleRecord, RoleDefinition {}

/**
 * ロールごとに残す世代の数。これを超えた古い世代は保存時に落とす。
 * 「1 つ前に戻す」が満たせれば十分な機能なので、無制限に積む理由がない。
 */
const MAX_GENERATIONS = 10;

/**
 * 割り当て層のアサーション。「このユーザーのこのパスに対する実効水準は
 * 少なくとも / ちょうど これ」。ロールの変更がこれを壊すなら保存を却下する。
 */
export interface AccessAssertion {
  readonly id: number;
  readonly userId: number;
  readonly path: string;
  readonly expect: TestExpectation;
  readonly note?: string;
}

export interface AssertionFailure {
  readonly id: number;
  readonly userId: number;
  readonly path: string;
  readonly expected: TestExpectation;
  readonly actual: string;
  readonly message: string;
}

/** userId → 割り当てられたロール名。 */
export type AssignmentMap = ReadonlyMap<number, readonly string[]>;

export class PolicyLoadError extends Error {}

// ----- in-memory cache -----
//
// コンパイル済みポリシーはメモリに置く。権限判定は 1 IRP ごとに走るので、
// ここを KV に置くと per-level / per-role の KV read が全部 hot path に戻る。
//
// **複数プロセスで API サーバーを走らせると内容がずれる**。単一プロセスの間は
// 問題ない。多重化する時は「版番号だけを持続 KV から数秒間隔でポーリングする」
// 形になる — ephemeral KV (`:memory:`) はプロセスを跨がないのでこの問題には
// 効かない (素の Map と可視性が同じで、直列化の分だけ遅い)。
let policyCache: CompiledPolicy | null = null;
let policyLoading: Promise<CompiledPolicy> | null = null;

/** userId → role 名。割り当ての変更は必ずこのモジュールを通る。 */
const roleCache = new Map<number, readonly string[]>();

export function _resetPolicyCachesForTesting(): void {
  policyCache = null;
  policyLoading = null;
  roleCache.clear();
}

function invalidatePolicy(): void {
  policyCache = null;
  policyLoading = null;
}

// ----- ロールの読み出し -----

async function readRoleViews(): Promise<RoleView[]> {
  const kv = await getKv();
  const records: RoleRecord[] = [];
  for await (const e of kv.list<RoleRecord>({ prefix: Keys.rolesPrefix() })) {
    records.push(e.value);
  }
  // 名前順。順序は評価に影響しないので、書き出しが安定することだけを見る。
  records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const views: RoleView[] = [];
  for (const record of records) {
    const gen = await kv.get<RoleGeneration>(
      Keys.roleGeneration(record.name, record.generation),
    );
    if (!gen.value) {
      throw new PolicyLoadError(
        `ロール ${record.name} の世代 ${record.generation} が見つかりません`,
      );
    }
    views.push({
      ...record,
      rules: gen.value.rules,
      tests: gen.value.tests,
    });
  }
  return views;
}

function toRenderable(views: readonly RoleView[]): RenderableRole[] {
  return views.map((v) => ({
    name: v.name,
    enabled: v.enabled,
    rules: v.rules,
    tests: v.tests,
  }));
}

/**
 * レコード群をコンパイル済みポリシーにする。テキストを経由するのは、
 * パーサと評価器を 1 系統に保つため (レコード専用の第 2 経路を作らない)。
 */
function compileFrom(views: readonly RoleView[]): CompiledPolicy {
  const text = renderPolicy(toRenderable(views));
  const validation = validatePolicy(text);
  if (validation.errors.length > 0) {
    const detail = validation.errors
      .map((e) => `  ${e.line}行目: ${e.message}`)
      .join("\n");
    throw new PolicyLoadError(
      `保存されているロール定義を解釈できません:\n${detail}`,
    );
  }
  return validation.compiled;
}

export async function getActivePolicy(): Promise<CompiledPolicy> {
  if (policyCache) return policyCache;
  policyLoading ??= (async () => {
    const views = await readRoleViews();
    return views.length === 0 ? emptyPolicy() : compileFrom(views);
  })();
  try {
    const loaded = await policyLoading;
    policyCache = loaded;
    return loaded;
  } finally {
    policyLoading = null;
  }
}

export async function listRoles(): Promise<RoleView[]> {
  return await readRoleViews();
}

export async function getRoleView(name: string): Promise<RoleView | null> {
  const views = await readRoleViews();
  return views.find((v) => foldAscii(v.name) === foldAscii(name)) ?? null;
}

export async function listRoleGenerations(
  name: string,
): Promise<RoleGeneration[]> {
  const kv = await getKv();
  const out: RoleGeneration[] = [];
  const iter = kv.list<RoleGeneration>(
    { prefix: Keys.roleGenerationsPrefix(name) },
    { reverse: true },
  );
  for await (const e of iter) out.push(e.value);
  return out;
}

/**
 * 起動時に 1 度呼ぶ。定義が壊れていればここで throw して起動を止める。
 *
 * 戻り値は「今この瞬間、管理操作ができる人がいるか」。**いない状態でも起動は
 * 止めない** — 初回起動 (seed 前) は正当にこの状態を通るため。ただし黙って
 * 起動すると「全部見えない」だけが観測され、権限設定のバグに見えて誤診される。
 */
export async function loadActivePolicy(): Promise<
  { roleCount: number; hasAdmin: boolean }
> {
  const policy = await getActivePolicy();
  const assignments = await listAssignments();
  return {
    roleCount: policy.roles.size,
    hasAdmin: rootAdminExists(policy, assignments),
  };
}

/** 現在のポリシーで `admin /` を与える (有効な) ロール名。復旧 CLI 用。 */
export async function findAdminRoleNames(): Promise<string[]> {
  const policy = await getActivePolicy();
  return policy.document.roles
    .filter((r) => r.enabled)
    .map((r) => r.name)
    .filter((name) => effectiveLevel(policy, [name], "/") === "admin");
}

/** 取り込み / 書き出し / レビュー用のテキスト表現。 */
export async function exportPolicyText(): Promise<string> {
  const views = await readRoleViews();
  return renderPolicy(toRenderable(views));
}

// ----- 割り当て -----

export async function getUserRoles(userId: number): Promise<readonly string[]> {
  const cached = roleCache.get(userId);
  if (cached) return cached;

  const kv = await getKv();
  const roles: string[] = [];
  const iter = kv.list<true>({ prefix: Keys.userRolesPrefix(userId) });
  for await (const e of iter) roles.push(e.key[2] as string);
  roleCache.set(userId, roles);
  return roles;
}

export async function listAssignments(): Promise<AssignmentMap> {
  const kv = await getKv();
  const map = new Map<number, string[]>();
  const iter = kv.list<true>({ prefix: Keys.userRolesAllPrefix() });
  for await (const e of iter) {
    const userId = e.key[1] as number;
    const roleName = e.key[2] as string;
    const list = map.get(userId);
    if (list) list.push(roleName);
    else map.set(userId, [roleName]);
  }
  return map;
}

export async function getRoleMembers(roleName: string): Promise<number[]> {
  const kv = await getKv();
  const out: number[] = [];
  const iter = kv.list<true>({ prefix: Keys.roleUsersPrefix(roleName) });
  for await (const e of iter) out.push(e.key[2] as number);
  return out;
}

export interface MutationResult {
  readonly ok: boolean;
  /** 却下理由。ok なら undefined。 */
  readonly error?: string;
}

export async function assignRole(
  userId: number,
  roleName: string,
): Promise<MutationResult> {
  const view = await getRoleView(roleName);
  if (!view) {
    return { ok: false, error: `ロール ${roleName} は定義されていません` };
  }
  const kv = await getKv();
  // 表記ゆれで 2 本ぶら下がらないよう、定義側の綴りに正規化して保存する。
  await kv
    .atomic()
    .set(Keys.userRole(userId, view.name), true)
    .set(Keys.roleUser(view.name, userId), true)
    .commit();
  roleCache.delete(userId);
  return { ok: true };
}

export async function unassignRole(
  userId: number,
  roleName: string,
): Promise<MutationResult> {
  const guard = await guardRootAdminSurvives({
    droppedRoles: { userId, roleNames: [roleName] },
  });
  if (guard) return { ok: false, error: guard };

  const kv = await getKv();
  await kv
    .atomic()
    .delete(Keys.userRole(userId, roleName))
    .delete(Keys.roleUser(roleName, userId))
    .commit();
  roleCache.delete(userId);
  return { ok: true };
}

/** ユーザー削除に伴う後始末。admin 不在になるなら拒否する。 */
export async function unassignAllRoles(
  userId: number,
): Promise<MutationResult> {
  const roles = await getUserRoles(userId);
  const guard = await guardRootAdminSurvives({
    droppedRoles: { userId, roleNames: [...roles] },
  });
  if (guard) return { ok: false, error: guard };

  const kv = await getKv();
  const tx = kv.atomic();
  for (const roleName of roles) {
    tx.delete(Keys.userRole(userId, roleName));
    tx.delete(Keys.roleUser(roleName, userId));
  }
  await tx.commit();
  roleCache.delete(userId);
  return { ok: true };
}

// ----- アサーション -----

export async function listAssertions(): Promise<AccessAssertion[]> {
  const kv = await getKv();
  const out: AccessAssertion[] = [];
  const iter = kv.list<AccessAssertion>({ prefix: Keys.assertionsPrefix() });
  for await (const e of iter) out.push(e.value);
  return out;
}

export async function createAssertion(
  input: Omit<AccessAssertion, "id">,
): Promise<{ ok: boolean; assertion?: AccessAssertion; error?: string }> {
  // 作った瞬間に落ちるアサーションは、以後すべてのロール変更を止めてしまう。
  const policy = await getActivePolicy();
  const roles = await getUserRoles(input.userId);
  const failure = checkAssertion(policy, roles, { ...input, id: 0 });
  if (failure) {
    return {
      ok: false,
      error: `現在の設定で既に成立しません: ${failure.message}`,
    };
  }

  const kv = await getKv();
  const counter = await kv.get<number>(Keys.counter("assertions"));
  const id = (counter.value ?? 0) + 1;
  const assertion: AccessAssertion = { ...input, id };
  const res = await kv
    .atomic()
    .check(counter)
    .set(Keys.counter("assertions"), id)
    .set(Keys.assertion(id), assertion)
    .commit();
  if (!res.ok) return { ok: false, error: "競合しました。やり直してください" };
  return { ok: true, assertion };
}

export async function deleteAssertion(id: number): Promise<void> {
  const kv = await getKv();
  await kv.delete(Keys.assertion(id));
}

function describe(level: EffectiveLevel): string {
  return level === null ? "invisible" : level;
}

function checkAssertion(
  policy: CompiledPolicy,
  roles: readonly string[],
  assertion: AccessAssertion,
): AssertionFailure | null {
  const actual = effectiveLevel(policy, roles, assertion.path);
  const passed = assertion.expect === "invisible" ? actual === null : hasAccess(
    actual,
    assertion.expect === "writable"
      ? "write"
      : assertion.expect === "readable"
      ? "read"
      : assertion.expect === "admin"
      ? "admin"
      : "visible",
  );
  if (passed) return null;
  return {
    id: assertion.id,
    userId: assertion.userId,
    path: assertion.path,
    expected: assertion.expect,
    actual: describe(actual),
    message: `user ${assertion.userId}: ${assertion.path} は ` +
      `${assertion.expect} のはずが ${describe(actual)} です`,
  };
}

async function evaluateAssertions(
  policy: CompiledPolicy,
  assignments: AssignmentMap,
): Promise<AssertionFailure[]> {
  const assertions = await listAssertions();
  const out: AssertionFailure[] = [];
  for (const a of assertions) {
    const failure = checkAssertion(policy, assignments.get(a.userId) ?? [], a);
    if (failure) out.push(failure);
  }
  return out;
}

// ----- admin 不在の防止 -----

interface PendingAssignmentChange {
  readonly droppedRoles?: { userId: number; roleNames: readonly string[] };
}

/** 「admin / を与えるロールを持つユーザーが最低 1 人いる」。 */
function rootAdminExists(
  policy: CompiledPolicy,
  assignments: AssignmentMap,
): boolean {
  for (const [, roles] of assignments) {
    if (effectiveLevel(policy, roles, "/") === "admin") return true;
  }
  return false;
}

const NO_ADMIN_MESSAGE =
  "この変更を適用すると admin 権限を持つユーザーが 1 人もいなくなり、" +
  "以後どの管理操作もできなくなります。先に別のユーザーへ admin ロールを" +
  "割り当ててください。";

async function guardRootAdminSurvives(
  change: PendingAssignmentChange,
): Promise<string | null> {
  const policy = await getActivePolicy();
  const assignments = await listAssignments();
  const after = applyChange(assignments, change);
  return rootAdminExists(policy, after) ? null : NO_ADMIN_MESSAGE;
}

function applyChange(
  assignments: AssignmentMap,
  change: PendingAssignmentChange,
): AssignmentMap {
  if (!change.droppedRoles) return assignments;
  const { userId, roleNames } = change.droppedRoles;
  const dropped = new Set(roleNames);
  const next = new Map<number, readonly string[]>(assignments);
  next.set(
    userId,
    (assignments.get(userId) ?? []).filter((r) => !dropped.has(r)),
  );
  return next;
}

// ----- ロールの保存 -----

export interface RoleSaveResult {
  readonly ok: boolean;
  readonly generation?: number;
  readonly errors: readonly PolicyIssue[];
  readonly testFailures: readonly PolicyTestFailure[];
  readonly warnings: readonly PolicyIssue[];
  /** 割り当て層が拒否権を行使した理由。 */
  readonly assertionFailures: readonly AssertionFailure[];
  /** admin 不在など、定義の外側の理由。 */
  readonly rejection?: string;
}

const ROLE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * ロールの候補セット (= 1 つを差し替え / 追加 / 削除した後の全体) を検証する。
 * 検証はロール単体ではなく **常に全体** に対して行う — ロールをまたぐ警告も、
 * admin 不在検査も、アサーションも、全体を見ないと判定できない。
 */
async function validateCandidate(
  candidate: readonly RenderableRole[],
  opts: { skipGuards?: boolean; focusRole?: string } = {},
): Promise<
  Omit<RoleSaveResult, "generation"> & { compiled: CompiledPolicy | null }
> {
  const assignments = await listAssignments();
  const assignedRoleNames = new Set<string>();
  for (const [, roles] of assignments) {
    for (const r of roles) assignedRoleNames.add(r);
  }

  const text = renderPolicy(candidate);
  const validation = validatePolicy(text, { assignedRoleNames });
  // 1 ロールを保存したときに、無関係なロールの警告まで並べない。
  // (一覧画面は全部を見せるので、そちらは絞らない)
  const warnings = opts.focusRole === undefined
    ? validation.warnings
    : validation.warnings.filter(
      (w) =>
        w.role === undefined ||
        foldAscii(w.role) === foldAscii(opts.focusRole!),
    );
  const base = {
    errors: validation.errors,
    testFailures: validation.testFailures,
    warnings,
  };
  if (!validation.ok) {
    return { ok: false, ...base, assertionFailures: [], compiled: null };
  }

  // ブートストラップだけが検査を飛ばせる。「まだ誰にも割り当てていない」
  // 初期状態では admin 不在検査が必ず落ちるため。通常の書き込みは必ず通す。
  if (opts.skipGuards) {
    return {
      ok: true,
      ...base,
      assertionFailures: [],
      compiled: validation.compiled,
    };
  }

  const assertionFailures = await evaluateAssertions(
    validation.compiled,
    assignments,
  );
  if (assertionFailures.length > 0) {
    return { ok: false, ...base, assertionFailures, compiled: null };
  }

  if (!rootAdminExists(validation.compiled, assignments)) {
    return {
      ok: false,
      ...base,
      assertionFailures: [],
      rejection: NO_ADMIN_MESSAGE,
      compiled: null,
    };
  }

  return {
    ok: true,
    ...base,
    assertionFailures: [],
    compiled: validation.compiled,
  };
}

/** 現在のロール群のうち `name` を `replacement` に差し替えた候補を作る。 */
async function candidateWith(
  name: string,
  replacement: RenderableRole | null,
): Promise<RenderableRole[]> {
  const views = await readRoleViews();
  const folded = foldAscii(name);
  const out = toRenderable(views).filter((r) => foldAscii(r.name) !== folded);
  if (replacement) out.push(replacement);
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

export interface SaveRoleInput {
  readonly name: string;
  readonly enabled: boolean;
  readonly definition: RoleDefinition;
  readonly updatedBy: number;
}

/**
 * ロールを 1 つ保存する (新規も更新も同じ経路)。成功すると **新しい世代** が
 * 1 つ積まれ、それが適用中になる。
 */
export async function saveRole(
  input: SaveRoleInput,
  opts: { dryRun?: boolean } = {},
): Promise<RoleSaveResult> {
  if (!ROLE_NAME_RE.test(input.name)) {
    return {
      ok: false,
      errors: [{ line: 0, message: `ロール名として使えません: ${input.name}` }],
      testFailures: [],
      warnings: [],
      assertionFailures: [],
    };
  }

  const candidate = await candidateWith(input.name, {
    name: input.name,
    enabled: input.enabled,
    rules: input.definition.rules,
    tests: input.definition.tests,
  });
  const result = await validateCandidate(candidate, { focusRole: input.name });
  const { compiled, ...report } = result;
  if (!result.ok || !compiled) return report;
  if (opts.dryRun) return report;

  const kv = await getKv();
  const existing = await kv.get<RoleRecord>(Keys.role(input.name));
  const generations = await listRoleGenerations(input.name);
  const generation = generations.length > 0
    ? Math.max(...generations.map((g) => g.generation)) + 1
    : 1;
  const now = new Date().toISOString();

  const tx = kv.atomic()
    .check(existing)
    .set(
      Keys.roleGeneration(input.name, generation),
      {
        generation,
        rules: input.definition.rules,
        tests: input.definition.tests,
        createdAt: now,
        createdBy: input.updatedBy,
      } satisfies RoleGeneration,
    )
    .set(
      Keys.role(input.name),
      {
        name: input.name,
        enabled: input.enabled,
        generation,
        updatedAt: now,
        updatedBy: input.updatedBy,
      } satisfies RoleRecord,
    );

  // 古い世代を落とす。「1 つ前に戻す」が満たせれば十分で、無制限に積む理由がない。
  const keep = new Set(
    [generation, ...generations.map((g) => g.generation)]
      .sort((a, b) => b - a)
      .slice(0, MAX_GENERATIONS),
  );
  for (const g of generations) {
    if (!keep.has(g.generation)) {
      tx.delete(Keys.roleGeneration(input.name, g.generation));
    }
  }

  const res = await tx.commit();
  if (!res.ok) {
    return {
      ...report,
      ok: false,
      rejection: "他の管理者が同じロールを更新しました。読み直してください",
    };
  }
  invalidatePolicy();
  return { ...report, generation };
}

/** 有効・無効の切り替え。定義も割り当ても触らない。 */
export async function setRoleEnabled(
  name: string,
  enabled: boolean,
  updatedBy: number,
): Promise<RoleSaveResult> {
  const view = await getRoleView(name);
  if (!view) {
    return {
      ok: false,
      errors: [{ line: 0, message: `ロール ${name} は定義されていません` }],
      testFailures: [],
      warnings: [],
      assertionFailures: [],
    };
  }

  const candidate = await candidateWith(view.name, {
    name: view.name,
    enabled,
    rules: view.rules,
    tests: view.tests,
  });
  const result = await validateCandidate(candidate, { focusRole: view.name });
  const { compiled, ...report } = result;
  if (!result.ok || !compiled) return report;

  const kv = await getKv();
  // 世代は増やさない。無効化は定義の変更ではなく運用上のスイッチ。
  await kv.set(
    Keys.role(view.name),
    {
      ...view,
      enabled,
      updatedAt: new Date().toISOString(),
      updatedBy,
    } satisfies RoleRecord,
  );
  invalidatePolicy();
  return { ...report, generation: view.generation };
}

/** 適用する世代を切り替える。世代は増えない。 */
export async function activateGeneration(
  name: string,
  generation: number,
  updatedBy: number,
): Promise<RoleSaveResult> {
  const view = await getRoleView(name);
  if (!view) {
    return {
      ok: false,
      errors: [{ line: 0, message: `ロール ${name} は定義されていません` }],
      testFailures: [],
      warnings: [],
      assertionFailures: [],
    };
  }
  const kv = await getKv();
  const gen = await kv.get<RoleGeneration>(
    Keys.roleGeneration(view.name, generation),
  );
  if (!gen.value) {
    return {
      ok: false,
      errors: [{ line: 0, message: `世代 ${generation} は残っていません` }],
      testFailures: [],
      warnings: [],
      assertionFailures: [],
    };
  }

  const candidate = await candidateWith(view.name, {
    name: view.name,
    enabled: view.enabled,
    rules: gen.value.rules,
    tests: gen.value.tests,
  });
  const result = await validateCandidate(candidate, { focusRole: view.name });
  const { compiled, ...report } = result;
  if (!result.ok || !compiled) return report;

  await kv.set(
    Keys.role(view.name),
    {
      ...view,
      generation,
      updatedAt: new Date().toISOString(),
      updatedBy,
    } satisfies RoleRecord,
  );
  invalidatePolicy();
  return { ...report, generation };
}

export async function deleteRole(
  name: string,
): Promise<RoleSaveResult & { removedAssignments?: number }> {
  const view = await getRoleView(name);
  if (!view) {
    return {
      ok: false,
      errors: [{ line: 0, message: `ロール ${name} は定義されていません` }],
      testFailures: [],
      warnings: [],
      assertionFailures: [],
    };
  }

  const candidate = await candidateWith(view.name, null);
  const result = await validateCandidate(candidate);
  const { compiled, ...report } = result;
  if (!result.ok || !compiled) return report;

  const kv = await getKv();
  const members = await getRoleMembers(view.name);
  const tx = kv.atomic().delete(Keys.role(view.name));
  for (const g of await listRoleGenerations(view.name)) {
    tx.delete(Keys.roleGeneration(view.name, g.generation));
  }
  // 宙に浮いた割り当てを残さない。残すと「未定義のロールを指しています」の
  // 警告が永遠に出続け、消す手段が無い。
  for (const userId of members) {
    tx.delete(Keys.userRole(userId, view.name));
    tx.delete(Keys.roleUser(view.name, userId));
  }
  await tx.commit();
  for (const userId of members) roleCache.delete(userId);
  invalidatePolicy();
  return { ...report, removedAssignments: members.length };
}

/**
 * 検証を通さずにロールを 1 つ書き込む。**ブートストラップとテスト専用**。
 *
 * `saveRole` は必ず admin 不在検査を通すが、その検査は「まだ誰にも割り当てて
 * いない」初期状態で必ず落ちる。鶏と卵を切るための低レベル経路を 1 本だけ
 * 用意し、通常の書き込みからは決して使わない。
 */
export async function putRoleUnchecked(
  name: string,
  enabled: boolean,
  definition: RoleDefinition,
  createdBy: number,
): Promise<void> {
  const kv = await getKv();
  const now = new Date().toISOString();
  await kv
    .atomic()
    .set(
      Keys.roleGeneration(name, 1),
      {
        generation: 1,
        rules: definition.rules,
        tests: definition.tests,
        createdAt: now,
        createdBy,
      } satisfies RoleGeneration,
    )
    .set(
      Keys.role(name),
      {
        name,
        enabled,
        generation: 1,
        updatedAt: now,
        updatedBy: createdBy,
      } satisfies RoleRecord,
    )
    .commit();
  invalidatePolicy();
}

// ----- 取り込み / ブートストラップ -----

/**
 * テキストからロール群をまるごと入れ替える。取り込みと、seed / 復旧 CLI 用。
 *
 * **検証はするが admin 不在検査は通さない** — ブートストラップは「まだ誰にも
 * 割り当てられていない」状態を必ず通るため。
 */
export interface ImportResult extends Omit<RoleSaveResult, "generation"> {
  readonly roles: number;
}

/**
 * テキストからロール群をまるごと入れ替える。取り込みと、seed / 復旧 CLI 用。
 *
 * **併合ではなく置き換え**。既存のロールは全部消える。
 *
 * 検査は通常の保存と同じものを通す — 取り込みも「全ロールを差し替える変更」で
 * あって、アサーションを壊すことも admin を消し飛ばすこともできてしまうから。
 * `skipGuards` はブートストラップ (seed / 復旧 CLI) 専用で、「まだ誰にも
 * 割り当てていない」初期状態を通すためだけにある。
 */
export async function importPolicyText(
  text: string,
  createdBy: number,
  opts: { skipGuards?: boolean } = {},
): Promise<ImportResult> {
  const { document, errors: parseErrors } = parsePolicy(text);
  if (parseErrors.length > 0) {
    return {
      ok: false,
      roles: 0,
      errors: parseErrors,
      testFailures: [],
      warnings: [],
      assertionFailures: [],
    };
  }

  const candidate: RenderableRole[] = document.roles.map((role) => ({
    name: role.name,
    enabled: role.enabled,
    rules: role.rules.map((r) => ({ path: r.path, level: r.level })),
    tests: document.tests
      .filter((t) => foldAscii(t.role) === foldAscii(role.name))
      .flatMap((t) => t.cases.map((c) => ({ expect: c.expect, path: c.path }))),
  }));

  const result = await validateCandidate(candidate, opts);
  const { compiled, ...report } = result;
  if (!result.ok || !compiled) return { ...report, roles: 0 };

  const kv = await getKv();
  // 既存を消してから入れる (取り込みは「置き換え」であって併合ではない)。
  for await (const e of kv.list<RoleRecord>({ prefix: Keys.rolesPrefix() })) {
    const tx = kv.atomic().delete(Keys.role(e.value.name));
    for (const g of await listRoleGenerations(e.value.name)) {
      tx.delete(Keys.roleGeneration(e.value.name, g.generation));
    }
    await tx.commit();
  }

  for (const role of candidate) {
    await putRoleUnchecked(role.name, role.enabled, {
      rules: role.rules,
      tests: role.tests,
    }, createdBy);
  }

  invalidatePolicy();
  return { ...report, roles: candidate.length };
}
