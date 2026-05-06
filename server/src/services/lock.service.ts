import { getKv } from "../kv/store.ts";
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
  const kv = await getKv();
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
  const kv = await getKv();
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
    broadcastLockEvent("lock_released", filePath, {
      userId,
      deviceId: existing.value.deviceId,
    }).catch((err) =>
      console.error("broadcastLockEvent released failed:", err)
    );
  }

  return result.ok;
}

/**
 * ADR-018 Step 3: terminate / 異常切断時に呼ぶ。当該 device が保持する全ロックを
 * 一括解除し、それぞれ lock_released を broadcast する。
 */
export async function releaseDeviceLocks(deviceId: string): Promise<number> {
  const kv = await getKv();
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
  const kv = await getKv();
  const entry = await kv.get<LockData>(Keys.lock(filePath));
  // KV expireIn により満期判定は不要。値があれば有効。
  return entry.value ?? null;
}

/**
 * ADR-019: /tree 用に全ロックをまとめて取得する (N+1 回避)。
 * Map<path, LockData> を返す。
 */
export async function getAllLocks(): Promise<Map<string, LockData>> {
  const kv = await getKv();
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
export async function refreshDeviceLocks(deviceId: string): Promise<number> {
  const kv = await getKv();
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
