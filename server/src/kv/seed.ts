import { closeKv, getKv } from "./store.ts";
import { Keys } from "./keys.ts";
import {
  assignRole,
  findAdminRoleNames,
  importPolicyText,
  listRoles,
} from "../services/policy.service.ts";
import type { TokenData, User } from "../types.ts";

/**
 * ADR-035 のブートストラップポリシー。空のポリシーは既定 deny なので、
 * 管理操作を含めて何もできない状態になる。最初の 1 本はここが書く。
 *
 * `admins` は「何を与えるか」で名付けられていないただ 1 つのロールだが、
 * admin `/` の意味そのものなので例外扱いでよい。ユーザーが増えたら
 * `projects-editor` のような purpose 名で足していく。
 */
const BOOTSTRAP_POLICY = `# mikura のアクセス制御ポリシー (ADR-035)
#
# role <名前> { allow <read|write|admin> <パス> / deny <パス> }
# test <名前> { readable|writable|invisible|visible|admin <パス> }
#
# ルールは書いた順に関係なく、パスの具体度で決まる。ロールを足すと必ず
# 増える方向にしか動かない。何も割り当てられていないパスは不可視。

role admins {
  allow admin /
}

test admins {
  admin /
}
`;

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

  const adminUser: User = {
    id: adminId,
    name: "admin",
    passwordHash: await hashPassword("admin"),
    createdAt: new Date().toISOString(),
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
    .set(Keys.token(tokenHash), tokenData)
    .set(Keys.tokenByUser(adminId, tokenHash), true)
    .commit();

  if (!result.ok) {
    throw new Error("Failed to seed database");
  }

  // ロール投入 → 割り当ての順。逆にすると「未定義のロール」で弾かれる。
  await importPolicyText(BOOTSTRAP_POLICY, adminId, { skipGuards: true });
  const assigned = await assignRole(adminId, "admins");
  if (!assigned.ok) {
    throw new Error(`Failed to assign bootstrap role: ${assigned.error}`);
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

/**
 * ポリシーを KV に直接書き戻す break-glass (ADR-035)。
 *
 * 保存済みポリシーが解釈できないと server は起動しないので、HTTP 経由の
 * `deno task admin set-policy` では復旧できない。token を失った時に
 * `--renew` で救うのと同じ位置づけで、KV を直接触る経路を 1 本だけ残す。
 * 検証は通すので、壊れた文書で上書きすることはできない。
 */
async function installPolicyFromFile(path: string): Promise<void> {
  const text = await Deno.readTextFile(path);
  const result = await importPolicyText(text, 0, { skipGuards: true });
  if (!result.ok) {
    for (const e of result.errors) {
      console.error(`  ${e.line}行目: ${e.message}`);
    }
    console.error("取り込めませんでした。");
    Deno.exit(1);
  }
  console.log(`${result.roles} 個のロールを取り込みました。`);
  console.log("  (既存のロールは置き換えられ、割り当ては変更していません)");
}

/**
 * 管理者を復旧する break-glass (ADR-035)。
 *
 * `--policy` はポリシー文書を戻すだけで、割り当てには触らない。だが
 * `user_roles` が空だと誰も `admin /` を持たず、HTTP 経由の復旧経路は
 * その admin 権限を要求するので堂々巡りになる — 文書を直せても管理画面に
 * 入れない。ここは KV を直接触れる唯一の側なので、割り当てまで面倒を見る。
 *
 * 到達しうる経路は 3 つ: 旧スキーマからの移行、ポリシー投入前の起動、
 * 最後の admin を持つユーザーを外部から消した場合。
 */
async function grantAdmin(kv: Deno.Kv, userName: string): Promise<void> {
  const userIdEntry = await kv.get<number>(Keys.userByName(userName));
  if (userIdEntry.value === null) {
    console.error(`User not found: ${userName}`);
    console.error(
      "  `deno task seed` で初期化するか --user <name> を指定してください。",
    );
    Deno.exit(1);
  }
  const userId = userIdEntry.value;

  // ロールがまだ 1 つも無ければブートストラップを入れる。既にあるなら
  // **上書きしない** — 運用中の定義を復旧コマンドが書き換えるのは筋が悪い。
  if ((await listRoles()).length === 0) {
    const installed = await importPolicyText(BOOTSTRAP_POLICY, userId, {
      skipGuards: true,
    });
    console.log(`Bootstrap roles installed (${installed.roles}).`);
  }

  const adminRoles = await findAdminRoleNames();
  if (adminRoles.length === 0) {
    console.error("現在のポリシーに admin / を与えるロールがありません。");
    console.error("  `allow admin /` を持つロールを足してから、");
    console.error("  `deno task seed --policy <file>` で投入してください。");
    Deno.exit(1);
  }
  if (adminRoles.length > 1) {
    console.error(
      `admin / を与えるロールが複数あります: ${adminRoles.join(", ")}`,
    );
    console.error("  --role <name> でどれを割り当てるか指定してください。");
    Deno.exit(1);
  }

  const role = adminRoles[0];
  const res = await assignRole(userId, role);
  if (!res.ok) {
    console.error(`Failed to assign role: ${res.error}`);
    Deno.exit(1);
  }
  console.log(`Granted: ${userName} (id=${userId}) → role ${role}`);
  console.log("  server を再起動すると反映されます。");
}

// CLI 実行時のみ最後に close する。プロセス常駐の main.ts から呼ぶ時は close しない。
// `deno task seed`                  : 未 seed なら seed、既 seed なら情報ダンプ
// `deno task seed --renew`          : admin の token を全失効して新 raw token を発行
// `deno task seed --policy <file>`  : ポリシーを直接書き戻す (起動できない時の復旧)
// `deno task seed --grant-admin`    : 管理者を復旧する (割り当てまで面倒を見る)
if (import.meta.main) {
  const renew = Deno.args.includes("--renew");
  const policyIdx = Deno.args.indexOf("--policy");
  const grantAdminFlag = Deno.args.includes("--grant-admin");
  const userIdx = Deno.args.indexOf("--user");
  const kv = await getKv();
  if (grantAdminFlag) {
    await grantAdmin(
      kv,
      userIdx >= 0 ? Deno.args[userIdx + 1] ?? "admin" : "admin",
    );
  } else if (policyIdx >= 0) {
    const file = Deno.args[policyIdx + 1];
    if (!file) {
      console.error("--policy requires a file path");
      Deno.exit(1);
    }
    await installPolicyFromFile(file);
  } else if (renew) {
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
