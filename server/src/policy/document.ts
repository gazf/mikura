/**
 * ADR-035: ポリシー文書の構文。
 *
 *   role sales-project {
 *     allow  write  /projects
 *     allow  read   /shared
 *     deny          /projects/secret
 *   }
 *
 *   test sales-project {
 *     writable   /projects/spec.md
 *     readable   /shared/notes.md
 *     invisible  /projects/secret/inner.txt
 *   }
 *
 * 行の作りは「固定幅の列が先、可変幅のパスが最後」。パスの長さに関係なく
 * 列が揃うのと、パスに空白を含められる (残り全部がパス) のが理由。
 *
 * コメントは **行頭 `#` の行全体のみ**。行末コメントを認めるとパス中の `#` と
 * 区別できなくなるため。
 */
import type { AccessLevel } from "../types.ts";
import { foldAscii, validatePolicyPath } from "./paths.ts";

/** `deny` は level を取らない。部分的な拒否は誰も推論できないので表現できない。 */
export type RuleLevel = AccessLevel | null;

export interface PolicyRule {
  readonly path: string;
  /** `allow <level>` なら level、`deny` なら null。 */
  readonly level: RuleLevel;
  readonly line: number;
}

export interface PolicyRole {
  readonly name: string;
  readonly rules: readonly PolicyRule[];
  /** `role X {` の行。 */
  readonly line: number;
  /** 閉じ `}` の行。コンソールがブロック単位で差し替えるのに使う。 */
  readonly endLine: number;
}

/**
 * テストの期待は「少なくともこの水準」。梯子は
 * invisible < visible < readable < writable < admin。
 *
 * `visible` は ADR 本文の 4 語に加えた 5 つ目。派生可視性 (grant した path の
 * 祖先が名前だけ見える) はこのモデルで一番間違えやすい所なので、それを直接
 * 主張できないと単体テストの意味が薄い。
 */
export type TestExpectation =
  | "invisible"
  | "visible"
  | "readable"
  | "writable"
  | "admin";

export const TEST_EXPECTATIONS: readonly TestExpectation[] = [
  "invisible",
  "visible",
  "readable",
  "writable",
  "admin",
];

export interface PolicyTestCase {
  readonly expect: TestExpectation;
  readonly path: string;
  readonly line: number;
}

export interface PolicyTest {
  readonly role: string;
  readonly cases: readonly PolicyTestCase[];
  readonly line: number;
  readonly endLine: number;
}

export interface PolicyDocument {
  readonly roles: readonly PolicyRole[];
  readonly tests: readonly PolicyTest[];
}

export interface PolicyIssue {
  /** 1 始まり。0 は文書全体に対する指摘。 */
  readonly line: number;
  readonly message: string;
}

export interface ParseResult {
  readonly document: PolicyDocument;
  readonly errors: readonly PolicyIssue[];
}

const ROLE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const ALLOW_LEVELS: ReadonlySet<string> = new Set<AccessLevel>([
  "read",
  "write",
  "admin",
]);

/** 先頭の語と、そこから後ろの「残り全部」に割る。 */
function splitHead(s: string): { head: string; rest: string } {
  const trimmed = s.trimStart();
  const m = /\s/.exec(trimmed);
  if (!m) return { head: trimmed, rest: "" };
  return {
    head: trimmed.slice(0, m.index),
    rest: trimmed.slice(m.index).trim(),
  };
}

/**
 * ポリシー文書をパースする。**投げずに errors を集めて返す** — コンソールは
 * 1 回の保存で全部のエラーを出したいので、最初の 1 件で止めない。
 */
