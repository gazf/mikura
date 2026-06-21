/**
 * `wildcardPath` の責務 (route の mount prefix を剥がして "/ から始まる相対パス" を返す):
 *
 *   - mount prefix + sub-path から相対パスを切り出す (`/files/foo.txt` → `/foo.txt`)
 *   - 深い path もそのまま (`/files/a/b/c.txt` → `/a/b/c.txt`)
 *   - 末尾スラッシュのみ (`/files/`) と mount root のみ (`/files`) は両方 `/` に正規化
 *   - Hono が percent-decode 済みの状態で渡ってくる前提なので、日本語名は decode された
 *     literal がそのまま出る (`/files/あ.txt` → `/あ.txt`)
 *   - encoded slash (`%2F`) は Hono が保護して decode しないため、helper も保護を維持
 *     (path segment 内 slash の意図せぬ昇格を防ぐ)
 *   - 旧 regex 実装 (`c.req.path.replace(/^\/files\/?/, "")` + `"/" + ...`) と
 *     **同一の文字列**を返すことを protected case で固定 (resolveAndValidate に
 *     渡る入力が変わらないことの保証)
 */
import { assertEquals } from "@std/assert";
import { wildcardPath } from "../src/routes/files.ts";

Deno.test("wildcardPath: 通常のサブパス", () => {
  assertEquals(wildcardPath("/files/foo.txt", "/files"), "/foo.txt");
  assertEquals(wildcardPath("/files/a/b/c.txt", "/files"), "/a/b/c.txt");
});

Deno.test("wildcardPath: 末尾スラッシュのみ (`/files/`) → ルート", () => {
  assertEquals(wildcardPath("/files/", "/files"), "/");
});

Deno.test("wildcardPath: mount root のみ (`/files`) → ルート", () => {
  // Hono の `/files/*` route は `/files` (trailing slash 無し) にもマッチするため、
  // helper も `/` を返すことで handler の下流処理 (root list 等) を一貫させる。
  assertEquals(wildcardPath("/files", "/files"), "/");
});

Deno.test("wildcardPath: 日本語ファイル名 (Hono decode 済み前提)", () => {
  // `c.req.path` は Hono が `%E3%81%82` を `あ` に decode 済みの値を返す。
  // helper は decode に関与しないので、そのまま透過する。
  assertEquals(wildcardPath("/files/あ.txt", "/files"), "/あ.txt");
  assertEquals(
    wildcardPath("/files/サブ/フォルダ", "/files"),
    "/サブ/フォルダ",
  );
});

Deno.test("wildcardPath: encoded slash (%2F) は decode されず保護", () => {
  // Hono は path separator structure 保護のため `%2F` のみ decode しない。
  // helper も保護を維持して、segment 内 slash が意図せず separator に昇格しない
  // ことを確認する (旧 regex 実装と同じ挙動)。
  assertEquals(
    wildcardPath("/files/dir%2Ffile", "/files"),
    "/dir%2Ffile",
  );
});

Deno.test("wildcardPath: スペースを含む path", () => {
  // `%20` (space) は Hono が decode する典型例。
  assertEquals(
    wildcardPath("/files/with space.txt", "/files"),
    "/with space.txt",
  );
});

Deno.test("wildcardPath: prefix 違い (/content, /folders) でも同じ規律", () => {
  assertEquals(wildcardPath("/content/foo.bin", "/content"), "/foo.bin");
  assertEquals(wildcardPath("/folders/new-dir", "/folders"), "/new-dir");
  assertEquals(wildcardPath("/folders/", "/folders"), "/");
});

Deno.test("wildcardPath: 旧 regex 実装と同等出力 (regression guard)", () => {
  // 「`replace(/^\/files\/?/, "")` + `"/" + ...`」と本 helper が同一文字列を
  // 返すことを、実際に両方計算して比較する形で固定。今後 helper を最適化する
  // 時の安全網。
  const legacy = (reqPath: string, mount: string) => {
    const re = new RegExp(`^${mount}/?`);
    return "/" + reqPath.replace(re, "");
  };
  const cases: Array<[string, string]> = [
    ["/files/foo.txt", "/files"],
    ["/files/a/b/c", "/files"],
    ["/files/あ.txt", "/files"],
    ["/files/dir%2Ffile", "/files"],
    ["/files/with space.txt", "/files"],
    ["/files/", "/files"],
    ["/files", "/files"],
    ["/content/x", "/content"],
    ["/folders/y/z", "/folders"],
  ];
  for (const [p, m] of cases) {
    assertEquals(
      wildcardPath(p, m),
      legacy(p, m),
      `mismatch for path=${p} mount=${m}`,
    );
  }
});
