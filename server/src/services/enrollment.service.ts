/**
 * Enrollment service: admin が user に配布する init.json の元になる single-use
 * secret の発行と consume を司る。
 *
 * 設計:
 *   - **raw secret は admin の手元 (init.json) と user の client にのみ存在**。
 *     server 側は SHA256(raw) しか持たない (token 設計と同流儀)。
 *   - **consume は atomic**: 「未消費かつ未期限切れ」を `kv.atomic().check()` で
 *     確認した上で、consume mark + token 発行を 1 transaction に詰める。
 *     2 client から同 secret を同時に POST /enroll しても、片方しか成功しない。
 *   - **TTL**: enrollment secret の expireIn は user の application TTL より
 *     **少し長め**に設定し、application 側で `expiresAt` を厳密 check する
 *     (= KV expireIn の精度に依存させない)。これは token / lock と同じ流儀。
 *   - **bootstrap path**: consume 成功時に発行する token は新仕様 (boundDeviceId 付)
 *     なので、`createAppToken` ではなく内部で TokenData を直接組み立てる。
 */

import { encodeHex } from "@std/encoding/hex";
import { crypto as stdCrypto } from "@std/crypto";
import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import type { EnrollmentSecret, TokenData, User } from "../types.ts";

// SHA256 を validate と同じ手段 (sync Wasm) で。auth.service.ts:sha256 は private
// なので、本 service 側で再宣言する。stateless。
const _enc = new TextEncoder();
function sha256(input: string): string {
  const data = _enc.encode(input);
  const hash = stdCrypto.subtle.digestSync("SHA-256", data);
  return encodeHex(new Uint8Array(hash));
}

/**
 * Enrollment secret を発行する。raw は admin に 1 回だけ返却、KV には hash しか
 * 残らない (= raw が再表示されることはない、紛失時は re-issue が唯一の手段)。
 */
export async function createEnrollmentSecret(
  userId: number,
  createdBy: number,
  ttlDays = 7,
): Promise<{ raw: string; secretHash: string; expiresAt: string }> {
  const kv = await getKv();

  // user が存在することを check (= admin が誤った userId を投げてもここで弾く)
  const user = await kv.get<User>(Keys.user(userId));
  if (!user.value) {
    throw new EnrollmentError("user_not_found", 404);
  }

  // raw は UUID v4 で十分 (token と同じ)。長さは 36 byte、entropy 122 bit。
  const raw = crypto.randomUUID();
  const secretHash = sha256(raw);
  const now = Date.now();
  const expiresAtMs = now + ttlDays * 24 * 60 * 60 * 1000;
  const data: EnrollmentSecret = {
    secretHash,
    userId,
    createdBy,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };

  // expireIn は application TTL + 1 日 (= KV 自動削除 vs application check の
  // race を避けるための余裕)。本物の判定は application 側 expiresAt で行う。
  const kvTtlMs = (ttlDays + 1) * 24 * 60 * 60 * 1000;
  await kv
    .atomic()
    .set(Keys.enrollment(secretHash), data, { expireIn: kvTtlMs })
    .set(Keys.enrollmentByUser(userId, secretHash), true, {
      expireIn: kvTtlMs,
    })
    .commit();

  return { raw, secretHash, expiresAt: data.expiresAt };
}

export interface EnrollmentConsumeResult {
  rawToken: string;
  tokenHash: string;
  userId: number;
  userName: string;
}

/**
 * Enrollment secret を consume して bearer token を発行する。atomic な
 * check & swap で「同 secret が同時に 2 度 consume される」を防ぐ。
 */
export async function consumeEnrollment(
  rawSecret: string,
  deviceId: string,
): Promise<EnrollmentConsumeResult> {
  const kv = await getKv();
  const secretHash = sha256(rawSecret);

  // 1) enrollment record fetch + versionstamp 取得 (atomic.check 用)
  const entry = await kv.get<EnrollmentSecret>(Keys.enrollment(secretHash));
  if (!entry.value) {
    throw new EnrollmentError("invalid_or_expired", 410);
  }
  const enrollment = entry.value;

  // 2) application TTL check (= KV expireIn より厳密、user の手元の expiresAt と一致)
  if (Date.parse(enrollment.expiresAt) < Date.now()) {
    throw new EnrollmentError("invalid_or_expired", 410);
  }
  if (enrollment.consumedAt) {
    throw new EnrollmentError("already_consumed", 410);
  }

  // 3) user 取得 (response 構築用 + 念のため存在 check)
  const user = await kv.get<User>(Keys.user(enrollment.userId));
  if (!user.value) {
    throw new EnrollmentError("user_not_found", 404);
  }

  // 4) token を組み立て (新仕様: boundDeviceId 付き)
  const rawToken = crypto.randomUUID();
  const tokenHash = sha256(rawToken);
  const now = Date.now();
  const tokenData: TokenData = {
    userId: enrollment.userId,
    name: `enrollment:${enrollment.createdAt}`,
    expiresAt: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(now).toISOString(),
    boundDeviceId: deviceId,
  };

  // 5) atomic: enrollment が同 version (= まだ consume されていない) なら
  //    consume mark + token insertion を 1 transaction で
  const consumed: EnrollmentSecret = {
    ...enrollment,
    consumedAt: new Date(now).toISOString(),
    consumedByDeviceId: deviceId,
  };
  const res = await kv
    .atomic()
    .check({
      key: Keys.enrollment(secretHash),
      versionstamp: entry.versionstamp,
    })
    .set(Keys.enrollment(secretHash), consumed)
    .set(Keys.token(tokenHash), tokenData)
    .set(Keys.tokenByUser(enrollment.userId, tokenHash), true)
    .commit();
  if (!res.ok) {
    // 同時 consume の race で他方が先に成功した
    throw new EnrollmentError("already_consumed", 410);
  }

  return {
    rawToken,
    tokenHash,
    userId: enrollment.userId,
    userName: user.value.name,
  };
}

/**
 * Admin が outstanding な enrollment 一覧を見るための簡易 list (consumed 含む)。
 */
export async function listEnrollmentsByUser(
  userId: number,
): Promise<EnrollmentSecret[]> {
  const kv = await getKv();
  const out: EnrollmentSecret[] = [];
  const iter = kv.list<boolean>({
    prefix: Keys.enrollmentsByUserPrefix(userId),
  });
  for await (const entry of iter) {
    // ["enrollments_by_user", userId, secretHash]
    const hash = entry.key[2] as string;
    const got = await kv.get<EnrollmentSecret>(Keys.enrollment(hash));
    if (got.value) out.push(got.value);
  }
  return out;
}

export class EnrollmentError extends Error {
  constructor(
    public code: string,
    public statusCode: number,
  ) {
    super(code);
  }
}
