/**
 * ADR-035: ポリシー文書と割り当て層の保管・検証。
 *
 * 文書は **KV に置く versioned document** であってディスク上のファイルではない。
 * ファイルにすると検証・テスト・監査を迂回してその場で書き換えられる — `smb.conf`
 * が運用しづらい理由そのもの。テキストは import / export / レビュー / diff の
 * 表現形式であって、保管場所ではない。
 *
 * 層の向き:
 *   割り当て (ユーザー × ロール) → ロール定義   … 依存してよい
 *   ロール定義 → 割り当て                        … 依存してはいけない
 *
 * したがって「tanaka の /hr/payroll.xlsx は invisible」のような主張は文書ではなく
 * **割り当て層** に置く。それでいて新しい版がこの主張を壊すなら保存を拒否する —
 * consumer-driven contract と同じ形で、提供側は消費者を知らないが、消費者は
 * 破壊的変更を拒否できる。
 */
import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import type { TestExpectation } from "../policy/document.ts";
import {
  type CompiledPolicy,
  type EffectiveLevel,
  effectiveLevel,
  emptyPolicy,
  getRole,
  hasAccess,
} from "../policy/evaluate.ts";
import type { PolicyIssue } from "../policy/document.ts";
import { type PolicyTestFailure, validatePolicy } from "../policy/validate.ts";

export interface PolicyVersion {
  readonly version: number;
  readonly text: string;
  readonly createdAt: string;
  /** 保存した admin の userId。 */
  readonly createdBy: number;
}

/**
 * 割り当て層のアサーション。「このユーザーのこのパスに対する実効水準は
 * 少なくとも / ちょうど これ」。ポリシーの新版がこれを壊すなら保存を却下する。
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
// **複数プロセスで API サーバーを走らせると版がずれる**。ADR-035 の未決事項 5。
// 単一プロセスの間は問題ない。多重化する時は「版番号だけを持続 KV から数秒間隔で
// ポーリングする」形になる — ephemeral KV (`:memory:`) はプロセスを跨がないので
// この問題には効かない (素の Map と可視性が同じで、直列化の分だけ遅い)。
let policyCache: { version: number; policy: CompiledPolicy } | null = null;
let policyLoading: Promise<{ version: number; policy: CompiledPolicy }> | null =
  null;

/** userId → role 名。割り当ての変更は必ずこのモジュールを通るので確実に落とせる。 */
const roleCache = new Map<number, readonly string[]>();

export function _resetPolicyCachesForTesting(): void {
  policyCache = null;
  policyLoading = null;
  roleCache.clear();
}

async function loadFromKv(): Promise<{
  version: number;
  policy: CompiledPolicy;
}> {
  const kv = await getKv();
  const cur = await kv.get<number>(Keys.policyCurrent());
  const version = cur.value ?? 0;
  if (version === 0) {
    // 未 seed。既定は deny なので「誰も何もできない」状態で、これは安全側。
    return { version: 0, policy: emptyPolicy() };
  }
  const record = await kv.get<PolicyVersion>(Keys.policyVersion(version));
  if (!record.value) {
    throw new PolicyLoadError(
      `適用中のポリシー版 ${version} が見つかりません`,
    );
  }
  const validation = validatePolicy(record.value.text);
  if (validation.errors.length > 0) {
    // 保存時に検証しているので通常ここには来ない (= 形式変更か KV 破損)。
    // 全拒否で起動すると権限バグに見えて誤診されるので、起動を止めて理由を出す。
    const detail = validation.errors
      .map((e) => `  ${e.line}行目: ${e.message}`)
      .join("\n");
    throw new PolicyLoadError(
      `保存されているポリシー版 ${version} を解釈できません:\n${detail}`,
    );
  }
  return { version, policy: validation.compiled };
}

/** 起動時に 1 度呼ぶ。壊れた文書ならここで throw して起動を止める。 */
export async function loadActivePolicy(): Promise<void> {
  await getActivePolicyWithVersion();
}

export async function getActivePolicyWithVersion(): Promise<{
  version: number;
  policy: CompiledPolicy;
}> {
  if (policyCache) return policyCache;
  // 並行呼び出しで同じ読み込みを重複させない。
  policyLoading ??= loadFromKv();
  try {
    const loaded = await policyLoading;
    policyCache = loaded;
    return loaded;
  } finally {
    policyLoading = null;
  }
}

export async function getActivePolicy(): Promise<CompiledPolicy> {
  return (await getActivePolicyWithVersion()).policy;
}

export async function listPolicyVersions(): Promise<PolicyVersion[]> {
  const kv = await getKv();
  const out: PolicyVersion[] = [];
  const iter = kv.list<PolicyVersion>(
    { prefix: Keys.policyVersionsPrefix() },
    { reverse: true },
  );
  for await (const e of iter) out.push(e.value);
  return out;
}

