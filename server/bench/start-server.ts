/**
 * E2E bench 用に「tmpfs DATA_ROOT + 隔離 KV + admin token」状態の server を
 * 起動して URL / token / X-Device-Id を stdout に出し、SIGTERM 待ちで blocking する。
 *
 *   1) (この script の標準出力) URL=...  TOKEN=...  DEVICE=...
 *   2) (caller 側) その値を読んで CoalescerBench を `--backend=http` で走らせる
 *   3) Ctrl-C で stop → cleanup
 *
 * 実行:
 *   deno run --allow-all --unstable-kv bench/start-server.ts [--port=18700]
 */

import { setupBenchEnv } from "./_setup.ts";

const port = (() => {
  for (const a of Deno.args) {
    if (a.startsWith("--port=")) return parseInt(a.slice(7), 10);
  }
  return 18700;
})();

const env = await setupBenchEnv({ port });
console.log(`URL=${env.baseUrl}`);
console.log(`TOKEN=${env.token}`);
console.log(`DEVICE=${env.deviceId}`);
console.log(`DATA_ROOT=${env.dataRoot}`);
console.log(`# Press Ctrl-C to stop and cleanup.`);

const stopped = Promise.withResolvers<void>();
Deno.addSignalListener("SIGTERM", () => stopped.resolve());
Deno.addSignalListener("SIGINT", () => stopped.resolve());
await stopped.promise;

await env.cleanup();
