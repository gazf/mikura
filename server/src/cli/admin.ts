/**
 * `deno task admin <subcommand>` の entry point。
 *
 * 全 subcommand は `adminClient.ts` 経由で localhost HTTP を叩く。`MIKURA_ADMIN_TOKEN`
 * env var の admin bearer token を必要とする。
 *
 * Subcommands:
 *   - `list-users`
 *   - `add-user --name <n> [--role <r>]`             — role 名指定で同時に割り当て
 *   - `delete-user --id <n>`
 *   - `get-policy [--out <path>]`                    — 適用中のポリシー原文
 *   - `set-policy --file <path> [--dry-run]`         — ポリシー差し替え (ADR-035)
 *   - `list-assignments`
 *   - `assign-role --user <name> --role <r>`
 *   - `unassign-role --user <name> --role <r>`
 *   - `issue-init --user <name> --server-url <url> [--out <path>] [--ttl-days <n>]`
 *       → init.json (= { ServerUrl, EnrollmentSecret }) を stdout or --out に出力
 *   - `list-enrollments --user <name>`
 *   - `list-tokens --user <name>`
 *   - `revoke-token --hash <hash>`
 */

import { AdminClient, AdminCliError, runCli } from "./adminClient.ts";

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function requireStr(flags: Record<string, unknown>, key: string): string {
  const v = flags[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new AdminCliError(`--${key} required`);
  }
  return v;
}

function requireInt(flags: Record<string, unknown>, key: string): number {
  const v = flags[key];
  if (typeof v !== "string") throw new AdminCliError(`--${key} required`);
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) throw new AdminCliError(`--${key} must be integer`);
  return n;
}

interface UserRecord {
  id: number;
  name: string;
  createdAt: string;
}

interface PolicySaveResponse {
  ok: boolean;
  version?: number;
  errors: Array<{ line: number; message: string }>;
  testFailures: Array<{ line: number; message: string }>;
  warnings: Array<{ line: number; message: string }>;
  assertionFailures: Array<{ message: string }>;
  rejection?: string;
}

function printPolicyResult(r: PolicySaveResponse): void {
  for (const w of r.warnings) console.error(`warning: ${w.line}: ${w.message}`);
  for (const e of r.errors) console.error(`error: ${e.line}: ${e.message}`);
  for (const t of r.testFailures) {
    console.error(`test failed: ${t.line}: ${t.message}`);
  }
  for (const a of r.assertionFailures) {
    console.error(`assertion failed: ${a.message}`);
  }
  if (r.rejection) console.error(`rejected: ${r.rejection}`);
  if (r.ok) console.log(`ok (version ${r.version})`);
}

async function findUserByName(
  client: AdminClient,
  name: string,
): Promise<UserRecord> {
  const users = await client.get<UserRecord[]>("/admin/users");
  const match = users.find((u) => u.name === name);
  if (!match) throw new AdminCliError(`user not found: ${name}`);
  return match;
}

