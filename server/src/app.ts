import { Hono } from "hono";
import { authMiddleware } from "./middleware/auth.ts";
import { errorHandler } from "./middleware/errors.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerLockRoutes } from "./routes/locks.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerUploadRoutes } from "./routes/uploads.ts";
import { registerEnrollRoutes } from "./routes/enroll.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { auditLogger } from "./middleware/logger.ts";
import type { AuthUser, PermissionContext } from "./services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
    permCtx: PermissionContext;
  };
};

const app = new Hono<Env>();

// Global middleware
app.use("*", errorHandler);

// Health check (no auth)
app.get("/health", (c) => c.json({ status: "ok" }));

// Enrollment (no auth — raw secret 自体が single-use credential)
registerEnrollRoutes(app);

// Auth middleware for all other routes
app.use("*", authMiddleware);
app.use("*", auditLogger);

// Routes
registerFileRoutes(app);
registerLockRoutes(app);
registerEventRoutes(app);
registerUploadRoutes(app);
registerAdminRoutes(app);

export default app;
