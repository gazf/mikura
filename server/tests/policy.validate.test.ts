/**
 * ADR-035 検証の責務:
 *   - ロール単体テストが 1 件でも落ちたら保存を却下する
 *   - 「書いたのに効いていない」設定を警告で見せる (何も削らない deny、
 *     他ロールの allow に負ける deny、テストの無い deny 持ちロール)
 *   - テストのパスは実在検査をしない (まだ無いパスへの主張は正当)
 */

import { assert, assertEquals } from "@std/assert";
import { findDanglingRules, validatePolicy } from "../src/policy/validate.ts";

Deno.test("validatePolicy: 通るポリシーは ok", () => {
  const v = validatePolicy(`
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
  assertEquals(v.errors, []);
  assertEquals(v.testFailures, []);
  assertEquals(v.warnings, []);
  assert(v.ok);
});

Deno.test("validatePolicy: テスト失敗は ok を落とす", () => {
  const v = validatePolicy(`
role r {
  allow read /a
}
test r {
  writable /a
}
`);
  assertEquals(v.errors, []);
  assertEquals(v.testFailures.length, 1);
  assertEquals(v.testFailures[0].expected, "writable");
  assertEquals(v.testFailures[0].actual, "read");
  assertEquals(v.ok, false);
});

Deno.test("validatePolicy: テストは「少なくとも」、invisible だけは「ちょうど無し」", () => {
  const ok = validatePolicy(`
role r {
  allow write /a
}
test r {
  readable /a
}
`);
  assertEquals(ok.testFailures, []);

  // 派生可視性で見えてしまう祖先を invisible と主張したら落ちる
  const ng = validatePolicy(`
role r {
  allow write /a/b
}
test r {
  invisible /a
}
`);
  assertEquals(ng.testFailures.length, 1);
  assertEquals(ng.testFailures[0].actual, "visible");
});

Deno.test("validatePolicy: test が知らないロールを指したらエラー", () => {
  const v = validatePolicy(`
role r {
  allow read /a
}
test typo {
  readable /a
}
`);
  assertEquals(v.errors.length, 1);
  assert(v.errors[0].message.includes("定義されていません"));
  assertEquals(v.ok, false);
});

Deno.test("validatePolicy: 何も削らない deny を警告する", () => {
  const v = validatePolicy(`
role r {
  allow read /a
  deny /b/secret
}
test r {
  invisible /b/secret
}
`);
  assertEquals(v.warnings.length, 1);
  assert(v.warnings[0].message.includes("何も削っていません"));
  // 警告は保存を止めない
  assert(v.ok);
});

Deno.test("validatePolicy: 他ロールの allow に負ける deny を警告する", () => {
  const v = validatePolicy(`
role blocked {
  allow write /projects
  deny /projects/secret
}
test blocked {
  invisible /projects/secret
}
role lead {
  allow read /projects/secret
}
`);
  const messages = v.warnings.map((w) => w.message);
  assert(messages.some((m) => m.includes("打ち消されます")));
  assert(v.ok);
});

Deno.test("validatePolicy: admin ロールとの衝突は警告しない (毎回出て埋もれる)", () => {
  const v = validatePolicy(`
role admins {
  allow admin /
}
test admins {
  admin /
}
role blocked {
  allow write /projects
  deny /projects/secret
}
test blocked {
  invisible /projects/secret
}
`);
  assertEquals(v.warnings, []);
});

Deno.test("validatePolicy: deny を持つのに test が無いロールを警告する", () => {
  const v = validatePolicy(`
role r {
  allow write /a
  deny /a/secret
}
`);
  const messages = v.warnings.map((w) => w.message);
  assert(messages.some((m) => m.includes("test がありません")));
});

Deno.test("validatePolicy: 割り当てを渡すと孤立ロール / 未定義ロールを警告する", () => {
  const v = validatePolicy(
    `
role used {
  allow read /a
}
role unused {
  allow read /b
}
`,
    { assignedRoleNames: ["used", "ghost"] },
  );
  const messages = v.warnings.map((w) => w.message);
  assert(
    messages.some((m) => m.includes("unused は誰にも割り当てられていません")),
  );
  assert(messages.some((m) => m.includes("ghost")));
  assert(v.ok);
});

Deno.test("findDanglingRules: 実在しないパスのルールだけを返す (test は対象外)", () => {
  const v = validatePolicy(`
role r {
  allow read /alive
  allow read /gone
}
test r {
  readable /not-created-yet
}
`);
  const dangling = findDanglingRules(v.compiled, [
    "/alive",
    "/alive/child.txt",
  ]);
  assertEquals(dangling.map((d) => d.path), ["/gone"]);
});

Deno.test("findDanglingRules: 大小文字違いも孤立として拾う…が畳んで一致すれば生存", () => {
  const v = validatePolicy(`
role r {
  allow read /Shared
}
`);
  assertEquals(findDanglingRules(v.compiled, ["/shared"]).length, 0);
  assertEquals(findDanglingRules(v.compiled, ["/sharedd"]).length, 1);
});
