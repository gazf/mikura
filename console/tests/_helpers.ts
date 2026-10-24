import type { ApiClient } from "../src/api/client.ts";
import { createConsoleApp } from "../src/app.ts";
import type { ConsoleConfig } from "../src/config.ts";
import { SESSION_COOKIE, SessionStore } from "../src/session/store.ts";
import { FakeApi } from "./_fakeApi.ts";

export const CSRF_HEADER = "X-Mikura-Console";

export const TEST_CONFIG: ConsoleConfig = {
  host: "127.0.0.1",
  port: 8701,
  apiUrl: "http://127.0.0.1:8700",
  deviceId: "mikura-console",
  cookieSecure: false,
  sessionIdleMs: 30 * 60_000,
  sessionAbsoluteMs: 8 * 3_600_000,
};

export interface Harness {
  app: ReturnType<typeof createConsoleApp>;
  api: FakeApi;
  sessions: SessionStore;
  /** 事前に張った session の cookie ヘッダ値。 */
  cookie: string;
  adminToken: string;
}

/**
 * console app + fake API + 有効な session 1 つを用意する。
 * session を持たない状態を試したいテストは `cookie` を使わなければよい。
 */
export function makeHarness(overrides?: Partial<ConsoleConfig>): Harness {
  const api = new FakeApi();
  const sessions = new SessionStore({
    idleMs: TEST_CONFIG.sessionIdleMs,
    absoluteMs: TEST_CONFIG.sessionAbsoluteMs,
  });
  const config = { ...TEST_CONFIG, ...overrides };
  const app = createConsoleApp({
    config,
    api: api as unknown as ApiClient,
    sessions,
    ui: {
      html: "<!doctype html><title>t</title>",
      js: "// js",
      css: "/* css */",
    },
  });
  const adminToken = "test-admin-token";
  const id = sessions.create(adminToken, 1, "admin");
  return { app, api, sessions, cookie: `${SESSION_COOKIE}=${id}`, adminToken };
}

export interface ReqOptions {
  cookie?: string;
  csrf?: boolean;
  body?: unknown;
}

export function req(
  method: string,
  path: string,
  opts: ReqOptions = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.csrf !== false) headers[CSRF_HEADER] = "1";
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return new Request(`http://console.test${path}`, init);
}
