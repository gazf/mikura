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

async function seed() {
  const kv = await getKv();

  // Check if already seeded
  const existingUser = await kv.get(Keys.userByName("admin"));
  if (existingUser.value !== null) {
    console.log("Database already seeded. Skipping.");
    closeKv();
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

  // Generate an initial app token
  const rawToken = crypto.randomUUID();
  const tokenHash = await hashToken(rawToken);
  const tokenData: TokenData = {
    userId: adminId,
    name: "initial-admin-token",
    expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date().toISOString(),
  };

  // Atomic write: all or nothing
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
    console.error("Failed to seed database.");
    closeKv();
    Deno.exit(1);
  }

  console.log("Database seeded successfully.");
  console.log(`  Admin user: admin (password: admin)`);
  console.log(`  Admin group: admins`);
  console.log(`  Root permission: / -> admins (admin)`);
  console.log(`  App token: ${rawToken}`);
  console.log("");
  console.log("Save this token! It will not be shown again.");

  closeKv();
}

seed();
