import { createMiddleware } from "@hono/hono/factory";

export const errorHandler = createMiddleware(async (c, next) => {
  try {
    await next();
  } catch (e) {
    console.error("Unhandled error:", e);
    return c.json(
      { message: e instanceof Error ? e.message : "Internal server error" },
      500,
    );
  }
});
