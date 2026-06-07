/**
 * Loopback bench 用の env / KV / server orchestration ヘルパ。
 *
 * 動作:
 *   1. tmpfs (デフォルト /dev/shm) に DATA_ROOT / STAGING_ROOT を作る
 *   2. tmpfs に MIKURA_KV_PATH 用の隔離 sqlite を置く
 *   3. その sqlite に admin user + group + token + permission を seed する
 *   4. server を子 process として spawn し、/health が通るまで待つ
 *   5. teardown 時に dirs / sqlite / 子 process を片付ける
 *
 * このモジュール自体は `Deno.openKv()` を直接叩き、共有 store.ts singleton には
 * 触らない (bench harness と server は別 process なので singleton 共有しない)。
 */

import { Keys } from "../src/kv/keys.ts";
import { hashToken } from "../src/services/auth.service.ts";
import type { Group, Permission, TokenData, User } from "../src/types.ts";

export interface BenchEnv {
  dataRoot: string;
  stagingRoot: string;
  kvPath: string;
  port: number;
  baseUrl: string;
  token: string;
  deviceId: string;
  userId: number;
  cleanup: () => Promise<void>;
}

export interface SetupOptions {
  /** tmpfs root (default /dev/shm). */
  tmpfsRoot?: string;
  /** server listen port (default 18700; avoid colliding with dev :8700). */
  port?: number;
  /** spawn server subprocess. false にすると caller 側で server を持ち込む。 */
  spawnServer?: boolean;
}

function rand(): string {
  return crypto.randomUUID().slice(0, 8);
}

async function seedAdminUser(
  kvPath: string,
): Promise<{ userId: number; rawToken: string }> {
  const kv = await Deno.openKv(kvPath);
  try {
    // counter (users)
    const userId = 1;
    const groupId = 1;
    const user: User = {
      id: userId,
      name: "bench-admin",
      passwordHash: "",
      createdAt: new Date().toISOString(),
    };
    const group: Group = { id: groupId, name: "bench-admins" };
    const rawToken = crypto.randomUUID();
    const tokenHash = await hashToken(rawToken);
    const tokenData: TokenData = {
      userId,
      name: "bench-token",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    const perm: Permission = { accessLevel: "admin" };

    const tx = await kv.atomic()
      .set(Keys.counter("users"), userId)
      .set(Keys.counter("groups"), groupId)
      .set(Keys.user(userId), user)
      .set(Keys.userByName(user.name), userId)
      .set(Keys.group(groupId), group)
      .set(Keys.userGroup(userId, groupId), true)
      .set(Keys.permission("/", groupId), perm)
      .set(Keys.token(tokenHash), tokenData)
      .set(Keys.tokenByUser(userId, tokenHash), true)
      .commit();
    if (!tx.ok) throw new Error("seed atomic commit failed");
    return { userId, rawToken };
  } finally {
    kv.close();
  }
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/health`);
      if (r.ok) {
        await r.body?.cancel();
        return;
      }
      await r.body?.cancel();
    } catch (_) {
      // server まだ listen 前: short backoff
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not become healthy within ${timeoutMs}ms`);
}

export async function setupBenchEnv(opts: SetupOptions = {}): Promise<BenchEnv> {
  const tmpfs = opts.tmpfsRoot ?? "/dev/shm";
  const tag = `mikura-bench-${rand()}`;
  const dataRoot = `${tmpfs}/${tag}-data`;
  const stagingRoot = `${tmpfs}/${tag}-staging`;
  const kvPath = `${tmpfs}/${tag}-kv.sqlite`;
  const port = opts.port ?? 18700;
  const baseUrl = `http://127.0.0.1:${port}`;
  const deviceId = "bench-device-loopback-01";

  await Deno.mkdir(dataRoot, { recursive: true });
  await Deno.mkdir(stagingRoot, { recursive: true });

  const { userId, rawToken } = await seedAdminUser(kvPath);

  let serverProc: Deno.ChildProcess | null = null;
  if (opts.spawnServer !== false) {
    const env: Record<string, string> = {
      ...Deno.env.toObject(),
      MIKURA_PORT: String(port),
      MIKURA_DATA_ROOT: dataRoot,
      MIKURA_STAGING_ROOT: stagingRoot,
      MIKURA_KV_PATH: kvPath,
    };
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        // bench harness は tmpfs / 一時 sqlite に書くので permission を細かく
        // 絞らず --allow-all で起動する (隔離は env / fs path 側でやる)。
        "--allow-all",
        "--unstable-kv",
        new URL("../src/main.ts", import.meta.url).pathname,
      ],
      env,
      stdout: "null",
      stderr: "null",
    });
    serverProc = cmd.spawn();
    await waitForHealth(baseUrl, 8000);
  }

  return {
    dataRoot,
    stagingRoot,
    kvPath,
    port,
    baseUrl,
    token: rawToken,
    deviceId,
    userId,
    async cleanup() {
      if (serverProc) {
        try {
          serverProc.kill("SIGTERM");
          await serverProc.status;
        } catch (_) { /* already gone */ }
      }
      await Deno.remove(dataRoot, { recursive: true }).catch(() => {});
      await Deno.remove(stagingRoot, { recursive: true }).catch(() => {});
      await Deno.remove(kvPath).catch(() => {});
      // sqlite WAL / SHM もまとめて落とす
      await Deno.remove(`${kvPath}-shm`).catch(() => {});
      await Deno.remove(`${kvPath}-wal`).catch(() => {});
    },
  };
}

export function authHeaders(env: BenchEnv): HeadersInit {
  return {
    "Authorization": `Bearer ${env.token}`,
    "X-Device-Id": env.deviceId,
  };
}
