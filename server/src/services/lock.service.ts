import { getEphemeralKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import { broadcastLockEvent } from "./wsBroadcast.service.ts";
import type { LockData } from "../types.ts";

// ADR-018: Liveness 管理は WSS heartbeat による KV expireIn の延長で行う。
// 30 秒は heartbeat 10 秒間隔 × 3 回分の猶予 (一時的なネット断 2 回まで耐える)。
const LOCK_TTL_MS = 30 * 1000;

export interface LockResult {
  success: boolean;
  lock?: LockData;
  message?: string;
}

export async function acquireLock(
  filePath: string,
  userId: number,
  deviceId: string,
  timeoutMs: number = LOCK_TTL_MS,
): Promise<LockResult> {
  const kv = await getEphemeralKv();
  const key = Keys.lock(filePath);

  const existing = await kv.get<LockData>(key);

  if (existing.value) {
    if (existing.value.userId !== userId) {
      // 他ユーザー保持中 → 拒否
      return {
        success: false,
        lock: existing.value,
        message: "Locked by another user",
      };
    }
    // 同一ユーザー: 同じ deviceId なら renew、別 deviceId なら取り戻し (ADR-018)
  }

  const now = new Date();
  const lock: LockData = {
    userId,
    deviceId,
    acquiredAt: existing.value?.acquiredAt ?? now.toISOString(),
    expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
  };

  // 取り戻しの場合は古い deviceId の逆引きインデックスも削除する。
  const tx = kv.atomic().check(existing);
  if (existing.value && existing.value.deviceId !== deviceId) {
    tx.delete(Keys.deviceLock(existing.value.deviceId, filePath));
  }

  const result = await tx
    .set(key, lock, { expireIn: timeoutMs })
    .set(Keys.deviceLock(deviceId, filePath), null, { expireIn: timeoutMs })
    .commit();

  if (!result.ok) {
    return { success: false, message: "Conflict" };
  }

  // 新規取得 / 取り戻しのみ broadcast (renew は broadcast しない)
  if (!existing.value || existing.value.deviceId !== deviceId) {
    broadcastLockEvent("lock_acquired", filePath, { userId, deviceId }).catch(
      (err) => console.error("broadcastLockEvent acquired failed:", err),
    );
  }

  return { success: true, lock };
}

export async function releaseLock(
  filePath: string,
  userId: number,
  deviceId: string,
): Promise<boolean> {
  const kv = await getEphemeralKv();
  const key = Keys.lock(filePath);
  const existing = await kv.get<LockData>(key);

  if (!existing.value) return true; // Already unlocked

  if (existing.value.userId !== userId) {
    return false; // 他ユーザー保持中: 解除不可
  }

  // 同一ユーザーなら deviceId が異なっても解除を許す (取り戻し中に旧端末が
  // close した時に現端末のロックを誤って消さないよう、deviceId 一致時のみ
  // 逆引きインデックスも削除する)。
  const tx = kv.atomic().check(existing).delete(key);
  if (existing.value.deviceId === deviceId) {
    tx.delete(Keys.deviceLock(deviceId, filePath));
  }

  const result = await tx.commit();

  if (result.ok) {
    // holder (ロックを持っていた端末) と originator (解除した端末) は別物に
    // なりうる。同一ユーザーの別端末が解除した場合、holder で配信除外すると
    // **当人にだけ通知が届かない**ので、originator を明示して渡す。
    broadcastLockEvent(
      "lock_released",
      filePath,
      { userId, deviceId: existing.value.deviceId },
      deviceId,
    ).catch((err) => console.error("broadcastLockEvent released failed:", err));
  }

  return result.ok;
}

/**
 * ADR-018 Step 3: terminate / 異常切断時に呼ぶ。当該 **ユーザーの** device が
 * 保持する全ロックを一括解除し、それぞれ lock_released を broadcast する。
 *
 * `userId` は必須。deviceId は enrollment 時にクライアントが名乗るもので一意性の
 * 検査が無いため、**deviceId だけを所有の鍵にすると、他人の deviceId を名乗る
 * だけで他人のロックを解放できる**。実際に、権限を 1 つも持たない アカウントが
 * 被害者の deviceId で WSS を張って `terminate` を送るだけで、被害者の編集中の
 * ロックを外せた。所有の判定は必ず (userId, deviceId) の両方で行う。
 */
export async function releaseDeviceLocks(
  deviceId: string,
  userId: number,
): Promise<number> {
  const kv = await getEphemeralKv();
  let released = 0;
  const iter = kv.list({ prefix: Keys.deviceLocksPrefix(deviceId) });

  for await (const entry of iter) {
    const path = entry.key[2] as string;
    const lockEntry = await kv.get<LockData>(Keys.lock(path));

    if (!lockEntry.value || lockEntry.value.deviceId !== deviceId) {
      // 残骸の逆引きを掃除
      await kv.delete(entry.key);
      continue;
    }

    // deviceId は一致するが別ユーザーのロック = deviceId の衝突。相手の
    // 正当なロックなので、**逆引きも含めて一切触らない**。
    if (lockEntry.value.userId !== userId) continue;

    const tx = await kv
      .atomic()
      .check(lockEntry)
      .delete(Keys.lock(path))
      .delete(entry.key)
      .commit();

    if (tx.ok) {
      released++;
      broadcastLockEvent("lock_released", path, {
        userId: lockEntry.value.userId,
        deviceId,
      }).catch((err) =>
        console.error("broadcastLockEvent released (bulk) failed:", err)
      );
    }
  }

  return released;
}

export async function getLock(filePath: string): Promise<LockData | null> {
  const kv = await getEphemeralKv();
  const entry = await kv.get<LockData>(Keys.lock(filePath));
  // KV expireIn により満期判定は不要。値があれば有効。
  return entry.value ?? null;
}

/**
 * ADR-019: /tree 用に全ロックをまとめて取得する (N+1 回避)。
 * Map<path, LockData> を返す。
 */
export async function getAllLocks(): Promise<Map<string, LockData>> {
  const kv = await getEphemeralKv();
  const result = new Map<string, LockData>();
  const iter = kv.list<LockData>({ prefix: ["locks"] });
  for await (const entry of iter) {
    const path = entry.key[1] as string;
    if (entry.value) result.set(path, entry.value);
  }
  return result;
}

export async function isLockedByOther(
  filePath: string,
  userId: number,
): Promise<boolean> {
  const lock = await getLock(filePath);
  return lock !== null && lock.userId !== userId;
}

/**
 * ADR-018 Step 2: WSS heartbeat 受信時に呼び出される。
 * device_locks 逆引きインデックスから当該 device が保持する全ロックを列挙し、
 * 各ロックの TTL を再設定する (Deno KV の expireIn は set 時のみ反映されるので、
 * 同じ値で再 set することで TTL がリフレッシュされる)。
 */
export async function refreshDeviceLocks(
  deviceId: string,
  userId: number,
): Promise<number> {
  const kv = await getEphemeralKv();
  let refreshed = 0;
  const iter = kv.list({ prefix: Keys.deviceLocksPrefix(deviceId) });

  for await (const entry of iter) {
    const path = entry.key[2] as string;
    const lockEntry = await kv.get<LockData>(Keys.lock(path));

    if (!lockEntry.value) {
      // 既に他端末が取り戻している、または expire 済み → 逆引きを掃除
      await kv.delete(entry.key);
      continue;
    }

    if (lockEntry.value.deviceId !== deviceId) {
      // 同一ユーザー別端末で取り戻しが起きた後の残骸 → 掃除
      await kv.delete(entry.key);
      continue;
    }

    // deviceId 衝突時に他ユーザーのロックを延命しない (逆引きも触らない)。
    if (lockEntry.value.userId !== userId) continue;

    // expiresAt も延長して整合性を保つ
    const refreshedLock: LockData = {
      ...lockEntry.value,
      expiresAt: new Date(Date.now() + LOCK_TTL_MS).toISOString(),
    };

    const tx = await kv
      .atomic()
      .check(lockEntry)
      .set(Keys.lock(path), refreshedLock, { expireIn: LOCK_TTL_MS })
      .set(Keys.deviceLock(deviceId, path), null, { expireIn: LOCK_TTL_MS })
      .commit();

    if (tx.ok) refreshed++;
  }

  return refreshed;
}
