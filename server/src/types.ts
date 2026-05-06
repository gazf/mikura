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
 * (uploadId, deviceId) で識別、TTL は lock TTL と同期する。
 */
export interface UploadSession {
  uploadId: string;
  userId: number;
  deviceId: string;
  path: string;
  tempPath: string;
  createdAt: string;
  expiresAt: string;
}