async function main(): Promise<void> {
  const [sub, ...rest] = Deno.args;
  if (!sub) {
    printUsage();
    Deno.exit(1);
  }
  const { flags } = parseArgs(rest);
  const client = new AdminClient();

  switch (sub) {
    case "list-users": {
      const users = await client.get<UserRecord[]>("/admin/users");
      for (const u of users) console.log(`${u.id}\t${u.name}\t${u.createdAt}`);
      break;
    }

    case "add-user": {
      const name = requireStr(flags, "name");
      const user = await client.post<UserRecord>("/admin/users", { name });
      console.log(`created user id=${user.id} name=${user.name}`);
      if (typeof flags["role"] === "string") {
        await client.post("/admin/assignments", {
          userId: user.id,
          role: flags["role"],
        });
        console.log(`assigned role ${flags["role"]}`);
      }
      break;
    }

    case "delete-user": {
      const id = requireInt(flags, "id");
      await client.delete(`/admin/users/${id}`);
      console.log(`deleted user id=${id}`);
      break;
    }

    case "get-policy": {
      const policy = await client.get<{ version: number; text: string }>(
        "/admin/policy",
      );
      const out = flags["out"];
      if (typeof out === "string") {
        await Deno.writeTextFile(out, policy.text);
        console.log(`wrote version ${policy.version} to ${out}`);
      } else {
        console.log(policy.text);
      }
      break;
    }

    case "set-policy": {
      const file = requireStr(flags, "file");
      const text = await Deno.readTextFile(file);
      const result = await client.put<PolicySaveResponse>("/admin/policy", {
        text,
        dryRun: flags["dry-run"] === true,
      });
      printPolicyResult(result);
      if (!result.ok) Deno.exit(1);
      break;
    }

    case "list-assignments": {
      const rows = await client.get<Array<{ userId: number; roles: string[] }>>(
        "/admin/assignments",
      );
      for (const r of rows) console.log(`${r.userId}\t${r.roles.join(",")}`);
      break;
    }

    case "assign-role": {
      const user = await findUserByName(client, requireStr(flags, "user"));
      const role = requireStr(flags, "role");
      await client.post("/admin/assignments", { userId: user.id, role });
      console.log(`assigned ${role} to ${user.name}`);
      break;
    }

    case "unassign-role": {
      const user = await findUserByName(client, requireStr(flags, "user"));
      const role = requireStr(flags, "role");
      await client.delete(
        `/admin/assignments/${user.id}/${encodeURIComponent(role)}`,
      );
      console.log(`unassigned ${role} from ${user.name}`);
      break;
    }

    case "issue-init": {
      const userName = requireStr(flags, "user");
      const serverUrl = requireStr(flags, "server-url");
      const ttlDays = typeof flags["ttl-days"] === "string"
        ? parseInt(flags["ttl-days"], 10)
        : 7;
      const user = await findUserByName(client, userName);
      const result = await client.post<
        { secret: string; secretHash: string; expiresAt: string }
      >("/admin/enrollments", { userId: user.id, ttlDays });
      const initJson = {
        ServerUrl: serverUrl,
        EnrollmentSecret: result.secret,
        ExpiresAt: result.expiresAt,
        UserName: user.name,
      };
      const out = typeof flags["out"] === "string" ? flags["out"] : undefined;
      const payload = JSON.stringify(initJson, null, 2);
      if (out) {
        await Deno.writeTextFile(out, payload);
        console.log(`wrote init.json: ${out}`);
        console.log(`  user: ${user.name} (id=${user.id})`);
        console.log(`  expiresAt: ${result.expiresAt}`);
      } else {
        console.log(payload);
      }
      break;
    }

    case "list-enrollments": {
      const userName = requireStr(flags, "user");
      const user = await findUserByName(client, userName);
      const list = await client.get<
        Array<{
          secretHash: string;
          createdAt: string;
          expiresAt: string;
          consumedAt?: string;
        }>
      >(`/admin/enrollments?userId=${user.id}`);
      for (const e of list) {
        const status = e.consumedAt
          ? `consumed@${e.consumedAt}`
          : "outstanding";
        console.log(
          `${e.secretHash.slice(0, 16)}...\t${status}\texp=${e.expiresAt}`,
        );
      }
      break;
    }

    case "list-tokens": {
      const userName = requireStr(flags, "user");
      const user = await findUserByName(client, userName);
      const tokens = await client.get<
        Array<{
          tokenHash: string;
          name: string;
          expiresAt: string;
          boundDeviceId?: string;
          lastUsedIp?: string;
          lastUsedAt?: string;
        }>
      >(`/admin/tokens?userId=${user.id}`);
      for (const t of tokens) {
        const bound = t.boundDeviceId
          ? `bound=${t.boundDeviceId.slice(0, 8)}`
          : "unbound";
        const last = t.lastUsedAt
          ? `last=${t.lastUsedAt}${t.lastUsedIp ? `@${t.lastUsedIp}` : ""}`
          : "never-used";
        console.log(
          `${t.tokenHash.slice(0, 16)}...\t${t.name}\t${bound}\t${last}`,
        );
      }
      break;
    }

    case "revoke-token": {
      const hash = requireStr(flags, "hash");
      if (hash.length !== 64) {
        throw new AdminCliError("--hash must be 64-char hex SHA256");
      }
      const res = await client.delete<{ revoked: boolean }>(
        `/admin/tokens/${hash}`,
      );
      console.log(res.revoked ? "revoked" : "not found");
      break;
    }

    default:
      printUsage();
      throw new AdminCliError(`unknown subcommand: ${sub}`);
  }
}

function printUsage(): void {
  console.error(
    `Usage:
  deno task admin <subcommand> [flags]

Subcommands:
  list-users
  add-user --name <n> [--role <r>]
  delete-user --id <n>
  get-policy [--out <path>]
  set-policy --file <path> [--dry-run]
  list-assignments
  assign-role --user <n> --role <r>
  unassign-role --user <n> --role <r>
  issue-init --user <n> --server-url <url> [--out <path>] [--ttl-days <n>]
  list-enrollments --user <n>
  list-tokens --user <n>
  revoke-token --hash <h>

Env:
  MIKURA_ADMIN_TOKEN  admin bearer token (= deno task seed の出力)
  MIKURA_ADMIN_URL    server base URL (default http://127.0.0.1:8700)
`,
  );
}

if (import.meta.main) {
  await runCli(main);
}
