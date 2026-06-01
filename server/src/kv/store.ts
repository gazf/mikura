/**
 * KV を 2 系統に分ける:
 *
 *   - persistent (getKv): users / groups / tokens / permissions / audit /
 *     counters / devices ― restart で消えると困るデータ。SQLite backed。
 *   - ephemeral (getEphemeralKv): locks / uploads ― 再接続で再構築でき、
 *     server crash で staging 共々一貫性を失うので保つ意味がない。`:memory:`
 *     backed で per-op の SQLite mutex / WAL fsync を回避し、特に
 *     PATCH writeChunk の loadSession を高速化する。
 *
 * 将来マルチサーバ化したくなった時は ephemeral 側を Redis などの
 * 分散 KV に差し替える (Deno KV API 互換の adapter を噛ませる)。
 * service コードは Deno KV API に書かれているので影響範囲は小さい。
 */

let persistentKv: Deno.Kv | null = null;
let ephemeralKv: Deno.Kv | null = null;

export async function getKv(): Promise<Deno.Kv> {
  if (!persistentKv) {
    persistentKv = await Deno.openKv();
  }
  return persistentKv;
}

export async function getEphemeralKv(): Promise<Deno.Kv> {
  if (!ephemeralKv) {
    ephemeralKv = await Deno.openKv(":memory:");
  }
  return ephemeralKv;
}

export function closeKv(): void {
  if (persistentKv) {
    persistentKv.close();
    persistentKv = null;
  }
  if (ephemeralKv) {
    ephemeralKv.close();
    ephemeralKv = null;
  }
}

/**
 * テスト用: 任意の KV インスタンスでシングルトンを上書きする。
 * 既存があれば close せずに置き換える (テスト側がライフサイクル管理する想定)。
 */
export function setKvForTesting(testKv: Deno.Kv | null): void {
  persistentKv = testKv;
}

export function setEphemeralKvForTesting(testKv: Deno.Kv | null): void {
  ephemeralKv = testKv;
}

/**
 * 起動時に persistent KV から read-heavy な静的データを ephemeral KV にミラーする。
 * checkPermission など read path の KV アクセスを :memory: 速度に乗せる狙い。
 *
 * 対象 namespace:
 *   - users / users_by_name     (validateToken の user 引き)
 *   - groups                    (将来の name lookup)
 *   - user_groups               (checkPermission の group 引き)
 *   - permissions               (checkPermission の ACL 引き)
 *
 * mikura は現状これらを runtime に書き換える API を持たないので、startup 1 回の
 * 同期で十分。将来 admin API が出来た場合は persistent への write を ephemeral
 * にも反映する wrapper を service 層に置く前提。
 *
 * tokens は raw 値が hash 保存で再現不能のため persistent 維持。audit / counters
 * / devices も persistent 維持 (それぞれ理由は ADR を別途参照)。
 */
const WARMUP_PREFIXES: Deno.KvKey[] = [
  ["users"],
  ["users_by_name"],
  ["groups"],
  ["user_groups"],
  ["permissions"],
];

export async function warmupEphemeralFromPersistent(): Promise<number> {
  const p = await getKv();
  const e = await getEphemeralKv();
  let copied = 0;
  for (const prefix of WARMUP_PREFIXES) {
    for await (const entry of p.list({ prefix })) {
      await e.set(entry.key, entry.value);
      copied++;
    }
  }
  return copied;
}
