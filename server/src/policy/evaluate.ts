/**
 * ADR-035: ポリシーのコンパイルと評価。
 *
 *   effective(user, path) = max over ( user に割り当てられた role ) of roleLevel(role, path)
 *
 *   roleLevel(role, path) =
 *       その role 内で path の最近傍祖先 (自身を含む) にあるただ 1 本のルール
 *       allow → そのレベル / deny → なし / ルール無し → なし
 *
 * ここから 2 つの性質が出て、どちらも設計を支えている:
 *   - **順序非依存**  role 内はパスの具体度、role 間は max で決まる。行順は結果に
 *     影響しないので、コンソールが順序を露出せずに済み、黙って影に入るルールが無い。
 *   - **role をまたいで単調**  role を足すと必ず増える方向にしか動かない。
 *     「グループに入れたら権限が減った」種のバグが構造的に起きえない。
 *
 * 評価は純粋な計算。コンパイル済みポリシーはメモリに置く前提で、KV は触らない。
 */
import type { AccessLevel } from "../types.ts";
import type { PolicyDocument, RuleLevel } from "./document.ts";
import {
  foldAscii,
  isProperAncestor,
  normalizeForMatch,
  selfAndAncestors,
} from "./paths.ts";

/**
 * 「名前だけ見える」を含めた実効水準。`visible` は書けない — grant の祖先として
 * **導出されるだけ**。書けるようにすると、この設計が消したかった手作業が戻る。
 */
export type EffectiveLevel = AccessLevel | "visible" | null;

const RANK: Record<Exclude<EffectiveLevel, null>, number> = {
  visible: 1,
  read: 2,
  write: 3,
  admin: 4,
};

function rank(level: EffectiveLevel): number {
  return level === null ? 0 : RANK[level];
}

export interface CompiledRole {
  readonly name: string;
  /** 照合用に畳んだパス → レベル (null = deny)。 */
  readonly rules: ReadonlyMap<string, RuleLevel>;
  /** allow ルールのパス (畳み済み)。派生可視性の計算に使う。 */
  readonly grants: readonly string[];
}

export interface CompiledPolicy {
  /** 保存されている原文。コンソールの編集・diff はこれが単位。 */
  readonly text: string;
  readonly document: PolicyDocument;
  /** key は畳んだ role 名。 */
  readonly roles: ReadonlyMap<string, CompiledRole>;
  /**
   * ルールが名前を挙げているパスとその祖先 (畳み済み)。rename / delete を
   * 拒否する対象。**上にだけ伝播し、下には伝播しない** — 配下まで固めると
   * `allow read /` 一本で木全体が凍る。
   */
  readonly pinnedPaths: ReadonlySet<string>;
}

export function compilePolicy(
  document: PolicyDocument,
  text: string,
): CompiledPolicy {
  const roles = new Map<string, CompiledRole>();
  const pinned = new Set<string>();

  for (const role of document.roles) {
    const rules = new Map<string, RuleLevel>();
    const grants: string[] = [];
    for (const rule of role.rules) {
      const key = normalizeForMatch(rule.path);
      rules.set(key, rule.level);
      if (rule.level !== null) grants.push(key);
      for (const a of selfAndAncestors(key)) pinned.add(a);
    }
    roles.set(foldAscii(role.name), { name: role.name, rules, grants });
  }

  return { text, document, roles, pinnedPaths: pinned };
}

/** 空のポリシー。既定は deny なので、これは「誰も何もできない」を意味する。 */
export function emptyPolicy(): CompiledPolicy {
  return {
    text: "",
    document: { roles: [], tests: [] },
    roles: new Map(),
    pinnedPaths: new Set(),
  };
}

export function getRole(
  policy: CompiledPolicy,
  name: string,
): CompiledRole | undefined {
  return policy.roles.get(foldAscii(name));
}

/**
 * role 単体の水準。最近傍祖先のルール 1 本だけが結果を決める
 * (allow → そのレベル / deny → null / 無し → null)。
 */
