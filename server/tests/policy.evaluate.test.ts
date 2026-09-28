/**
 * ADR-035 評価器の責務:
 *   - role 内は最近傍祖先 1 本で決まり、role 間は max で決まる (= 順序非依存 + 単調)
 *   - deny は「その role の中で継承を切る」だけで、他の role の allow を止めない
 *   - grant した path の祖先は名前だけ見える (派生可視性)。これが無いと
 *     /alice/docs への grant は到達不能で死ぬ
 *   - 照合は ASCII だけを畳む case-insensitive
 */

import { assertEquals } from "@std/assert";
import { parsePolicy } from "../src/policy/document.ts";
import {
  compilePolicy,
  effectiveLevel,
  hasAccess,
  isPinnedPath,
  rulesAnchoredAt,
} from "../src/policy/evaluate.ts";
import {
  hasDotSegment,
  normalizeForMatch,
  selfAndAncestors,
} from "../src/policy/paths.ts";

function compile(text: string) {
  const { document, errors } = parsePolicy(text);
  assertEquals(errors, [], `parse errors: ${JSON.stringify(errors)}`);
  return compilePolicy(document, text);
}

Deno.test("effectiveLevel: 最近傍祖先のルールが決める", () => {
  const p = compile(`
role r {
  allow read /projects
  allow write /projects/a
}
`);
  assertEquals(effectiveLevel(p, ["r"], "/projects"), "read");
  assertEquals(effectiveLevel(p, ["r"], "/projects/b/deep.txt"), "read");
  assertEquals(effectiveLevel(p, ["r"], "/projects/a/deep.txt"), "write");
  assertEquals(effectiveLevel(p, ["r"], "/elsewhere"), null);
});

Deno.test("effectiveLevel: deny は role 内で継承を切る", () => {
  const p = compile(`
role r {
  allow write /projects
  deny /projects/secret
}
`);
  assertEquals(effectiveLevel(p, ["r"], "/projects/secret"), null);
  assertEquals(effectiveLevel(p, ["r"], "/projects/secret/inner.txt"), null);
  assertEquals(effectiveLevel(p, ["r"], "/projects/open.txt"), "write");
});

Deno.test("effectiveLevel: role をまたぐと max で、行順・role 順に依存しない", () => {
  const p = compile(`
role low {
  allow read /projects
}
role high {
  allow write /projects
}
`);
  assertEquals(effectiveLevel(p, ["low", "high"], "/projects"), "write");
  assertEquals(effectiveLevel(p, ["high", "low"], "/projects"), "write");
  // 単調性: role を足して減ることは無い
  assertEquals(effectiveLevel(p, ["high"], "/projects"), "write");
});

Deno.test("effectiveLevel: 他の role の deny は allow を止めない (受け入れた合成の穴)", () => {
  const p = compile(`
role blocked {
  allow write /projects
  deny /projects/secret
}
role lead {
  allow read /projects/secret
}
`);
  assertEquals(effectiveLevel(p, ["blocked"], "/projects/secret"), null);
  assertEquals(
    effectiveLevel(p, ["blocked", "lead"], "/projects/secret"),
    "read",
  );
});

Deno.test("effectiveLevel: grant の真の祖先は名前だけ見える", () => {
  const p = compile(`
role r {
  allow read /alice/docs
}
`);
  assertEquals(effectiveLevel(p, ["r"], "/"), "visible");
  assertEquals(effectiveLevel(p, ["r"], "/alice"), "visible");
  assertEquals(effectiveLevel(p, ["r"], "/alice/docs"), "read");
  assertEquals(effectiveLevel(p, ["r"], "/alice/docs/deep.txt"), "read");
  // 兄弟は見えない = 明示 visible とは違い、1 ノードだけを開ける
  assertEquals(effectiveLevel(p, ["r"], "/alice/private"), null);
  assertEquals(effectiveLevel(p, ["r"], "/bob"), null);
});

Deno.test("effectiveLevel: 到達性については deny より深い grant が勝つ", () => {
  const p = compile(`
role r {
  allow read /a
  deny /a/b
  allow read /a/b/c
}
`);
  assertEquals(effectiveLevel(p, ["r"], "/a/b"), "visible");
  assertEquals(effectiveLevel(p, ["r"], "/a/b/c"), "read");
  assertEquals(effectiveLevel(p, ["r"], "/a/b/other"), null);
});

Deno.test("effectiveLevel: 未知の role 名は無視する", () => {
  const p = compile(`
role r {
  allow read /a
}
`);
  assertEquals(effectiveLevel(p, ["r", "deleted-role"], "/a"), "read");
  assertEquals(effectiveLevel(p, [], "/a"), null);
});

Deno.test("effectiveLevel: 照合はバイト厳密 — 大小文字違いは別のパス", () => {
  // 以前はここが「ASCII を畳んで照合する」を仕様として固定していた。しかし
  // data root は case-sensitive な POSIX FS なので、`/Projects` への grant が
  // `/projects` という**別のディレクトリ**まで許可してしまい、1 パスへの
  // read 権限でデータルート配下の任意のファイルに到達できた。
  const p = compile(`
role r {
  allow read /Projects
}
`);
  assertEquals(effectiveLevel(p, ["r"], "/Projects/a.txt"), "read");
  assertEquals(effectiveLevel(p, ["r"], "/projects/a.txt"), null);
  assertEquals(effectiveLevel(p, ["r"], "/PROJECTS"), null);
});

