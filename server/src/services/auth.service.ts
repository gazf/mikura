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
  /**
   * Token に紐付いた device ID。新仕様 (enrollment 経由) の token は必ず値、
   * 旧 seed 由来 / 既存 token は undefined (= 任意 device で valid)。
   */
  boundDeviceId?: string;
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

// Token の lastUsedIp / lastUsedAt update は audit 情報。同じく 30 秒 throttle。
// (tokenHash, ip) が変わったら throttle を破って即書き込む (= 異 IP は即記録)。
const TOKEN_LAST_USED_THROTTLE_MS = 30 * 1000;

interface TokenLastUsedCacheEntry {
  ip?: string;
  atMs: number;
}

const tokenLastUsedCache = new Map<string, TokenLastUsedCacheEntry>();

/**
 * テスト間でモジュールレベル cache を漏らさないためのリセット。
 * `_helpers.ts` の withTestKv から呼ばれる。
 */
export function _resetAuthCachesForTesting(): void {
  tokenCache.clear();
  deviceUpsertCache.clear();
  tokenLastUsedCache.clear();
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

export interface ValidateOptions {
  /**
   * Request の X-Device-Id header 値。指定された場合、token に紐付いた
   * `boundDeviceId` と完全一致しないと null 返却 (= 盗難 secret.bin を別端末で
   * 使う攻撃を防ぐ defense layer)。
   *
   * 後方互換: `boundDeviceId` が undefined な token (= 旧 seed admin token) は
   * device check を skip する。新規 enrollment 由来の token は必ず bound 値を
   * 持つので、deviceId の指定がないと弾かれる (= production では middleware が
   * 必ず deviceId を渡す前提)。
   */
  deviceId?: string;
  /** lastUsedIp の throttled update に使う。未指定なら update スキップ。 */
  ip?: string;
}

export async function validateToken(
  rawToken: string,
  opts: ValidateOptions = {},
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
      // cache hit 経路でも deviceId binding は必ず enforce する (cache の寿命内に
      // attacker が別 device から叩いてきた場合に素通しさせない)。
      if (
        cached.boundDeviceId !== undefined &&
        cached.boundDeviceId !== opts.deviceId
      ) {
        logDeviceMismatch(hash, cached.boundDeviceId, opts.deviceId, opts.ip);
        return null;
      }
      // lastUsedIp/At を背後で throttled update (return は待たない、cache hit 経路の
      // latency を増やさない)。
      void maybeUpdateLastUsed(hash, opts.ip, now);
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

  // Device binding check (cache miss 経路)
  if (
    tokenData.boundDeviceId !== undefined &&
    tokenData.boundDeviceId !== opts.deviceId
  ) {
    logDeviceMismatch(hash, tokenData.boundDeviceId, opts.deviceId, opts.ip);
    // cache には put しない (= attacker の hash で cache を warm させない)
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
    boundDeviceId: tokenData.boundDeviceId,
  });
  void maybeUpdateLastUsed(hash, opts.ip, now);
  return identity;
}

function logDeviceMismatch(
  hash: string,
  bound: string,
  got: string | undefined,
  ip?: string,
): void {
  // hash と deviceId の先頭だけ出して PII / 完全な token leak を避ける。
  // 「盗難 secret を別端末で使った」signal なので WARN レベル + audit 連携余地。
  console.warn(
    `[auth] token deviceId mismatch hash=${hash.slice(0, 8)} bound=${
      bound.slice(0, 8)
    } got=${got?.slice(0, 8) ?? "<none>"} ip=${ip ?? "<unknown>"}`,
  );
}

/**
 * tokenHash, ip ごとに throttled で KV の lastUsedIp / lastUsedAt を更新。
 * 同 (hash, ip) は 30 秒に 1 回、ip が変わったら即書き込む (= 異常検知の input)。
 * write 失敗は audit 情報なので silently 握りつぶす (request 全体を落とさない)。
 *
 * 注意: atomic.check で versionstamp 一致時のみ書き込む (= 並列 request や
 * 外部 KV 操作 (revoke, expire 設定変更等) を上書きしない)。失敗時は次回 throttle
 * 期間外でリトライする機会がある。
 */
