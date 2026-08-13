/**
 * ADR-035 パーサの責務:
 *   - 最初のエラーで止めず、1 回のパースで全部のエラー行を返す
 *   - 「誰も推論できない書き方」を構文で禁じる (deny にレベル、role 内の
 *     パス重複、/ 以外の admin)
 *   - パスは行の残り全部 = 空白を含むパスが書ける
 */

import { assert, assertEquals } from "@std/assert";
import { parsePolicy } from "../src/policy/document.ts";
import { validatePolicyPath } from "../src/policy/paths.ts";

Deno.test("parsePolicy: ADR の例をそのまま読める", () => {
  const { document, errors } = parsePolicy(`
# 営業のプロジェクト作業
role sales-project {
  allow  write  /projects
  allow  read   /shared
  deny          /projects/secret
}

test sales-project {
  writable   /projects/spec.md
  readable   /shared/notes.md
  invisible  /projects/secret/inner.txt
}
`);

  assertEquals(errors, []);
  assertEquals(document.roles.length, 1);
  assertEquals(document.roles[0].name, "sales-project");
  assertEquals(document.roles[0].rules.map((r) => [r.path, r.level]), [
    ["/projects", "write"],
    ["/shared", "read"],
    ["/projects/secret", null],
  ]);
  assertEquals(document.tests.length, 1);
  assertEquals(document.tests[0].role, "sales-project");
  assertEquals(document.tests[0].cases.length, 3);
});

Deno.test("parsePolicy: パスに空白を含められる", () => {
  const { document, errors } = parsePolicy(`
role docs {
  allow read /Shared Documents/Q1 Report
}
`);
  assertEquals(errors, []);
  assertEquals(document.roles[0].rules[0].path, "/Shared Documents/Q1 Report");
});

Deno.test("parsePolicy: コメントは行頭 # のみ (パス中の # は生きる)", () => {
  const { document, errors } = parsePolicy(`
   # これはコメント
role tags {
  allow read /notes/#inbox
}
`);
  assertEquals(errors, []);
  assertEquals(document.roles[0].rules[0].path, "/notes/#inbox");
});

Deno.test("parsePolicy: deny はレベルを取らない", () => {
  const { errors } = parsePolicy(`
role r {
  deny read /a
}
`);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].line, 3);
  assert(errors[0].message.includes("レベルを取りません"));
});

Deno.test("parsePolicy: role 内のパス重複は構文エラー (大小文字を畳んで判定)", () => {
  const { errors } = parsePolicy(`
role r {
  allow read /a
  allow write /A
}
`);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].line, 4);
  assert(errors[0].message.includes("重複"));
});

Deno.test("parsePolicy: admin は / 以外に書けない", () => {
  const { errors } = parsePolicy(`
role r {
  allow admin /projects
}
`);
  assertEquals(errors.length, 1);
  assert(errors[0].message.includes("admin は /"));
});

Deno.test("parsePolicy: 不正なパスを拒否する", () => {
  const cases = [
    "projects",
    "/a/../b",
    "/a//b",
    "/a/",
    "/a\\b",
  ];
  for (const path of cases) {
    const { errors } = parsePolicy(`role r {\n  allow read ${path}\n}\n`);
    assertEquals(errors.length, 1, `expected error for ${path}`);
    assertEquals(errors[0].line, 2);
  }
});

Deno.test("parsePolicy: 複数のエラーをまとめて返す", () => {
  const { errors } = parsePolicy(`
role r {
  allow sideways /a
  grant read /b
}
test unknown-verb {
  maybe /c
}
`);
  assertEquals(errors.length, 3);
  assertEquals(errors.map((e) => e.line), [3, 4, 7]);
});

Deno.test("parsePolicy: 閉じ忘れを検出しつつ後続を読み続ける", () => {
  const { document, errors } = parsePolicy(`
role a {
  allow read /a

role b {
  allow read /b
}
`);
  assertEquals(errors.length, 1);
  assert(errors[0].message.includes("閉じて"));
  // 壊れた a は捨て、b は正しく読める。
  assertEquals(document.roles.map((r) => r.name), ["b"]);
});

Deno.test("parsePolicy: ブロック外の行 / 余分な } を拒否", () => {
  const { errors } = parsePolicy(`
allow read /a
}
`);
  assertEquals(errors.length, 2);
  assert(errors[0].message.includes("外には書けません"));
  assert(errors[1].message.includes("対応する {"));
});

Deno.test("parsePolicy: ロール名と test 名の重複を検出", () => {
  const { errors } = parsePolicy(`
role a {
  allow read /a
}
role A {
  allow read /b
}
test a {
  readable /a
}
test a {
  readable /a
}
`);
  assertEquals(errors.length, 2);
  assert(errors[0].message.includes("role A が重複"));
  assert(errors[1].message.includes("test a が重複"));
});

Deno.test("parsePolicy: ブロックの開始行と終了行を持つ (コンソールが範囲差し替えに使う)", () => {
  const { document, errors } = parsePolicy(`# 見出し

role a {
  allow read /a
}

test a {
  readable /a
}
`);
  assertEquals(errors, []);
  assertEquals([document.roles[0].line, document.roles[0].endLine], [3, 5]);
  assertEquals([document.tests[0].line, document.tests[0].endLine], [7, 9]);
});

Deno.test("validatePolicyPath: 制御文字を弾く (往復でのロール注入を防ぐ)", () => {
  // 改行を通すと、レコード → テキスト → パース の往復でパスが別の行として
  // 解釈され、ポリシーに任意のロールを注入できてしまう。
  const injected = "/a" + String.fromCharCode(10) + "role evil {";
  assert(validatePolicyPath(injected)?.includes("制御文字"));
  assert(
    validatePolicyPath("/a" + String.fromCharCode(9))?.includes("制御文字"),
  );
  // 空白は正当なパス文字なので通す
  assertEquals(validatePolicyPath("/Shared Documents/Q1"), null);
});
