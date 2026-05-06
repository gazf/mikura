// Test setup for issue #4 / #5 verification.
// Creates a "guest" user with read access to /public only, plus test files.
// Usage: deno run --allow-read --allow-write --allow-env --unstable-kv setup-test-users.ts

import { closeKv, getKv } from "./src/kv/store.ts";
import { Keys } from "./src/kv/keys.ts";
import { createAppToken } from "./src/services/auth.service.ts";
import type { Group, Permission, User } from "./src/types.ts";

async function nextId(kv: Deno.Kv, entity: string): Promise<number> {
  const key = Keys.counter(entity);
  const result = await kv.get<number>(key);
  const currentValue = result.value ?? 0;
  const nextValue = currentValue + 1;
  const commit = await kv.atomic().check(result).set(key, nextValue).commit();
  if (!commit.ok) throw new Error(`Failed to increment counter for ${entity}`);
  return nextValue;
}

async function getOrCreateUser(name: string): Promise<number> {
  const kv = await getKv();
  const existing = await kv.get<number>(Keys.userByName(name));
  if (existing.value) return existing.value;

  const id = await nextId(kv, "users");
  const user: User = {
    id,
    name,
    passwordHash: "",
    createdAt: new Date().toISOString(),
  };
  await kv
    .atomic()
    .set(Keys.user(id), user)
    .set(Keys.userByName(name), id)
    .commit();
  return id;
}

async function getOrCreateGroup(name: string): Promise<number> {
  const kv = await getKv();
  // Walk groups (small number expected)
  for await (const e of kv.list<Group>({ prefix: ["group"] })) {
    if (e.value.name === name) return e.value.id;
  }
  const id = await nextId(kv, "groups");
  const group: Group = { id, name };
  await kv.set(Keys.group(id), group);
  return id;
}

const guestUserId = await getOrCreateUser("guest");
const guestsGroupId = await getOrCreateGroup("guests");

const kv = await getKv();
await kv
  .atomic()
  .set(Keys.userGroup(guestUserId, guestsGroupId), true)
  .set(
    Keys.permission("/public", guestsGroupId),
    {
      accessLevel: "read",
    } satisfies Permission,
  )
  .commit();

// Issue token for guest
const { raw } = await createAppToken(guestUserId, "test-guest-token");
console.log(`guest user id   : ${guestUserId}`);
console.log(`guests group id : ${guestsGroupId}`);
console.log(`guest token     : ${raw}`);

closeKv();
