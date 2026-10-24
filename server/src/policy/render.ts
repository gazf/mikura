/**
 * ロールのレコードからポリシー文書のテキストを組み立てる (ADR-036)。
 *
 * 保管の実体はロール 1 つ = 1 レコードで、テキストは **そこから決定的に導出される
 * 派生物**。取り込み / 書き出し / レビューの表現であって保管場所ではない。
 *
 * この向きにしたおかげで、パーサ・評価器・検証・ロール単体テストは
 * 一切変えずに済んでいる (レコード → テキスト → パース → コンパイル)。
 */
import type { AccessLevel } from "../types.ts";
import type { TestExpectation } from "./document.ts";

export interface RoleRule {
  readonly path: string;
  /** `null` は deny。 */
  readonly level: AccessLevel | null;
}

export interface RoleTestCase {
  readonly expect: TestExpectation;
  readonly path: string;
}

/** ロールの中身。世代として保存される単位でもある。 */
export interface RoleDefinition {
  readonly rules: readonly RoleRule[];
  readonly tests: readonly RoleTestCase[];
}

export interface RenderableRole extends RoleDefinition {
  readonly name: string;
  readonly enabled: boolean;
}

const LEVEL_WIDTH = 6;

/** ロール 1 つ分。固定幅の列が先、可変幅のパスが最後。 */
export function renderRole(role: RenderableRole): string {
  const lines: string[] = [];
  lines.push(`${role.enabled ? "" : "disabled "}role ${role.name} {`);
  for (const rule of role.rules) {
    if (rule.level === null) {
      lines.push(`  deny   ${" ".repeat(LEVEL_WIDTH)} ${rule.path}`);
    } else {
      lines.push(`  allow  ${rule.level.padEnd(LEVEL_WIDTH)} ${rule.path}`);
    }
  }
  lines.push("}");

  if (role.tests.length > 0) {
    const width = Math.max(...role.tests.map((t) => t.expect.length));
    lines.push("");
    lines.push(`test ${role.name} {`);
    for (const t of role.tests) {
      lines.push(`  ${t.expect.padEnd(width)}  ${t.path}`);
    }
    lines.push("}");
  }
  return lines.join("\n");
}

const HEADER = `# mikura のアクセス制御ポリシー (ADR-035 / ADR-036)
#
# この文書はロールのレコードから生成されています。編集は管理コンソールから
# 行ってください。取り込み時のみ、このテキストが入力になります。
`;

export function renderPolicy(roles: readonly RenderableRole[]): string {
  if (roles.length === 0) return HEADER;
  return `${HEADER}\n${roles.map(renderRole).join("\n\n")}\n`;
}
