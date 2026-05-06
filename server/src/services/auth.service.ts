import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import type {
  AccessLevel,
  DeviceData,
  Permission,
  TokenData,
  User,
} from "../types.ts";

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function generateToken(): string {
  return crypto.randomUUID();
}

export async function hashToken(token: string): Promise<string> {
  return await sha256(token);
}

export interface TokenIdentity {
  id: number;
  name: string;
}

export interface AuthUser extends TokenIdentity {
  deviceId: string;
}

export async function upsertDevice(
  deviceId: string,
  userId: number,
  ipAddress?: string,
): Promise<void> {
  const kv = await getKv();
  const now = new Date().toISOString();
  const existing = await kv.get<DeviceData>(Keys.device(deviceId));

  const device: DeviceData = existing.value
    ? {
      ...existing.value,
      userId,
      lastSeenAt: now,
      ipAddress,
    }
    : {
      deviceId,
      userId,
      firstSeenAt: now,
      lastSeenAt: now,
      ipAddress,
    };

  await kv
    .atomic()
    .set(Keys.device(deviceId), device)
    .set(Keys.deviceByUser(userId, deviceId), true)
    .commit();
}

export async function validateToken(
  rawToken: string,
): Promise<TokenIdentity | null> {
  const kv = await getKv();
  const tokenHash = await hashToken(rawToken);
  const entry = await kv.get<TokenData>(Keys.token(tokenHash));
  if (!entry.value) return null;

  const tokenData = entry.value;

  // Check expiry
  if (new Date(tokenData.expiresAt) < new Date()) {
    return null;
  }

  const user = await kv.get<User>(Keys.user(tokenData.userId));
  if (!user.value) return null;

  return { id: user.value.id, name: user.value.name };
}

export async function createAppToken(
  userId: number,
  name: string,
  expiresInDays: number = 365,
): Promise<{ raw: string; hash: string }> {
  const kv = await getKv();
  const raw = generateToken();
  const hash = await hashToken(raw);

  const tokenData: TokenData = {
    userId,
    name,
    expiresAt: new Date(
      Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
    ).toISOString(),
    createdAt: new Date().toISOString(),
  };

  await kv
    .atomic()
    .set(Keys.token(hash), tokenData)
    .set(Keys.tokenByUser(userId, hash), true)
    .commit();

  return { raw, hash };
}

async function getUserGroupIds(userId: number): Promise<number[]> {
  const kv = await getKv();
  const groupIds: number[] = [];
  const iter = kv.list<boolean>({ prefix: Keys.userGroupsPrefix(userId) });
  for await (const entry of iter) {
    // Key is ["user_groups", userId, groupId]
    const groupId = entry.key[2] as number;
    groupIds.push(groupId);
  }
  return groupIds;
}

export async function checkPermission(
  userId: number,
  path: string,
  requiredLevel: "read" | "write",
): Promise<boolean> {
  const groupIds = await getUserGroupIds(userId);
  if (groupIds.length === 0) return false;

  const kv = await getKv();

  // Walk up the path hierarchy to find the most specific permission
  const pathParts = path.split("/").filter(Boolean);
  const pathsToCheck = ["/"];
  let current = "";
  for (const part of pathParts) {
    current += "/" + part;
    pathsToCheck.push(current);
  }

  // Check from most specific to least specific
  for (let i = pathsToCheck.length - 1; i >= 0; i--) {
    const checkPath = pathsToCheck[i];
    for (const groupId of groupIds) {
      const perm = await kv.get<Permission>(
        Keys.permission(checkPath, groupId),
      );
      if (perm.value) {
        return hasAccess(perm.value.accessLevel, requiredLevel);
      }
    }
  }

  return false;
}

function hasAccess(granted: AccessLevel, required: "read" | "write"): boolean {
  if (granted === "admin") return true;
  if (granted === "write") return true;
  if (granted === "read" && required === "read") return true;
  return false;
}
