/**
 * `checkPermission` の request-scoped cache (PermissionContext) の効果を
 * 直接測る micro-benchmark。
 *
 * シナリオ: 中規模 tree (50 dir × 4 depth = 200 path) を 1 request 内で
 * 走査する `/tree` の hot loop を模倣する。各 path について read 権限を
 * Promise.all で並列 check し、その総時間を計測する。
 *
 * 比較:
 *   - "no ctx": ctx を渡さない (auth.service.ts の自動 one-shot 経路)
 *     → 毎 check で groupIds + 階層 walk が KV 直撃
 *   - "with ctx": 1 つの PermissionContext を全 check で共有
 *     → 同一 (userId) の groupIds は 1 度だけ fetch、parent path の
 *       permission lookup も in-flight 共有で重複排除
 *
 * 実行:
 *   deno bench --unstable-kv --allow-env --allow-read --allow-write --allow-sys=statfs \
 *     bench/perm-cache.bench.ts
 *
 * 期待効果 (audit レポートより): /tree 1000 entries × 5 groups × depth 3 で
 *   ~15k KV read → ~3k KV read (約 5x reduction) を見込む。本 bench は
 *   moderate scale (200 entries) なので倍率はもう少し控えめに出るはず。
 */

import { setEphemeralKvForTesting, setKvForTesting } from "../src/kv/store.ts";
import { Keys } from "../src/kv/keys.ts";
import {
  checkPermission,
  PermissionContext,
} from "../src/services/auth.service.ts";
import type { Group, Permission, User } from "../src/types.ts";

const USER_ID = 1;
const GROUP_COUNT = 5;
const DIR_COUNT = 50;
const DEPTH = 4;

// /a1, /a1/b1, /a1/b1/c1, /a1/b1/c1/d1 のような階層を生成する。
// DIR_COUNT × DEPTH = 200 path を作る。
function buildPaths(): string[] {
  const paths: string[] = [];
  for (let i = 0; i < DIR_COUNT; i++) {
    let cur = "";
    for (let d = 0; d < DEPTH; d++) {
      cur += `/lvl${d}_${i}`;
      paths.push(cur);
    }
  }
  return paths;
}

const PATHS = buildPaths();

async function seedKv(kv: Deno.Kv): Promise<void> {
  const user: User = {
    id: USER_ID,
    name: "bench-user",
    passwordHash: "",
    createdAt: new Date().toISOString(),
  };
  let tx = kv.atomic().set(Keys.user(USER_ID), user);

  for (let g = 1; g <= GROUP_COUNT; g++) {
    const group: Group = { id: g, name: `bench-group-${g}` };
    tx = tx
      .set(Keys.group(g), group)
      .set(Keys.userGroup(USER_ID, g), true);
  }

  // root に admin 権限。これにより階層 walk は最深まで降りてから root で
  // 当たる動きになる ("most specific から walk up" の最悪に近いケース)。
  const perm: Permission = { accessLevel: "admin" };
  tx = tx.set(Keys.permission("/", 1), perm);

  await tx.commit();
}

const kv = await Deno.openKv(":memory:");
setKvForTesting(kv);
setEphemeralKvForTesting(kv);
await seedKv(kv);

Deno.bench({
  name: `checkPermission ×${PATHS.length} (no ctx, current default)`,
  group: "tree-walk",
  baseline: true,
  async fn() {
    // ctx 引数なしで呼ぶ = 1 check 毎に one-shot ctx が生成され、cache 効果なし。
    // これが現状 (改善前) のコスト構造に相当する。
    await Promise.all(
      PATHS.map((p) => checkPermission(USER_ID, p, "read")),
    );
  },
});

Deno.bench({
  name: `checkPermission ×${PATHS.length} (shared ctx, request-scoped cache)`,
  group: "tree-walk",
  async fn() {
    // 1 request 想定で 1 個の PermissionContext を全 check で共有する
    // (middleware が 1 req に 1 個 set する想定経路)。
    const ctx = new PermissionContext();
    await Promise.all(
      PATHS.map((p) => checkPermission(USER_ID, p, "read", ctx)),
    );
  },
});
