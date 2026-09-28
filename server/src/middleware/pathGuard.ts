import { createMiddleware } from "@hono/hono/factory";
import { hasDotSegment } from "../policy/paths.ts";

/**
 * リクエストパスに `.` / `..` セグメントを含む要求を入口で落とす。
 *
 * 認可判定 (`normalizeForMatch` → `selfAndAncestors`) と実 I/O
 * (`resolveAndValidate`) は別々に正規化するので、`..` の扱いが片方でも
 * 食い違うと `<許可パス>/../<被害者パス>` でポリシーを丸ごと迂回できる
 * (祖先鎖には許可パスが現れ、実ファイルは別物が開く)。両者の正規化を
 * 一致させ続けるより、**入力を境界で落とす**方が構造的に安全で、後から
 * ルートが増えても同じ穴が開かない。
 *
 * 正規クライアントはツリーから組み立てたパスしか送らないので `..` は現れない。
 * `%2E%2E` 等で符号化されていても Hono の `c.req.path` は decode 済みなので
 * ここで捕まる。
 */
export const pathGuard = createMiddleware(async (c, next) => {
  if (hasDotSegment(c.req.path)) {
    return c.json({ message: "Invalid path" }, 400);
  }
  await next();
});