export function parsePolicy(text: string): ParseResult {
  const errors: PolicyIssue[] = [];
  const roles: PolicyRole[] = [];
  const tests: PolicyTest[] = [];

  type Open =
    | { kind: "role"; name: string; line: number; rules: PolicyRule[] }
    | { kind: "test"; name: string; line: number; cases: PolicyTestCase[] };
  let open: Open | null = null;
  /** role 内のパス重複検出用 (照合が case-insensitive なので畳んで持つ)。 */
  let seenPaths = new Map<string, number>();

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i].replace(/\r$/, "");
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    if (line === "}") {
      if (!open) {
        errors.push({ line: lineNo, message: "対応する { がありません" });
        continue;
      }
      if (open.kind === "role") {
        roles.push({
          name: open.name,
          rules: open.rules,
          line: open.line,
          endLine: lineNo,
        });
      } else {
        tests.push({
          role: open.name,
          cases: open.cases,
          line: open.line,
          endLine: lineNo,
        });
      }
      open = null;
      seenPaths = new Map();
      continue;
    }

    const { head, rest } = splitHead(line);

    if (head === "role" || head === "test") {
      if (open) {
        errors.push({
          line: lineNo,
          message: `${open.kind} ${open.name} のブロックが } で閉じていません`,
        });
        // 閉じ忘れは「以降まるごと壊れる」ので、開きかけを捨てて回復する。
        open = null;
        seenPaths = new Map();
      }
      const name = rest.replace(/\{$/, "").trim();
      if (!rest.endsWith("{")) {
        errors.push({ line: lineNo, message: "行末に { が必要です" });
        continue;
      }
      if (!ROLE_NAME_RE.test(name)) {
        errors.push({
          line: lineNo,
          message: name.length === 0
            ? `${head} に名前がありません`
            : `ロール名として使えません: ${name}`,
        });
        continue;
      }
      open = head === "role"
        ? { kind: "role", name, line: lineNo, rules: [] }
        : { kind: "test", name, line: lineNo, cases: [] };
      continue;
    }

    if (!open) {
      errors.push({
        line: lineNo,
        message: "role / test ブロックの外には書けません",
      });
      continue;
    }

    if (open.kind === "role") {
      parseRuleLine(head, rest, lineNo, open.rules, seenPaths, errors);
    } else {
      parseTestLine(head, rest, lineNo, open.cases, errors);
    }
  }

  if (open) {
    errors.push({
      line: open.line,
      message: `${open.kind} ${open.name} のブロックが } で閉じていません`,
    });
  }

  const dupRole = findDuplicateNames(roles.map((r) => ({
    name: r.name,
    line: r.line,
  })));
  for (const d of dupRole) {
    errors.push({ line: d.line, message: `role ${d.name} が重複しています` });
  }
  const dupTest = findDuplicateNames(tests.map((t) => ({
    name: t.role,
    line: t.line,
  })));
  for (const d of dupTest) {
    errors.push({ line: d.line, message: `test ${d.name} が重複しています` });
  }

  return { document: { roles, tests }, errors };
}

function findDuplicateNames(
  items: readonly { name: string; line: number }[],
): { name: string; line: number }[] {
  const seen = new Map<string, number>();
  const dups: { name: string; line: number }[] = [];
  for (const it of items) {
    const key = foldAscii(it.name);
    if (seen.has(key)) dups.push(it);
    else seen.set(key, it.line);
  }
  return dups;
}

function parseRuleLine(
  head: string,
  rest: string,
  lineNo: number,
  out: PolicyRule[],
  seenPaths: Map<string, number>,
  errors: PolicyIssue[],
): void {
  let level: RuleLevel;
  let path: string;

  if (head === "allow") {
    const split = splitHead(rest);
    if (!ALLOW_LEVELS.has(split.head)) {
      errors.push({
        line: lineNo,
        message: split.head.length === 0
          ? "allow には read / write / admin のいずれかが必要です"
          : `不明なレベル: ${split.head}`,
      });
      return;
    }
    level = split.head as AccessLevel;
    path = split.rest;
  } else if (head === "deny") {
    // deny がレベルを取ったように見える書き間違いを黙って通さない。
    const split = splitHead(rest);
    if (ALLOW_LEVELS.has(split.head)) {
      errors.push({
        line: lineNo,
        message: "deny はレベルを取りません (部分的な拒否は表現できません)",
      });
      return;
    }
    level = null;
    path = rest;
  } else {
    errors.push({
      line: lineNo,
      message: `ルール行は allow / deny で始めてください: ${head}`,
    });
    return;
  }

  const pathError = validatePolicyPath(path);
  if (pathError) {
    errors.push({ line: lineNo, message: pathError });
    return;
  }
  if (level === "admin" && path !== "/") {
    errors.push({
      line: lineNo,
      message: "admin は / にしか書けません",
    });
    return;
  }

  // 同じ role 内の同じパスは「解決できない引き分け」なので構文エラー。
  const folded = foldAscii(path);
  const prev = seenPaths.get(folded);
  if (prev !== undefined) {
    errors.push({
      line: lineNo,
      message: `${path} のルールが ${prev} 行目と重複しています`,
    });
    return;
  }
  seenPaths.set(folded, lineNo);
  out.push({ path, level, line: lineNo });
}

function parseTestLine(
  head: string,
  rest: string,
  lineNo: number,
  out: PolicyTestCase[],
  errors: PolicyIssue[],
): void {
  if (!(TEST_EXPECTATIONS as readonly string[]).includes(head)) {
    errors.push({
      line: lineNo,
      message: `テスト行は ${
        TEST_EXPECTATIONS.join(" / ")
      } で始めてください: ${head}`,
    });
    return;
  }
  const pathError = validatePolicyPath(rest);
  if (pathError) {
    errors.push({ line: lineNo, message: pathError });
    return;
  }
  // テストのパスは実在検査をしない (まだ無いパスへの主張は正当)。
  out.push({ expect: head as TestExpectation, path: rest, line: lineNo });
}