async function maybeUpdateLastUsed(
  tokenHash: string,
  ip: string | undefined,
  nowMs: number,
): Promise<void> {
  const last = tokenLastUsedCache.get(tokenHash);
  if (
    last !== undefined &&
    last.ip === ip &&
    nowMs - last.atMs < TOKEN_LAST_USED_THROTTLE_MS
  ) {
    return;
  }
  tokenLastUsedCache.set(tokenHash, { ip, atMs: nowMs });

  try {
    const kv = await getKv();
    const entry = await kv.get<TokenData>(Keys.token(tokenHash));
    if (!entry.value) return; // race で消えた、無視
    const updated: TokenData = {
      ...entry.value,
      lastUsedIp: ip,
      lastUsedAt: new Date(nowMs).toISOString(),
    };
    await kv
      .atomic()
      .check({ key: Keys.token(tokenHash), versionstamp: entry.versionstamp })
      .set(Keys.token(tokenHash), updated)
      .commit();
    // commit fail は他経路 (revoke / 直接書換) が先勝、無視で OK。
  } catch (err) {
    console.error("maybeUpdateLastUsed failed:", err);
  }
}

/**
 * Token revoke の hook。memory cache を invalidate + KV から削除。
 * 戻り値: KV に entry があり削除したなら true、そもそも無かったら false。
 */
export async function revokeToken(tokenHash: string): Promise<boolean> {
  const kv = await getKv();
  const entry = await kv.get<TokenData>(Keys.token(tokenHash));
  if (!entry.value) {
    invalidateToken(tokenHash);
    return false;
  }
  await kv
    .atomic()
    .delete(Keys.token(tokenHash))
    .delete(Keys.tokenByUser(entry.value.userId, tokenHash))
    .commit();
  invalidateToken(tokenHash);
  tokenLastUsedCache.delete(tokenHash);
  return true;
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

async function fetchUserGroupIds(userId: number): Promise<number[]> {
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

async function fetchPermission(
  path: string,
  groupId: number,
): Promise<Permission | null> {
  const kv = await getKv();
  const got = await kv.get<Permission>(Keys.permission(path, groupId));
  return got.value ?? null;
}

/**
 * request スコープの permission 走査 cache。
 *
 * 課題: checkPermission は 1 request 内で何度も呼ばれる
 *   - GET /tree: entry 数 × (group 数 × depth) KV read = 数千 op / 1 req になりうる
 *   - WSS broadcast: peer 数 × (同上)
 *   - PATCH /files: src + dst で 2 回
 *
 * 共有可能性:
 *   - groupIds(userId): 1 request 内では同じ userId 何度叩いても 1 fetch で十分
 *   - permission(path, groupId): tree 走査で **parent path が大量に重複** する
 *     (例: /a/b/c と /a/b/d は /, /a, /a/b の lookup を共有)
 *
 * Promise を cache に格納することで Promise.all による concurrent walk でも
 * 1 (userId, path, groupId) 当たり 1 fetch に収束する (in-flight 共有)。
 *
 * ライフタイム: 1 request 中だけ生存。middleware が new し、req 終了で参照が
 * 切れて GC される (in-memory のみ、KV 書込みなし)。
 */
export class PermissionContext {
  private _groupIds = new Map<number, Promise<number[]>>();
  private _perm = new Map<string, Promise<Permission | null>>();

  groupIds(userId: number): Promise<number[]> {
    let p = this._groupIds.get(userId);
    if (!p) {
      p = fetchUserGroupIds(userId);
      this._groupIds.set(userId, p);
    }
    return p;
  }

  permission(path: string, groupId: number): Promise<Permission | null> {
    // key separator に null byte を使うのは、path validation で null byte を
    // 既に弾いているため衝突が起こりえないから。
    const key = `${path}\0${groupId}`;
    let p = this._perm.get(key);
    if (!p) {
      p = fetchPermission(path, groupId);
      this._perm.set(key, p);
    }
    return p;
  }
}

export async function checkPermission(
  userId: number,
  path: string,
  requiredLevel: "read" | "write" | "admin",
  ctx?: PermissionContext,
): Promise<boolean> {
  // ctx 無しの呼び出しは「1 回限りの check」として one-shot context を生成する
  // (test や CLI から呼ぶケース、または middleware を通らない経路)。
  const context = ctx ?? new PermissionContext();

  const groupIds = await context.groupIds(userId);
  if (groupIds.length === 0) return false;

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
      const perm = await context.permission(checkPath, groupId);
      if (perm) {
        return hasAccess(perm.accessLevel, requiredLevel);
      }
    }
  }

  return false;
}

function hasAccess(
  granted: AccessLevel,
  required: "read" | "write" | "admin",
): boolean {
  if (required === "admin") return granted === "admin";
  if (granted === "admin") return true;
  if (granted === "write") return true;
  if (granted === "read" && required === "read") return true;
  return false;
}
