import { setEphemeralKvForTesting, setKvForTesting } from "../src/kv/store.ts";
import { Keys } from "../src/kv/keys.ts";
import { _clearPeersForTesting } from "../src/services/wsBroadcast.service.ts";
import { _resetAuthCachesForTesting } from "../src/services/auth.service.ts";
import {
  _resetPolicyCachesForTesting,
  assignRole,
  getActivePolicyWithVersion,
  installBootstrapPolicy,
} from "../src/services/policy.service.ts";
import type { AccessLevel, User } from "../src/types.ts";

// 安全網: このヘルパが import された時点 (= テスト実行プロセスに乗った時点) で
// シングルトンを in-memory KV で埋めておき、もし誰かが withTestKv を経由せず
// getKv() / getEphemeralKv() を呼んでも永続 KV を触らせない。
// テストでは persistent と ephemeral の区別は不要 (key namespace で衝突しない)
// ので同じインスタンスを共有させる。本番では別物だが、service ごとの routing
// が正しいかは型と route + コードレビューで保証する。
const failsafeKv = await Deno.openKv(":memory:");
setKvForTesting(failsafeKv);
setEphemeralKvForTesting(failsafeKv);

/**
 * 各テストでクリーンな in-memory KV を用意し、シングルトンを差し替える。
 * モジュールレベルで持っている共有状態 (wsBroadcast の peers Set 等) も
 * テスト前後でリセットして、テスト順序依存・状態漏れを構造的に防ぐ。
 * 終了時に close + failsafe への戻し + ピアクリアまでセットで面倒を見る。
 */
export async function withTestKv<T>(
  fn: (kv: Deno.Kv) => Promise<T> | T,
): Promise<T> {
  // テスト開始前にも一応掃除 (前テストが finally に到達せず終わったケースの保険)
  _clearPeersForTesting();
  _resetAuthCachesForTesting();
  _resetPolicyCachesForTesting();

  const kv = await Deno.openKv(":memory:");
  setKvForTesting(kv);
  setEphemeralKvForTesting(kv);
  try {
    return await fn(kv);
  } finally {
    kv.close();
    // null に戻すと次の getKv() で永続パスが開かれてしまうので、failsafe に戻す。
    setKvForTesting(failsafeKv);
    setEphemeralKvForTesting(failsafeKv);
    _clearPeersForTesting();
    _resetAuthCachesForTesting();
  }
}

export interface SeedOptions {
  userId: number;
  userName: string;
  /** 省略時は `<userName>-role`。ユーザーごとに別ロールになるので衝突しない。 */
  roleName?: string;
  permissions?: Array<{ path: string; accessLevel: AccessLevel }>;
}

/**
 * 認可テストの最小セット: user 1 人 + その user 専用ロール 1 つ (ADR-035)。
 * `permissions` はそのロールの allow ルールになる。
 *
 * ポリシー文書は 1 つしか無いので、複数回呼ぶと既存の文書に role ブロックを
 * 追記する形で積み上がる。
 */
export async function seedUser(kv: Deno.Kv, opts: SeedOptions): Promise<void> {
  const user: User = {
    id: opts.userId,
    name: opts.userName,
    passwordHash: "test-hash",
    createdAt: new Date().toISOString(),
  };

  await kv.atomic()
    .set(Keys.user(opts.userId), user)
    .set(Keys.userByName(opts.userName), opts.userId)
    .commit();

  const roleName = opts.roleName ?? `${opts.userName}-role`;
  await seedRole(roleName, opts.permissions ?? []);
  const assigned = await assignRole(opts.userId, roleName);
  if (!assigned.ok) throw new Error(assigned.error);
}

/**
 * ポリシー文書にロールを 1 つ追記する。同名が既にあれば何もしない
 * (複数ユーザーで 1 ロールを共有するテストのため)。
 */
export async function seedRole(
  roleName: string,
  permissions: Array<{ path: string; accessLevel: AccessLevel }>,
): Promise<void> {
  const { policy } = await getActivePolicyWithVersion();
  if (policy.document.roles.some((r) => r.name === roleName)) return;
  const rules = permissions
    .map((p) => `  allow ${p.accessLevel} ${p.path}`)
    .join("\n");
  const block = `role ${roleName} {\n${rules}\n}\n`;
  await installBootstrapPolicy(policy.text + block, 0);
}

/**
 * テストごとに WSS broadcast の peer 集合を空にしておく。
 * wsBroadcast.service.ts が module-level Set を持つため、テスト間で漏らさない。
 */
export async function clearWsBroadcastPeers(): Promise<void> {
  const mod = await import("../src/services/wsBroadcast.service.ts");
  // _peers は外に出していないため、register/unregister 経由でクリアする手段は無い。
  // 代わりに、テストでは毎回 register したものをテスト終わりに unregister する規律で運用する。
  // この関数は将来的にエクスポートが追加された時のフックとして残しておく。
  void mod;
}
