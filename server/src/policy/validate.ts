/**
 * ADR-035: 保存時の検証。
 *
 *   - エラー   構文 / test の未知ロール / role 内のパス重複 / admin が / 以外 / 不正パス
 *   - 警告     何も削らない deny、テストの無い deny 持ちロール、他ロールの allow に
 *              負ける deny、メンバーのいないロール、未知ロールへの割り当て
 *   - 却下     ロール単体テストの失敗 (割り当て層のアサーション検査は呼び出し側)
 *
 * 「ロール単体テストは文書の中、ユーザや合成に関する主張は割り当て層」。
 * ポリシー文書はユーザを知ってはいけない — 割り当てはロールに依存してよいが、
 * 逆は依存してはいけない。
 */
import {
  parsePolicy,
  type PolicyIssue,
  type PolicyRole,
  type PolicyTestCase,
} from "./document.ts";
import {
  type CompiledPolicy,
  compilePolicy,
  type EffectiveLevel,
  effectiveLevel,
  hasAccess,
  roleOnlyLevel,
} from "./evaluate.ts";
import { foldAscii, isProperAncestor, normalizeForMatch } from "./paths.ts";

export interface PolicyTestFailure extends PolicyIssue {
  readonly role: string;
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

export interface PolicyValidation {
  /** errors と testFailures が両方空なら保存してよい。 */
  readonly ok: boolean;
  readonly errors: readonly PolicyIssue[];
  readonly testFailures: readonly PolicyTestFailure[];
  readonly warnings: readonly PolicyIssue[];
  /** 構文エラーがあっても、パースできた範囲でコンパイルしたものを返す。 */
  readonly compiled: CompiledPolicy;
}

export interface ValidateOptions {
  /** 割り当て層に存在するロール名。メンバー不在・未知ロールの警告に使う。 */
  readonly assignedRoleNames?: Iterable<string>;
}

function describe(level: EffectiveLevel): string {
  return level === null ? "invisible" : level;
}

export function validatePolicy(
  text: string,
  opts: ValidateOptions = {},
): PolicyValidation {
  const { document, errors: parseErrors } = parsePolicy(text);
  const compiled = compilePolicy(document, text);
  const errors: PolicyIssue[] = [...parseErrors];
  const warnings: PolicyIssue[] = [];
  const testFailures: PolicyTestFailure[] = [];

  const roleByFolded = new Map(
    document.roles.map((r) => [foldAscii(r.name), r]),
  );

  // --- エラー: test が知らないロールを指している ---
  for (const test of document.tests) {
    if (!roleByFolded.has(foldAscii(test.role))) {
      errors.push({
        line: test.line,
        message: `test の対象ロールが定義されていません: ${test.role}`,
      });
    }
  }

  // --- ロール単体テスト ---
  const testedRoles = new Set<string>();
  for (const test of document.tests) {
    const role = roleByFolded.get(foldAscii(test.role));
    if (!role) continue;
    testedRoles.add(foldAscii(role.name));
    for (const c of test.cases) {
      const failure = runTestCase(compiled, role.name, c);
      if (failure) testFailures.push(failure);
    }
  }

  // --- 警告 ---
  for (const role of document.roles) {
    collectDenyWarnings(role, testedRoles, warnings);
    if (!role.enabled) {
      warnings.push({
        line: role.line,
        message:
          `ロール ${role.name} は無効です (割り当ては残りますが権限は与えません)`,
      });
    }
  }
  collectCrossRoleDenyWarnings(document.roles, compiled, warnings);

  if (opts.assignedRoleNames) {
    const assigned = new Set<string>();
    for (const n of opts.assignedRoleNames) assigned.add(foldAscii(n));
    for (const role of document.roles) {
      if (!assigned.has(foldAscii(role.name))) {
        warnings.push({
          line: role.line,
          message: `ロール ${role.name} は誰にも割り当てられていません`,
        });
      }
    }
    for (const name of assigned) {
      if (!roleByFolded.has(name)) {
        warnings.push({
          line: 0,
          message: `割り当てが未定義のロールを指しています: ${name}`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0 && testFailures.length === 0,
    errors,
    testFailures,
    warnings,
    compiled,
  };
}

function runTestCase(
  policy: CompiledPolicy,
  roleName: string,
  c: PolicyTestCase,
): PolicyTestFailure | null {
  // 無効化されていてもテストは走る。テストはロールの意味の記述であって、
  // 運用上の on/off とは別のもの。
  const actual = roleOnlyLevel(policy, roleName, c.path);
  // invisible だけは「ちょうど無し」。他は「少なくともこの水準」。
  const passed = c.expect === "invisible" ? actual === null : hasAccess(
    actual,
    c.expect === "writable"
      ? "write"
      : c.expect === "readable"
      ? "read"
      : c.expect === "admin"
      ? "admin"
      : "visible",
  );
  if (passed) return null;
  return {
    line: c.line,
    role: roleName,
    path: c.path,
    expected: c.expect,
    actual: describe(actual),
    message: `${roleName}: ${c.path} は ${c.expect} のはずが ${
      describe(actual)
    } です`,
  };
}

function collectDenyWarnings(
  role: PolicyRole,
  testedRoles: ReadonlySet<string>,
  warnings: PolicyIssue[],
): void {
  const denies = role.rules.filter((r) => r.level === null);
  if (denies.length === 0) return;

  for (const deny of denies) {
    const target = normalizeForMatch(deny.path);
    const covered = role.rules.some((r) =>
      r.level !== null && isProperAncestor(normalizeForMatch(r.path), target)
    );
    if (!covered) {
      warnings.push({
        line: deny.line,
        message:
          `deny ${deny.path} は同じロール内に上位の allow が無いため何も削っていません`,
      });
    }
  }

  if (!testedRoles.has(foldAscii(role.name))) {
    warnings.push({
      line: role.line,
      message: `deny を持つロール ${role.name} に test がありません`,
    });
  }
}

/**
 * deny は **1 つの role の中で継承を切る** ものであって、ポリシー全体からの
 * 減算ではない。したがって role A の deny は role B の allow を止めない。
 * この合成の穴は設計上受け入れたものなので、静的な警告で見えるようにする。
 */
function collectCrossRoleDenyWarnings(
  roles: readonly PolicyRole[],
  policy: CompiledPolicy,
  warnings: PolicyIssue[],
): void {
  for (const role of roles) {
    for (const deny of role.rules) {
      if (deny.level !== null) continue;
      const others = roles.filter((r) => r !== role).map((r) => r.name);
      if (others.length === 0) continue;
      const level = effectiveLevel(policy, others, deny.path);
      // admin は定義上どこにでも届くので、これを指摘すると deny を書くたびに
      // 管理者ロールとの衝突が出て、本当に見るべき警告が埋もれる。
      if (level !== null && level !== "visible" && level !== "admin") {
        warnings.push({
          line: deny.line,
          message:
            `deny ${deny.path} は他のロールの allow (${level}) に打ち消されます。` +
            `両方を持つユーザーからは見えます`,
        });
      }
    }
  }
}

/**
 * 実在しないパスを指しているルールを探す。タイポ・大小文字違い・削除・
 * API 外の mv の 4 つを 1 つの信号にまとめる。**テストのパスは対象外** —
 * テストはポリシー関数を評価するものでファイルシステムを見ていない。
 */
export function findDanglingRules(
  policy: CompiledPolicy,
  existingPaths: Iterable<string>,
): { role: string; path: string; line: number }[] {
  const existing = new Set<string>();
  for (const p of existingPaths) existing.add(normalizeForMatch(p));
  existing.add("/");

  const out: { role: string; path: string; line: number }[] = [];
  for (const role of policy.document.roles) {
    for (const rule of role.rules) {
      if (!existing.has(normalizeForMatch(rule.path))) {
        out.push({ role: role.name, path: rule.path, line: rule.line });
      }
    }
  }
  return out;
}
