import { closeKv, getKv } from "./store.ts";
import { Keys } from "./keys.ts";
import type { Group, Permission, TokenData, User } from "../types.ts";

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashToken(token: string): Promise<string> {
  return await hashPassword(token); // same SHA-256 hash
}

async function nextId(kv: Deno.Kv, entity: string): Promise<number> {
  const key = Keys.counter(entity);
  const result = await kv.get<number>(key);
  const currentValue = result.value ?? 0;
  const nextValue = currentValue + 1;
  const commit = await kv
    .atomic()
    .check(result)
    .set(key, nextValue)
    .commit();
  if (!commit.ok) {
    throw new Error(`Failed to increment counter for ${entity}`);
  }
  return nextValue;
}

/**
 * idempotent seed。既に seed 済みなら no-op。
 * rawToken が指定されればそれを admin token として使う (in-memory KV で
 * 起動の度に同じトークンを保ちたい用途)。未指定なら randomUUID。
 */
export async function seedIfEmpty(rawToken?: string): Promise<void> {
  const kv = await getKv();

  const existingUser = await kv.get(Keys.userByName("admin"));
  if (existingUser.value !== null) {
    return;
  }

  const adminId = await nextId(kv, "users");
  const groupId = await nextId(kv, "groups");

  const adminUser: User = {
    id: adminId,
    name: "admin",
    passwordHash: await hashPassword("admin"),
    createdAt: new Date().toISOString(),
  };

  const adminsGroup: Group = {
    id: groupId,
    name: "admins",
  };

  const rootPermission: Permission = {
    accessLevel: "admin",
  };

  const token = rawToken ?? crypto.randomUUID();
  const tokenHash = await hashToken(token);
  const tokenData: TokenData = {
    userId: adminId,
    name: "initial-admin-token",
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };

  const result = await kv
    .atomic()
    .set(Keys.user(adminId), adminUser)
    .set(Keys.userByName("admin"), adminId)
    .set(Keys.group(groupId), adminsGroup)
    .set(Keys.userGroup(adminId, groupId), true)
    .set(Keys.permission("/", groupId), rootPermission)
    .set(Keys.token(tokenHash), tokenData)
    .set(Keys.tokenByUser(adminId, tokenHash), true)
    .commit();

  if (!result.ok) {
    throw new Error("Failed to seed database");
  }

  console.log("Database seeded.");
  console.log(`  Admin user: admin (password: admin)`);
  console.log(`  App token: ${token}`);
}

/**
 * admin の全 token を失効させ、新しい raw token を 1 つ発行する (CLI --renew)。
 * 旧 token は新 token を投入した後に削除するので、コマンド中断/失敗で admin が
 * 完全失職するリスクは無い (旧と新が両方一時的に有効、悪くて掃除し損ね)。
 */
async function renewAdminToken(kv: Deno.Kv): Promise<void> {
  const userIdEntry = await kv.get<number>(Keys.userByName("admin"));
  if (userIdEntry.value === null) {
    console.error("Admin user not found. Run `deno task seed` first.");
    Deno.exit(1);
  }
  const adminId = userIdEntry.value;

  const oldHashes: string[] = [];
  const tokenIter = kv.list<true>({ prefix: Keys.tokensByUserPrefix(adminId) });
  for await (const entry of tokenIter) {
    oldHashes.push(entry.key[2] as string);
  }

  const rawToken = crypto.randomUUID();
  const tokenHash = await hashToken(rawToken);
  const now = new Date();
  const tokenData: TokenData = {
    userId: adminId,
    name: `admin-token-${now.toISOString()}`,
    expiresAt: new Date(
      now.getTime() + 365 * 24 * 60 * 60 * 1000,
    ).toISOString(),
    createdAt: now.toISOString(),
  };

  // 1) 新 token を先に投入 (旧と並走させて failure safety を確保)
  const insertResult = await kv
    .atomic()
    .set(Keys.token(tokenHash), tokenData)
    .set(Keys.tokenByUser(adminId, tokenHash), true)
    .commit();
  if (!insertResult.ok) {
    console.error("Failed to insert new token.");
    Deno.exit(1);
  }

  // 2) 旧 token を 1 件ずつ削除 (失敗してもログだけ、新 token は活きてる)
  let removed = 0;
  for (const oldHash of oldHashes) {
    const res = await kv
      .atomic()
      .delete(Keys.token(oldHash))
      .delete(Keys.tokenByUser(adminId, oldHash))
      .commit();
    if (res.ok) removed++;
  }

  console.log("Admin token renewed.");
  console.log(`  Removed ${removed} existing token(s).`);
  console.log(`  Admin user: admin (id=${adminId})`);
  console.log(`  New app token: ${rawToken}`);
  console.log("");
  console.log("Save this token! It will not be shown again.");
}

/**
 * 既 seed 状態の admin 情報をダンプする (CLI 用)。
 * 注意: raw token は hash 化して保存しているので復元不可。表示できるのは
 * token name / expiresAt / hash prefix のみ。新しい token が欲しい場合は
 * `deno task seed --renew` で再発行する。
 */
async function printExistingSeed(kv: Deno.Kv, adminId: number): Promise<void> {
  const userEntry = await kv.get<User>(Keys.user(adminId));
  const user = userEntry.value;
  if (!user) {
    console.log(`  Admin user record missing for id=${adminId}`);
    return;
  }

  console.log(`  Admin user: ${user.name} (id=${user.id})`);
  console.log(`    createdAt: ${user.createdAt}`);

  const tokenIter = kv.list<true>({ prefix: Keys.tokensByUserPrefix(adminId) });
  let count = 0;
  for await (const entry of tokenIter) {
    const tokenHash = entry.key[2] as string;
    const tokenEntry = await kv.get<TokenData>(Keys.token(tokenHash));
    const token = tokenEntry.value;
    if (!token) continue;
    count++;
    console.log(`  Token ${count}: ${token.name}`);
    console.log(`    hash (prefix): ${tokenHash.slice(0, 16)}...`);
    console.log(`    expiresAt: ${token.expiresAt}`);
  }
  if (count === 0) {
    console.log("  (no tokens)");
  }
  console.log("");
  console.log(
    "Raw token values are not stored; re-seed (wipe + retry) or issue a new token to obtain one.",
  );
}

// CLI 実行時のみ最後に close する。プロセス常駐の main.ts から呼ぶ時は close しない。
// `deno task seed`         : 未 seed なら seed、既 seed なら情報ダンプ
// `deno task seed --renew` : admin の token を全失効して新 raw token を発行
if (import.meta.main) {
  const renew = Deno.args.includes("--renew");
  const kv = await getKv();
  if (renew) {
    await renewAdminToken(kv);
  } else {
    const existing = await kv.get<number>(Keys.userByName("admin"));
    if (existing.value !== null) {
      console.log("Database already seeded. Skipping.");
      await printExistingSeed(kv, existing.value);
    } else {
      await seedIfEmpty();
    }
  }
  closeKv();
}
