/**
 * Deno KV キー設計
 *
 * ["users", id]                      → User
 * ["users_by_name", name]            → id (セカンダリインデックス)
 * ["roles", name]                    → RoleRecord (有効・無効 + 適用中の世代) (ADR-036)
 * ["role_generations", name, gen]    → RoleGeneration (ルールとテストの実体)
 * ["user_roles", userId, roleName]   → true
 * ["role_users", roleName, userId]   → true (「誰がこのロールを持つか」の逆引き)
 * ["assertions", id]                 → AccessAssertion (割り当て層の主張)
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
  // ----- ADR-035 / ADR-036: ロール定義と割り当て -----
  role: (name: string): Deno.KvKey => ["roles", name],
  rolesPrefix: (): Deno.KvKey => ["roles"],
  roleGeneration: (name: string, generation: number): Deno.KvKey => [
    "role_generations",
    name,
    generation,
  ],
  roleGenerationsPrefix: (name: string): Deno.KvKey => [
    "role_generations",
    name,
  ],
  userRole: (userId: number, roleName: string): Deno.KvKey => [
    "user_roles",
    userId,
    roleName,
  ],
  userRolesPrefix: (userId: number): Deno.KvKey => ["user_roles", userId],
  /** 全ユーザー分の割り当てを舐める (admin 不在検査 / 逆引き診断)。 */
  userRolesAllPrefix: (): Deno.KvKey => ["user_roles"],
  roleUser: (roleName: string, userId: number): Deno.KvKey => [
    "role_users",
    roleName,
    userId,
  ],
  roleUsersPrefix: (roleName: string): Deno.KvKey => ["role_users", roleName],
  assertion: (id: number): Deno.KvKey => ["assertions", id],
  assertionsPrefix: (): Deno.KvKey => ["assertions"],
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
  /** 全 user 分の token を舐める。prefix は key part 単位の一致なので
   * "tokens_by_user" は引っ掛からない。 */
  tokensAllPrefix: (): Deno.KvKey => ["tokens"],
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
  /** 全 user 分の device を舐める。 */
  devicesAllPrefix: (): Deno.KvKey => ["devices"],
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
  /** 全 user 分の enrollment を舐める (未消費の招待一覧用)。 */
  enrollmentsAllPrefix: (): Deno.KvKey => ["enrollments"],
} as const;