Deno.test("effectiveLevel: 大小文字だけ違う兄弟には別々のルールを書ける", () => {
  // case-sensitive な FS では別オブジェクトなので、別々に統治できるのが正しい。
  const p = compile(`
role r {
  allow write /pub
  deny        /PUB
}
`);
  assertEquals(effectiveLevel(p, ["r"], "/pub/x"), "write");
  assertEquals(effectiveLevel(p, ["r"], "/PUB/secret"), null);
});

Deno.test("effectiveLevel: 末尾スラッシュや重複スラッシュを吸収する", () => {
  const p = compile(`
role r {
  allow read /a/b
}
`);
  assertEquals(effectiveLevel(p, ["r"], "/a/b/"), "read");
  assertEquals(effectiveLevel(p, ["r"], "//a//b"), "read");
  assertEquals(effectiveLevel(p, ["r"], ""), "visible");
});

Deno.test("hasAccess: invisible < visible < read < write < admin", () => {
  assertEquals(hasAccess(null, "visible"), false);
  assertEquals(hasAccess("visible", "visible"), true);
  assertEquals(hasAccess("visible", "read"), false);
  assertEquals(hasAccess("read", "read"), true);
  assertEquals(hasAccess("read", "write"), false);
  assertEquals(hasAccess("write", "read"), true);
  assertEquals(hasAccess("write", "admin"), false);
  assertEquals(hasAccess("admin", "write"), true);
});

Deno.test("isPinnedPath: ルールが名前を挙げたパスと祖先だけを固定する", () => {
  const p = compile(`
role r {
  allow read /shared/sales
}
`);
  assertEquals(isPinnedPath(p, "/shared/sales"), true);
  assertEquals(isPinnedPath(p, "/shared"), true);
  // 大小文字違いは別のパスなので pin しない。畳んでいた頃は、ルールに無関係な
  // `/SHARED` の rename / delete まで 409 で拒否していた。
  assertEquals(isPinnedPath(p, "/SHARED/Sales"), false);
  assertEquals(isPinnedPath(p, "/SHARED"), false);
  // 配下には伝播しない (伝播させると allow read / 一本で木全体が凍る)
  assertEquals(isPinnedPath(p, "/shared/sales/2026"), false);
  assertEquals(isPinnedPath(p, "/other"), false);
});

Deno.test("rulesAnchoredAt: 確認ダイアログ用にルールを列挙する", () => {
  const p = compile(`
role a {
  allow read /shared/secret
}
role b {
  deny /shared/secret
}
`);
  const hits = rulesAnchoredAt(p, "/shared/secret");
  assertEquals(hits.map((h) => h.role), ["a", "b"]);
  assertEquals(rulesAnchoredAt(p, "/shared"), []);
});

// ───────────── `..` / `.` を含むパスの正規形 (path confusion 回帰) ─────────────
//
// 認可判定の正規化が `..` をリテラルのセグメントとして残すと、
// `/pub/../private/x` の祖先鎖に `/pub` が現れ、`allow read /pub` だけを持つ
// ロールが `/private/x` へ到達できてしまう。実 I/O 側は `path.normalize` で
// 畳むので、両者が別のファイルについて判断していた。

Deno.test("normalizeForMatch: .. を畳んで祖先鎖に許可パスを残さない", () => {
  assertEquals(normalizeForMatch("/pub/../private/x"), "/private/x");
  assertEquals(
    selfAndAncestors(normalizeForMatch("/pub/../private/x")).includes("/pub"),
    false,
  );
});

Deno.test("normalizeForMatch: . と重複スラッシュと末尾 .. を畳む", () => {
  assertEquals(normalizeForMatch("/a/./b"), "/a/b");
  assertEquals(normalizeForMatch("/a//b"), "/a/b");
  assertEquals(normalizeForMatch("/a/b/.."), "/a");
  assertEquals(normalizeForMatch("/a/b/../../c"), "/c");
});

Deno.test("normalizeForMatch: ルートを越える .. はルートに張り付く", () => {
  // 仕様として固定する (投げずに clamp)。入力の妥当性判定は境界の責務。
  assertEquals(normalizeForMatch("/../../etc/passwd"), "/etc/passwd");
  assertEquals(normalizeForMatch("/.."), "/");
  assertEquals(normalizeForMatch("/a/../.."), "/");
});

Deno.test("hasDotSegment: リクエスト境界で落とすべき入力を見分ける", () => {
  assertEquals(hasDotSegment("/a/../b"), true);
  assertEquals(hasDotSegment("/a/./b"), true);
  assertEquals(hasDotSegment("/a/b/.."), true);
  assertEquals(hasDotSegment("/.."), true);
  // ドットで始まるだけの名前は正当なファイル名なので通す。
  assertEquals(hasDotSegment("/a/..b"), false);
  assertEquals(hasDotSegment("/a/.hidden"), false);
  assertEquals(hasDotSegment("/a/b.txt"), false);
});
