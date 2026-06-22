/**
 * Deno KV キー設計
 *
 * ["users", id]                      → User
 * ["users_by_name", name]            → id (セカンダリインデックス)
 * ["groups", id]                     → Group
 * ["user_groups", userId, groupId]   → true
 * ["permissions", path, groupId]     → { accessLevel }
 * ["tokens", tokenHash]              → TokenData
 * ["tokens_by_user", userId, tokenHash] → true
 * ["audit", timestamp, id]           → AuditEntry
 * ["locks", path]                    → LockData
 * ["devices", deviceId]              → DeviceData
 * ["devices_by_user", userId, deviceId] → true
 * ["device_locks", deviceId, path]   → null (deviceId 逆引きインデックス)
 * ["uploads", uploadId]              → UploadSession (ADR-025)
 * ["uploads_by_device", deviceId, uploadId] → null (deviceId 逆引きインデックス)
 * ["counters", entity]               → number (auto-increment)
 * ["enrollments", secretHash]        → EnrollmentSecret (single-use bootstrap)
 * ["enrollments_by_user", userId, secretHash] → true (admin が user の outstanding を見るための逆引き)
 */

export const Keys = {
  user: (id: number): Deno.KvKey => ["users", id],
  userByName: (name: string): Deno.KvKey => ["users_by_name", name],
  group: (id: number): Deno.KvKey => ["groups", id],
  userGroup: (userId: number, groupId: number): Deno.KvKey => [
    "user_groups",
    userId,
    groupId,
  ],
  userGroupsPrefix: (userId: number): Deno.KvKey => ["user_groups", userId],
  permission: (path: string, groupId: number): Deno.KvKey => [
    "permissions",
    path,
    groupId,
  ],
  permissionsPrefix: (path: string): Deno.KvKey => ["permissions", path],
  token: (tokenHash: string): Deno.KvKey => ["tokens", tokenHash],
  tokenByUser: (userId: number, tokenHash: string): Deno.KvKey => [
    "tokens_by_user",
    userId,
    tokenHash,
  ],
  tokensByUserPrefix: (userId: number): Deno.KvKey => [
    "tokens_by_user",
    userId,
  ],
  audit: (timestamp: string, id: number): Deno.KvKey => [
    "audit",
    timestamp,
    id,
  ],
  auditPrefix: (): Deno.KvKey => ["audit"],
  lock: (path: string): Deno.KvKey => ["locks", path],
  device: (deviceId: string): Deno.KvKey => ["devices", deviceId],
  deviceByUser: (userId: number, deviceId: string): Deno.KvKey => [
    "devices_by_user",
    userId,
    deviceId,
  ],
  devicesByUserPrefix: (userId: number): Deno.KvKey => [
    "devices_by_user",
    userId,
  ],
  deviceLock: (deviceId: string, path: string): Deno.KvKey => [
    "device_locks",
    deviceId,
    path,
  ],
  deviceLocksPrefix: (deviceId: string): Deno.KvKey => [
    "device_locks",
    deviceId,
  ],
  counter: (entity: string): Deno.KvKey => ["counters", entity],
  upload: (uploadId: string): Deno.KvKey => ["uploads", uploadId],
  uploadByDevice: (deviceId: string, uploadId: string): Deno.KvKey => [
    "uploads_by_device",
    deviceId,
    uploadId,
  ],
  uploadsByDevicePrefix: (deviceId: string): Deno.KvKey => [
    "uploads_by_device",
    deviceId,
  ],
  enrollment: (secretHash: string): Deno.KvKey => ["enrollments", secretHash],
  enrollmentByUser: (userId: number, secretHash: string): Deno.KvKey => [
    "enrollments_by_user",
    userId,
    secretHash,
  ],
  enrollmentsByUserPrefix: (userId: number): Deno.KvKey => [
    "enrollments_by_user",
    userId,
  ],
} as const;
