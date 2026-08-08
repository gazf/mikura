/**
 * enrollUrl (ADR-034) の責務:
 *   - MIKURA_PUBLIC_URL が「無い / 壊れている / http(s) でない」場合は null を
 *     返し、推測した URL を絶対に組み立てない
 *   - 組み立てた URI は client 側 parser が読める形 (scheme + u/s query)
 */

import { assert, assertEquals } from "@std/assert";
import { buildEnrollUrl, getPublicBaseUrl } from "../src/util/enrollUrl.ts";

/** env を退避して fn を実行し、必ず元に戻す。 */
async function withPublicUrl(
  value: string | undefined,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prev = Deno.env.get("MIKURA_PUBLIC_URL");
  if (value === undefined) Deno.env.delete("MIKURA_PUBLIC_URL");
  else Deno.env.set("MIKURA_PUBLIC_URL", value);
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("MIKURA_PUBLIC_URL");
    else Deno.env.set("MIKURA_PUBLIC_URL", prev);
  }
}

Deno.test("getPublicBaseUrl: 未設定 / 空白のみは null", async () => {
  await withPublicUrl(undefined, () => {
    assertEquals(getPublicBaseUrl(), null);
  });
  await withPublicUrl("   ", () => {
    assertEquals(getPublicBaseUrl(), null);
  });
});

Deno.test("getPublicBaseUrl: URL として壊れていれば null", async () => {
  await withPublicUrl("files.example.com:8700", () => {
    assertEquals(getPublicBaseUrl(), null);
  });
});

Deno.test("getPublicBaseUrl: http(s) 以外の scheme は null", async () => {
  await withPublicUrl("ftp://files.example.com", () => {
    assertEquals(getPublicBaseUrl(), null);
  });
});

Deno.test("getPublicBaseUrl: 末尾 slash を落として返す", async () => {
  await withPublicUrl("https://files.example.com:8700/", () => {
    assertEquals(getPublicBaseUrl(), "https://files.example.com:8700");
  });
  await withPublicUrl("https://files.example.com/mikura//", () => {
    assertEquals(getPublicBaseUrl(), "https://files.example.com/mikura");
  });
});

Deno.test("buildEnrollUrl: baseUrl が null なら null (secret があっても組み立てない)", () => {
  assertEquals(buildEnrollUrl(null, "some-secret"), null);
});

Deno.test("buildEnrollUrl: scheme と u/s query を持つ URI を返す", () => {
  const url = buildEnrollUrl(
    "https://files.example.com:8700",
    "11111111-2222-3333-4444-555555555555",
  );
  assert(url);
  const parsed = new URL(url);
  assertEquals(parsed.protocol, "mikura:");
  assertEquals(
    parsed.searchParams.get("u"),
    "https://files.example.com:8700",
  );
  assertEquals(
    parsed.searchParams.get("s"),
    "11111111-2222-3333-4444-555555555555",
  );
});

Deno.test("buildEnrollUrl: URL は percent-encode されて query 境界を壊さない", () => {
  const url = buildEnrollUrl("https://files.example.com:8700", "a&b=c");
  assert(url);
  // 生の & が載っていたら s の値が途中で切れる
  assert(!url.includes("a&b=c"));
  assertEquals(new URL(url).searchParams.get("s"), "a&b=c");
});