export async function getPolicyVersion(
  version: number,
): Promise<PolicyVersion | null> {
  const kv = await getKv();
  const got = await kv.get<PolicyVersion>(Keys.policyVersion(version));
  return got.value ?? null;
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
  const policy = await getActivePolicy();
  const role = getRole(policy, roleName);
  if (!role) {
    return { ok: false, error: `ロール ${roleName} は定義されていません` };
  }
  const kv = await getKv();
  // 表記ゆれで 2 本ぶら下がらないよう、文書側の綴りに正規化して保存する。
  await kv
    .atomic()
    .set(Keys.userRole(userId, role.name), true)
    .set(Keys.roleUser(role.name, userId), true)
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
  // 作った瞬間に落ちるアサーションは、以後すべてのポリシー保存を止めてしまう。
  const policy = await getActivePolicy();
  const roles = await getUserRoles(input.userId);
  const failure = checkAssertion(policy, roles, { ...input, id: 0 });
  if (failure) {
    return {
      ok: false,
      error: `現在のポリシーで既に成立しません: ${failure.message}`,
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
    message:
      `user ${assertion.userId}: ${assertion.path} は ${assertion.expect} の` +
      `はずが ${describe(actual)} です`,
  };
}

/**
 * 提案されたポリシーが割り当て層の主張を壊さないか。
 * 割り当ては現状のものを使う (= ポリシーだけを差し替えた世界を評価する)。
 */
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

/** ADR-035 の不変条件「admin / を与えるロールを持つユーザーが最低 1 人いる」。 */
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
  "以後どの管理操作もできなくなります。先に別のユーザーへ admin ロールを割り当ててください。";

/** 変更後も admin が残るなら null、残らないならメッセージを返す。 */
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

// ----- 保存 -----

export interface PolicySaveResult {
  readonly ok: boolean;
  readonly version?: number;
  readonly errors: readonly PolicyIssue[];
  readonly testFailures: readonly PolicyTestFailure[];
  readonly warnings: readonly PolicyIssue[];
  /** 割り当て層が拒否権を行使した理由。 */
  readonly assertionFailures: readonly AssertionFailure[];
  /** admin 不在など、文書の外側の理由。 */
  readonly rejection?: string;
}

export interface PolicySaveInput {
  readonly text: string;
  readonly createdBy: number;
  /** 楽観的並行制御。渡された版と現在版が違えば拒否する。 */
  readonly expectedVersion?: number;
}

/**
 * 検証 → 割り当て層の拒否権 → admin 不在検査 → コミット。
 * `dryRun` はコンソールの「保存前チェック」用で、KV を一切触らない。
 */
export async function savePolicy(
  input: PolicySaveInput,
  opts: { dryRun?: boolean } = {},
): Promise<PolicySaveResult> {
  const assignments = await listAssignments();
  const assignedRoleNames = new Set<string>();
  for (const [, roles] of assignments) {
    for (const r of roles) assignedRoleNames.add(r);
  }

  const validation = validatePolicy(input.text, { assignedRoleNames });
  const base = {
    errors: validation.errors,
    testFailures: validation.testFailures,
    warnings: validation.warnings,
  };
  if (!validation.ok) {
    return { ok: false, ...base, assertionFailures: [] };
  }

  const assertionFailures = await evaluateAssertions(
    validation.compiled,
    assignments,
  );
  if (assertionFailures.length > 0) {
    return { ok: false, ...base, assertionFailures };
  }

  if (!rootAdminExists(validation.compiled, assignments)) {
    return {
      ok: false,
      ...base,
      assertionFailures: [],
      rejection: NO_ADMIN_MESSAGE,
    };
  }

  const kv = await getKv();
  const cur = await kv.get<number>(Keys.policyCurrent());
  const currentVersion = cur.value ?? 0;
  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== currentVersion
  ) {
    return {
      ok: false,
      ...base,
      assertionFailures: [],
      rejection:
        `他の管理者が版 ${currentVersion} を保存しています。読み直してください`,
    };
  }

  if (opts.dryRun) {
    return {
      ok: true,
      version: currentVersion,
      ...base,
      assertionFailures: [],
    };
  }

  const version = currentVersion + 1;
  const record: PolicyVersion = {
    version,
    text: input.text,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  };
  const res = await kv
    .atomic()
    .check(cur)
    .set(Keys.policyVersion(version), record)
    .set(Keys.policyCurrent(), version)
    .commit();
  if (!res.ok) {
    return {
      ok: false,
      ...base,
      assertionFailures: [],
      rejection: "競合しました。読み直してください",
    };
  }

  policyCache = { version, policy: validation.compiled };
  return { ok: true, version, ...base, assertionFailures: [] };
}

/**
 * seed / 復旧用の無検証書き込み。**ブートストラップ専用** — admin 不在検査は
 * 「まだ誰も割り当てられていない」初回に必ず落ちるため、ここだけは通さない。
 * 文書自体の検証は行う。
 */
export async function installBootstrapPolicy(
  text: string,
  createdBy: number,
): Promise<number> {
  const validation = validatePolicy(text);
  if (!validation.ok) {
    throw new PolicyLoadError(
      `ブートストラップポリシーが不正です: ${
        validation.errors.map((e) => e.message).join(", ")
      }`,
    );
  }
  const kv = await getKv();
  const cur = await kv.get<number>(Keys.policyCurrent());
  const version = (cur.value ?? 0) + 1;
  const record: PolicyVersion = {
    version,
    text,
    createdAt: new Date().toISOString(),
    createdBy,
  };
  await kv
    .atomic()
    .check(cur)
    .set(Keys.policyVersion(version), record)
    .set(Keys.policyCurrent(), version)
    .commit();
  policyCache = { version, policy: validation.compiled };
  return version;
}
