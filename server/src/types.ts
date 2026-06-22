export interface User {
  id: number;
  name: string;
  passwordHash: string;
  createdAt: string;
}

export interface Group {
  id: number;
  name: string;
}

export type AccessLevel = "read" | "write" | "admin";

export interface Permission {
  accessLevel: AccessLevel;
}

export interface TokenData {
  userId: number;
  name: string;
  expiresAt: string;
  createdAt: string;
  /**
   * Token を発行した enrollment 時点の Device ID。以後の request は X-Device-Id
   * header がこの値と一致する場合のみ valid と判定する。盗難 secret.bin を
   * 別 PC (= 別 derived deviceId) で使う攻撃を防ぐための binding。
   *
   * 既存 seed (admin) 由来の token は未 bind (= 任意 device で valid) として
   * undefined を許容する。新規 enrollment 経由で発行される token は必ず
   * 値を持つ。
   */
  boundDeviceId?: string;
  /**
   * 直近 successful request の IP / 時刻。盗難検知 (= 短時間で違う IP 等) の
   * 観測点。throttle 30s で頻繁書込みを抑える。
   */
  lastUsedIp?: string;
  lastUsedAt?: string;
}

/**
 * Admin が user に配布する init.json の元になる single-use enrollment secret。
 * raw secret は admin の手元 (= init.json) と user の client にのみ存在し、
 * server 側は hash しか持たない (token と同じ流儀)。consume されたら
 * consumedAt が立ち、二度目の consume は失敗する。
 */
export interface EnrollmentSecret {
  /** SHA256(raw) — KV key の構成要素、検索用にも値側にも入れる */
  secretHash: string;
  /** 発行対象の user */
  userId: number;
  /** 発行 admin (audit 用) */
  createdBy: number;
  createdAt: string;
  expiresAt: string;
  /** consume された場合のみ値が入る */
  consumedAt?: string;
  consumedByDeviceId?: string;
}

export interface AuditEntry {
  userId: number;
  action: string;
  path: string;
  ip: string;
}

export interface LockData {
  userId: number;
  deviceId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface DeviceData {
  deviceId: string;
  userId: number;
  label?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  ipAddress?: string;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  lastModified: string;
}

/**
 * ADR-025: range PATCH ベースの chunked upload セッション。
 * (uploadId, deviceId) で識別。生存判定は KV の alive marker
 * (uploadByDevice key の expireIn) が SSOT。session value 自体は
 * 長 TTL の safety net で保持され、heartbeat の TTL extension は
 * value に触らず alive marker だけを延長する設計
 * (upload.service.ts 参照)。
 */
export interface UploadSession {
  uploadId: string;
  userId: number;
  deviceId: string;
  path: string;
  tempPath: string;
  createdAt: string;
}
