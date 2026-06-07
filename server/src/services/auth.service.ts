import { crypto as stdCrypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";
import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import type {
  AccessLevel,
  DeviceData,
  Permission,
  TokenData,
  User,
} from "../types.ts";

// TextEncoder は stateless なので module-level で 1 個を共有 (validateToken は
// 全 request の hot path で sha256 を経由する)。
const _tokenEncoder = new TextEncoder();

// validateToken は全 request の hot path。token cache hit でも hashToken は
// 必ず呼ばれる (cache key 側が hash) ので、ここの per-call cost が直接 RPS を縛る。
//
// 旧実装: crypto.subtle.digest (async WebCrypto) + 手書き hex loop。
// 新実装: @std/crypto digestSync (Wasm backed, sync) + @std/encoding/hex。
// bench/multipart-parse.bench.ts の (A)/(B) で per-call cost を 1 桁以上短縮
// できることを確認している (async WebCrypto は Promise 越境のコストが支配的)。
// node:crypto createHash は更に速いが、Deno の Node 互換層依存を持ち込む
// よりも純 std で揃える方針を取った (macro level の throughput では微差)。
function sha256(input: string): string {
  const data = _tokenEncoder.encode(input);
  const hash = stdCrypto.subtle.digestSync("SHA-256", data);
  return encodeHex(new Uint8Array(hash));
}

export function generateToken(): string {
  return crypto.randomUUID();
}

export async function hashToken(token: string): Promise<string> {
  return await sha256(token);
}

export interface TokenIdentity {
  id: number;
  name: string;
}

export interface AuthUser extends TokenIdentity {
  deviceId: string;
}

// ----- in-memory caches -----
//
// validateToken は全リクエストで呼ばれるが、トークンの内容はそうそう変わらない
// (mikura 現状では revoke API も無く、expiresAt はデフォルト 365 日)。
// 60 秒キャッシュで KV 2 ops × 全 request を抑える。
//
// 防御策:
//   - エントリに本物の expiresAt を焼き込み、ヒット時に毎回チェック (キャッシュ
//     寿命内に切れた場合も即弾く)
//   - bounded LRU (TOKEN_CACHE_MAX) で悪意ある急増を抑える
//   - negative cache は持たない (失敗は KV 直撃)
//   - invalidateToken() で外部から個別に追い出せる (将来 revoke 用)
const TOKEN_CACHE_TTL_MS = 60 * 1000;
const TOKEN_CACHE_MAX = 1024;

interface CachedToken {
  identity: TokenIdentity;
  tokenExpiresAtMs: number;
  cacheUntilMs: number;
}

const tokenCache = new Map<string, CachedToken>();

function tokenCacheTouch(hash: string): CachedToken | undefined {
  const e = tokenCache.get(hash);
  if (!e) return undefined;
  // LRU recency: re-insert to move to the end.
  tokenCache.delete(hash);
  tokenCache.set(hash, e);
  return e;
}

function tokenCachePut(hash: string, entry: CachedToken): void {
  tokenCache.delete(hash);
  tokenCache.set(hash, entry);
  if (tokenCache.size > TOKEN_CACHE_MAX) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
}

/**
 * 将来 token revoke API が入った場合のフック。今は呼び出し元なし。
 */
export function invalidateToken(tokenHash: string): void {
  tokenCache.delete(tokenHash);
}

// upsertDevice の lastSeenAt 更新は診断情報。30 秒に 1 回で十分。
// (userId, ipAddress) のいずれかが変わったら throttle を破って即書き込む。
const DEVICE_UPSERT_THROTTLE_MS = 30 * 1000;

interface DeviceUpsertCacheEntry {
  userId: number;
  ipAddress?: string;
  atMs: number;
}

const deviceUpsertCache = new Map<string, DeviceUpsertCacheEntry>();

/**
 * テスト間でモジュールレベル cache を漏らさないためのリセット。
 * `_helpers.ts` の withTestKv から呼ばれる。
 */
export function _resetAuthCachesForTesting(): void {
  tokenCache.clear();
  deviceUpsertCache.clear();
}

export async function upsertDevice(
  deviceId: string,
  userId: number,
  ipAddress?: string,
): Promise<void> {
  const now = Date.now();
  const last = deviceUpsertCache.get(deviceId);
  if (
    last !== undefined &&
    last.userId === userId &&
    last.ipAddress === ipAddress &&
    now - last.atMs < DEVICE_UPSERT_THROTTLE_MS
  ) {
    return;
  }

  const kv = await getKv();
  const nowIso = new Date(now).toISOString();
  const existing = await kv.get<DeviceData>(Keys.device(deviceId));

  const device: DeviceData = existing.value
    ? {
      ...existing.value,
      userId,
      lastSeenAt: nowIso,
      ipAddress,
    }
    : {
      deviceId,
      userId,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      ipAddress,
    };

  await kv
    .atomic()
    .set(Keys.device(deviceId), device)
    .set(Keys.deviceByUser(userId, deviceId), true)
    .commit();

  deviceUpsertCache.set(deviceId, { userId, ipAddress, atMs: now });
}

export async function validateToken(
  rawToken: string,
): Promise<TokenIdentity | null> {
  const hash = await hashToken(rawToken);
  const now = Date.now();

  const cached = tokenCacheTouch(hash);
  if (cached) {
    // 本物の expiresAt はキャッシュ寿命より優先 (TTL 内に切れたら即弾く)。
    if (cached.tokenExpiresAtMs < now) {
      tokenCache.delete(hash);
      return null;
    }
    if (cached.cacheUntilMs > now) {
      return cached.identity;
    }
    // 寿命切れ: KV で再検証 (cache は下で put し直す)
  }

  const kv = await getKv();
  const entry = await kv.get<TokenData>(Keys.token(hash));
  if (!entry.value) {
    tokenCache.delete(hash);
    return null;
  }

  const tokenData = entry.value;
  // Date.parse は Date object を経由せず ISO 文字列から直接 ms 取得できる
  // (cache miss 経路は per-request hot ではないが、構築せず捨てる Date は無駄)。
  const tokenExpiresAtMs = Date.parse(tokenData.expiresAt);
  if (tokenExpiresAtMs < now) {
    tokenCache.delete(hash);
    return null;
  }

  const user = await kv.get<User>(Keys.user(tokenData.userId));
  if (!user.value) {
    tokenCache.delete(hash);
    return null;
  }

  const identity: TokenIdentity = {
    id: user.value.id,
    name: user.value.name,
  };
  tokenCachePut(hash, {
    identity,
    tokenExpiresAtMs,
    cacheUntilMs: now + TOKEN_CACHE_TTL_MS,
  });
  return identity;
}

export async function createAppToken(
  userId: number,
  name: string,
  expiresInDays: number = 365,
): Promise<{ raw: string; hash: string }> {
  const kv = await getKv();
  const raw = generateToken();
  const hash = await hashToken(raw);

  const tokenData: TokenData = {
    userId,
    name,
    expiresAt: new Date(
      Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
    ).toISOString(),
    createdAt: new Date().toISOString(),
  };

  await kv
    .atomic()
    .set(Keys.token(hash), tokenData)
    .set(Keys.tokenByUser(userId, hash), true)
    .commit();

  return { raw, hash };
}

async function getUserGroupIds(userId: number): Promise<number[]> {
  const kv = await getKv();
  const groupIds: number[] = [];
  const iter = kv.list<boolean>({ prefix: Keys.userGroupsPrefix(userId) });
  for await (const entry of iter) {
    // Key is ["user_groups", userId, groupId]
    const groupId = entry.key[2] as number;
    groupIds.push(groupId);
  }
  return groupIds;
}

export async function checkPermission(
  userId: number,
  path: string,
  requiredLevel: "read" | "write",
): Promise<boolean> {
  const groupIds = await getUserGroupIds(userId);
  if (groupIds.length === 0) return false;

  const kv = await getKv();

  // Walk up the path hierarchy to find the most specific permission
  const pathParts = path.split("/").filter(Boolean);
  const pathsToCheck = ["/"];
  let current = "";
  for (const part of pathParts) {
    current += "/" + part;
    pathsToCheck.push(current);
  }

  // Check from most specific to least specific
  for (let i = pathsToCheck.length - 1; i >= 0; i--) {
    const checkPath = pathsToCheck[i];
    for (const groupId of groupIds) {
      const perm = await kv.get<Permission>(
        Keys.permission(checkPath, groupId),
      );
      if (perm.value) {
        return hasAccess(perm.value.accessLevel, requiredLevel);
      }
    }
  }

  return false;
}

function hasAccess(granted: AccessLevel, required: "read" | "write"): boolean {
  if (granted === "admin") return true;
  if (granted === "write") return true;
  if (granted === "read" && required === "read") return true;
  return false;
}
