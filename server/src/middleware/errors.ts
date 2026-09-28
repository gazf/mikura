import { createMiddleware } from "@hono/hono/factory";

export const errorHandler = createMiddleware(async (c, next) => {
  try {
    await next();
  } catch (e) {
    // 想定内のエラーは各ルートが自前で整形して返すので、ここに来るのは
    // **想定外の例外**だけ。その message には内部情報が混ざる (Deno の
    // ファイルシステム例外なら DATA_ROOT の絶対パス、KV 例外なら内部文字列)。
    // 攻撃者が境界値で意図的に例外を誘発して recon に使えるため、詳細は
    // サーバログにのみ残し、クライアントには汎用メッセージを返す。
    console.error("Unhandled error:", e);
    return c.json({ message: "Internal server error" }, 500);
  }
});
