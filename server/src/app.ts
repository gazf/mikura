import { Hono } from "hono";
import { authMiddleware } from "./middleware/auth.ts";
import { errorHandler } from "./middleware/errors.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerLockRoutes } from "./routes/locks.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerUploadRoutes } from "./routes/uploads.ts";
import { auditLogger } from "./middleware/logger.ts";
import type { AuthUser } from "./services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
  };
};

const app = new Hono<Env>();

// Global middleware
app.use("*", errorHandler);

// Health check (no auth)
app.get("/health", (c) => c.json({ status: "ok" }));

// Auth middleware for all other routes
app.use("*", authMiddleware);
app.use("*", auditLogger);

// Routes
registerFileRoutes(app);
registerLockRoutes(app);
registerEventRoutes(app);
registerUploadRoutes(app);

export default app;
