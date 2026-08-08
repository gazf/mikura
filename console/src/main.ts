/**
 * console プロセスの entry point。
 *
 * ADR-033: 既定で loopback にしか bind しない。リモートから使うときは SSH
 * ポートフォワードなり overlay network なりを経由させ、公開ポートには決して
 * 出さない。「管理していない間は起動していない」が前提なので、常駐前提の
 * 作り込み (graceful reload 等) はしない。
 */

import { ApiClient } from "./api/client.ts";
import { createConsoleApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { loadUiAssets } from "./routes/static.ts";
import { SessionStore } from "./session/store.ts";

const config = loadConfig();

const uiDir = new URL("./ui", import.meta.url).pathname;
const ui = await loadUiAssets(uiDir);

const app = createConsoleApp({
  config,
  api: new ApiClient(config.apiUrl, config.deviceId),
  sessions: new SessionStore({
    idleMs: config.sessionIdleMs,
    absoluteMs: config.sessionAbsoluteMs,
  }),
  ui,
});

console.log(
  `mikura console on http://${config.host}:${config.port}/console/ ` +
    `(api=${config.apiUrl})`,
);
if (config.host !== "127.0.0.1" && config.host !== "localhost") {
  console.warn(
    `[console] loopback 以外に bind しています (${config.host})。` +
      `TLS の後ろでない場合は MIKURA_CONSOLE_COOKIE_SECURE=true も含めて設定を確認してください。`,
  );
}

Deno.serve({ port: config.port, hostname: config.host }, app.fetch);
