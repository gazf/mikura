let kv: Deno.Kv | null = null;

export async function getKv(): Promise<Deno.Kv> {
  if (!kv) {
    kv = await Deno.openKv();
  }
  return kv;
}

export function closeKv(): void {
  if (kv) {
    kv.close();
    kv = null;
  }
}

/**
 * テスト用: 任意の KV インスタンスでシングルトンを上書きする。
 * 既存があれば close せずに置き換える (テスト側がライフサイクル管理する想定)。
 */
export function setKvForTesting(testKv: Deno.Kv | null): void {
  kv = testKv;
}
