import { setKvForTesting } from "../src/kv/store.ts";
import { Keys } from "../src/kv/keys.ts";
import { _clearPeersForTesting } from "../src/services/wsBroadcast.service.ts";
import type { AccessLevel, Group, Permission, User } from "../src/types.ts";

// 安全網: このヘルパが import された時点 (= テスト実行プロセスに乗った時点) で
// シングルトンを in-memory KV で埋めておき、もし誰かが withTestKv を経由せず
// getKv() を呼んでも永続 KV を触らせない。withTestKv は毎回これを上書きする。
const failsafeKv = await Deno.openKv(":memory:");
setKvForTesting(failsafeKv);

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

  const kv = await Deno.openKv(":memory:");
  setKvForTesting(kv);
  try {
    return await fn(kv);
  } finally {
    kv.close();
    // null に戻すと次の getKv() で永続パスが開かれてしまうので、failsafe に戻す。
    setKvForTesting(failsafeKv);
    _clearPeersForTesting();
  }
}

export interface SeedOptions {
  userId: number;
  userName: string;
  groupId: number;
  groupName: string;
  permissions?: Array<{ path: string; accessLevel: AccessLevel }>;
}

/**
 * 認可テストの最小セット: user 1 人 + group 1 つ + 任意の permissions。
 */
export async function seedUser(kv: Deno.Kv, opts: SeedOptions): Promise<void> {
  const user: User = {
    id: opts.userId,
    name: opts.userName,
    passwordHash: "test-hash",
    createdAt: new Date().toISOString(),
  };
  const group: Group = { id: opts.groupId, name: opts.groupName };

  const tx = kv.atomic()
    .set(Keys.user(opts.userId), user)
    .set(Keys.userByName(opts.userName), opts.userId)
    .set(Keys.group(opts.groupId), group)
    .set(Keys.userGroup(opts.userId, opts.groupId), true);

  for (const p of opts.permissions ?? []) {
    tx.set(
      Keys.permission(p.path, opts.groupId),
      { accessLevel: p.accessLevel } satisfies Permission,
    );
  }

  await tx.commit();
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
