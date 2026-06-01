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
 * 既 seed 状態の admin 情報をダンプする (CLI 用)。
 * 注意: raw token は hash 化して保存しているので復元不可。表示できるのは
 * token name / expiresAt / hash prefix のみ。新しい token が欲しい場合は
 * KV を削除して再 seed するか、別途 issue-token コマンドを用意する。
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
// CLI 経由なら既 seed の no-op でも分かる情報を吐く (deno task seed の体感のため)。
if (import.meta.main) {
  const kv = await getKv();
  const existing = await kv.get<number>(Keys.userByName("admin"));
  if (existing.value !== null) {
    console.log("Database already seeded. Skipping.");
    await printExistingSeed(kv, existing.value);
  } else {
    await seedIfEmpty();
  }
  closeKv();
}
