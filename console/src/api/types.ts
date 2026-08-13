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

export type ApiAccessLevel = "read" | "write" | "admin";

/** テストとアサーションの期待水準 (ADR-035)。 */
export type ApiExpectation =
  | "invisible"
  | "visible"
  | "readable"
  | "writable"
  | "admin";

export interface ApiPolicyIssue {
  /** 1 始まり。0 は文書全体に対する指摘。 */
  line: number;
  message: string;
}

export interface ApiPolicyTestFailure extends ApiPolicyIssue {
  role: string;
  path: string;
  expected: string;
  actual: string;
}

export interface ApiAssertionFailure {
  id: number;
  userId: number;
  path: string;
  expected: string;
  actual: string;
  message: string;
}

export interface ApiRoleRule {
  path: string;
  /** `null` は遮断 (deny)。 */
  level: ApiAccessLevel | null;
}

export interface ApiRoleTest {
  expect: ApiExpectation;
  path: string;
}

/** `GET /admin/roles` の 1 行。そのまま画面のテーブル 1 行になる。 */
export interface ApiRole {
  name: string;
  enabled: boolean;
  generation: number;
  updatedAt: string;
  rules: ApiRoleRule[];
  tests: ApiRoleTest[];
  memberCount: number;
  /** 実在しないパスを指しているルール。 */
  danglingPaths: string[];
}

export interface ApiRoleList {
  roles: ApiRole[];
  warnings: ApiPolicyIssue[];
}

export interface ApiRoleGeneration {
  generation: number;
  createdAt: string;
  createdBy: number;
  rules: ApiRoleRule[];
  tests: ApiRoleTest[];
  current: boolean;
}

/** `GET /admin/roles/:name` — 一覧の 1 行に世代の一覧を足したもの。 */
export interface ApiRoleDetail extends ApiRole {
  generations: Array<{
    generation: number;
    createdAt: string;
    createdBy: number;
    ruleCount: number;
    testCount: number;
    current: boolean;
  }>;
}

/** ロールの保存結果。却下時も同じ形で理由が返る。 */
export interface ApiRoleSaveResult {
  ok: boolean;
  generation?: number;
  errors: ApiPolicyIssue[];
  testFailures: ApiPolicyTestFailure[];
  warnings: ApiPolicyIssue[];
  assertionFailures: ApiAssertionFailure[];
  /** admin 不在・競合など、定義の外側の理由。 */
  rejection?: string;
  /** 削除時のみ: 一緒に外れた割り当ての数。 */
  removedAssignments?: number;
}

export interface ApiAssignment {
  userId: number;
  roles: string[];
}

export interface ApiAssertion {
  id: number;
  userId: number;
  path: string;
  expect: ApiExpectation;
  note?: string;
}

/** `GET /admin/diagnostics/effective` — なぜその結果になったか。 */
export interface ApiEffectiveDiagnostic {
  userId: number;
  path: string;
  effective: string;
  perRole: Array<{
    role: string;
    decidedBy: string | null;
    level: ApiAccessLevel | null;
    derivedVisible: boolean;
  }>;
}

/** `GET /admin/diagnostics/who` — そのパスに届くのは誰か。 */
export interface ApiWhoDiagnostic {
  path: string;
  level: string;
  users: Array<{
    userId: number;
    name: string | null;
    effective: string;
    roles: string[];
  }>;
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
