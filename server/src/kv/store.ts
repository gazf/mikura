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