function roleLevel(role: CompiledRole, normalized: string): AccessLevel | null {
  for (const candidate of selfAndAncestors(normalized)) {
    const hit = role.rules.get(candidate);
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * user の実効水準。`roleNames` は user に割り当てられた role 名 (順不同)。
 * 未知の role 名は黙って無視する — 割り当てが残ったまま role が消えても
 * 評価は落ちない (コンソール側が警告で拾う)。
 */
export function effectiveLevel(
  policy: CompiledPolicy,
  roleNames: Iterable<string>,
  path: string,
): EffectiveLevel {
  const normalized = normalizeForMatch(path);
  let best: EffectiveLevel = null;
  let visible = false;

  for (const name of roleNames) {
    const role = policy.roles.get(foldAscii(name));
    if (!role) continue;
    const level = roleLevel(role, normalized);
    if (level !== null && rank(level) > rank(best)) best = level;
    if (!visible) {
      // 派生可視性: この role が normalized の真下のどこかに grant を持つなら、
      // normalized は名前だけ見える。これが無いと /alice/docs への grant は
      // /alice が不可視で到達できず、死んだ設定になる。
      for (const g of role.grants) {
        if (isProperAncestor(normalized, g)) {
          visible = true;
          break;
        }
      }
    }
  }

  if (best !== null) return best;
  return visible ? "visible" : null;
}

export interface RoleExplanation {
  readonly role: string;
  /** 判定を決めたルールのパス。ルールが無ければ null。 */
  readonly decidedBy: string | null;
  readonly level: AccessLevel | null;
  /** この role の grant によって path が名前だけ見えるか。 */
  readonly derivedVisible: boolean;
}

/**
 * 「なぜこの結果になったか」。role ごとに決め手となったルールを返す。
 * コンソールの前方診断 (「tanaka は /projects/a.txt に書けるか」) 用。
 */
export function explainAccess(
  policy: CompiledPolicy,
  roleNames: Iterable<string>,
  path: string,
): { effective: EffectiveLevel; perRole: RoleExplanation[] } {
  const normalized = normalizeForMatch(path);
  const perRole: RoleExplanation[] = [];
  for (const name of roleNames) {
    const role = policy.roles.get(foldAscii(name));
    if (!role) {
      perRole.push({
        role: name,
        decidedBy: null,
        level: null,
        derivedVisible: false,
      });
      continue;
    }
    let decidedBy: string | null = null;
    let level: AccessLevel | null = null;
    for (const candidate of selfAndAncestors(normalized)) {
      const hit = role.rules.get(candidate);
      if (hit !== undefined) {
        decidedBy = candidate;
        level = hit;
        break;
      }
    }
    perRole.push({
      role: role.name,
      decidedBy,
      level,
      derivedVisible: role.grants.some((g) => isProperAncestor(normalized, g)),
    });
  }
  return { effective: effectiveLevel(policy, roleNames, path), perRole };
}

export function hasAccess(
  granted: EffectiveLevel,
  required: AccessLevel | "visible",
): boolean {
  return rank(granted) >= rank(required);
}

/**
 * ルールに名前を挙げられているパスか。真なら rename / delete を拒否する
 * (ADR-035「ルール保持パスは固定される」)。中身は対象外で通常の権限に従う。
 */
export function isPinnedPath(
  policy: CompiledPolicy,
  path: string,
): boolean {
  const normalized = normalizeForMatch(path);
  // ルート自体はそもそも rename / delete の対象にならないが、判定としては
  // 常に固定扱いで正しい。
  return policy.pinnedPaths.has(normalized);
}

/** そのパスを名前に挙げているルールを列挙する (コンソールの確認ダイアログ用)。 */
export function rulesAnchoredAt(
  policy: CompiledPolicy,
  path: string,
): { role: string; line: number; path: string }[] {
  const normalized = normalizeForMatch(path);
  const out: { role: string; line: number; path: string }[] = [];
  for (const role of policy.document.roles) {
    for (const rule of role.rules) {
      if (normalizeForMatch(rule.path) === normalized) {
        out.push({ role: role.name, line: rule.line, path: rule.path });
      }
    }
  }
  return out;
}
