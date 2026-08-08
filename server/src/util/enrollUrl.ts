/**
 * ADR-034: enrollment 招待を 1 本の `mikura://enroll?...` URI として表現する。
 *
 * init.json を配るのをやめ、admin が copy して chat 等で渡せる 1 行にする。
 * client 側はこれを paste (または protocol handler 経由の click) で受け取り、
 * `(serverUrl, secret)` に分解して `POST /enroll` を投げる。
 *
 * secret は URI の query に載るが、この URI は **HTTP として dereference され
 * ない**。client が local で parse して secret を request body に載せ替えるので、
 * どこかの access log に残ることはない。
 */

/** ADR-034 の scheme + host 部。変更すると配布済みの招待が壊れる。 */
const ENROLL_URI_PREFIX = "mikura://enroll";

/**
 * `MIKURA_PUBLIC_URL` — client から到達可能な server の base URL。
 *
 * request から推測しない: reverse proxy 越しの `Host` は詐称可能だし、
 * console は internal な dial 先 (loopback / container network) しか知らない。
 * どちらも client に渡す値としては誤り。設定されていなければ `null` を返し、
 * 呼び出し側は `enrollUrl` を省く (= 誤った URL を配るより console 側で
 * 気付ける方がよい)。
 */
export function getPublicBaseUrl(): string | null {
  const raw = Deno.env.get("MIKURA_PUBLIC_URL")?.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    console.warn(`[enrollUrl] MIKURA_PUBLIC_URL is not a valid URL: ${raw}`);
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.warn(
      `[enrollUrl] MIKURA_PUBLIC_URL must be http/https: ${parsed.protocol}`,
    );
    return null;
  }
  // 末尾 slash は client 側の URL 結合で二重にならないよう落としておく。
  return parsed.origin + parsed.pathname.replace(/\/+$/, "");
}

/**
 * 招待 URI を組み立てる。`baseUrl` が null (= MIKURA_PUBLIC_URL 未設定) なら
 * null を返す。
 */
export function buildEnrollUrl(
  baseUrl: string | null,
  secret: string,
): string | null {
  if (!baseUrl) return null;
  const params = new URLSearchParams({ u: baseUrl, s: secret });
  return `${ENROLL_URI_PREFIX}?${params.toString()}`;
}
