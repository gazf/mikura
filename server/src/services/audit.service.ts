import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import type { AuditEntry } from "../types.ts";

let auditCounter = 0;

export async function logAudit(
  userId: number,
  action: string,
  path: string,
  ip: string,
): Promise<void> {
  const kv = await getKv();
  const timestamp = new Date().toISOString();
  const id = ++auditCounter;

  const entry: AuditEntry = { userId, action, path, ip };
  await kv.set(Keys.audit(timestamp, id), entry);
}
