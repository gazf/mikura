/**
 * enrollUrl (ADR-034) の責務:
 *   - MIKURA_PUBLIC_URL が「無い / 壊れている / http(s) でない」場合は null を
 *     返し、推測した URL を絶対に組み立てない
 *   - 組み立てた URI は client 側 parser が読める形 (scheme + u/s query)
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildEnrollUrl,
  buildEnrollUrlTemplate,
  getPublicBaseUrl,
} from "../src/util/enrollUrl.ts";

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

// ----- 未設定時の雛形 (ADR-034) -----

/** MIKURA_PORT を退避して fn を実行し、必ず元に戻す。 */
async function withPort(
  value: string | undefined,
  fn: () => void | Promise<void>,
): Promise<void> {
  const prev = Deno.env.get("MIKURA_PORT");
  if (value === undefined) Deno.env.delete("MIKURA_PORT");
  else Deno.env.set("MIKURA_PORT", value);
  try {
    await fn();
  } finally {
    if (prev === undefined) Deno.env.delete("MIKURA_PORT");
    else Deno.env.set("MIKURA_PORT", prev);
  }
}

Deno.test("buildEnrollUrlTemplate: 未設定なら host だけが差し込み語の雛形を返す", async () => {
  await withPublicUrl(undefined, async () => {
    await withPort(undefined, () => {
      const url = buildEnrollUrlTemplate("s3cret");
      assert(url !== null);
      const parsed = new URL(url!);
      assertEquals(parsed.searchParams.get("u"), "http://HOST:8700");
      assertEquals(parsed.searchParams.get("s"), "s3cret");
    });
  });
});

Deno.test("buildEnrollUrlTemplate: ポートは実際の待ち受け値を使う (そこは推測ではない)", async () => {
  await withPublicUrl(undefined, async () => {
    await withPort("9999", () => {
      const url = buildEnrollUrlTemplate("s3cret");
      assertEquals(new URL(url!).searchParams.get("u"), "http://HOST:9999");
    });
  });
});

Deno.test("buildEnrollUrlTemplate: 設定済みなら null (配れるリンクと取り違えさせない)", async () => {
  await withPublicUrl("https://files.example.com", () => {
    assertEquals(buildEnrollUrlTemplate("s3cret"), null);
  });
});

Deno.test("設定済みと未設定で、enrollUrl と雛形が同時に非 null にならない", async () => {
  for (const configured of [undefined, "https://files.example.com"]) {
    await withPublicUrl(configured, () => {
      const real = buildEnrollUrl(getPublicBaseUrl(), "s3cret");
      const template = buildEnrollUrlTemplate("s3cret");
      assertEquals(real === null, template !== null);
    });
  }
});
