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
