/**
 * API サーバの `/admin/*` が返す **ワイヤ形状**。
 *
 * ADR-033: `server/src/types.ts` は import しない。内部型とワイヤ形状は
 * 実際に違う — 例えば `User` は `passwordHash` を持つが `GET /admin/users`
 * は `{ id, name, createdAt }` しか返さない。内部型を引くと「実際には届かない
 * フィールド」が console 側の型に見えることになるし、コンテナ分離時の
 * ビルドコンテキストも server/ に引きずられる。
 *
 * ここは「server が実際に返すもの」の宣言であって、server の型の再利用では
 * ないことに注意。server 側の response shape を変えたらここも変える。
 */

export interface ApiUser {
  id: number;
  name: string;
  createdAt: string;
}

export interface ApiGroup {
  id: number;
  name: string;
}

export type ApiAccessLevel = "read" | "write" | "admin";

export interface ApiMembership {
  groupId: number;
  /** group 本体が消えている membership では null。 */
  groupName: string | null;
}

export interface ApiPermission {
  path: string;
  groupId: number;
  accessLevel: ApiAccessLevel;
}

export interface ApiEnrollment {
  secretHash: string;
  userId: number;
  createdBy: number;
  createdAt: string;
  expiresAt: string;
  /** consume 済みの場合のみ入る。 */
  consumedAt?: string;
  consumedByDeviceId?: string;
}

/** `POST /admin/enrollments` の応答。raw secret はここにしか現れない。 */
export interface ApiIssuedEnrollment {
  secret: string;
  secretHash: string;
  expiresAt: string;
  /** MIKURA_PUBLIC_URL 未設定時は null (ADR-034)。 */
  enrollUrl: string | null;
}

export interface ApiToken {
  tokenHash: string;
  userId: number;
  name: string;
  expiresAt: string;
  createdAt: string;
  boundDeviceId?: string;
  lastUsedIp?: string;
  lastUsedAt?: string;
}

export interface ApiDevice {
  deviceId: string;
  userId: number;
  label?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  ipAddress?: string;
}

export interface ApiAuditEntry {
  timestamp: string;
  userId: number;
  action: string;
  path: string;
  ip: string;
}

/**
 * `GET /tree` の 1 エントリ。console が `/admin/*` 以外で唯一叩く endpoint で、
 * 権限エディタの path 選択にのみ使う (ADR-033)。構造だけで中身は含まない。
 */
export interface ApiTreeEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  size: number;
  lastModified: string;
  isReadOnly: boolean;
}
