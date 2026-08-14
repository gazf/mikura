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
 * `MIKURA_PUBLIC_URL` 未設定時に、host の位置に置く差し込み語。
 *
 * **明らかに実在しない語であることが要件**。ここに「それらしい」値
 * (`localhost` や Host ヘッダ由来の名前) を置くと、admin が気付かずに
 * そのまま配ってしまい、受け取った側が原因不明の接続失敗を踏む。
 * 大文字の `HOST` なら、リンクを見た時点で「置き換えるところ」と分かるし、
 * client 側もこの語を検出して弾ける。
 */
export const HOST_PLACEHOLDER = "HOST";

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

/**
 * `MIKURA_PUBLIC_URL` 未設定時に出す **雛形**。host だけを差し込み語にした、
 * 形は正しいがそのままでは繋がらない URI を返す。
 *
 * ポートは実際に待ち受けている値を使う。到達可能かどうかの推測ではなく
 * server 自身が知っている事実なので、ここを伏せる理由がない。scheme は
 * TLS 終端の有無を server が知らないので http に倒す (置き換えるのは admin)。
 *
 * 設定済みなら雛形は不要なので null を返す — 呼び出し側で「そのまま配れる
 * 招待」と「手直しが要る雛形」を取り違えないようにするため、両方が同時に
 * 非 null になることはない。
 */
export function buildEnrollUrlTemplate(secret: string): string | null {
  if (getPublicBaseUrl() !== null) return null;
  const port = Deno.env.get("MIKURA_PORT")?.trim() || "8700";
  const base = `http://${HOST_PLACEHOLDER}:${port}`;
  const params = new URLSearchParams({ u: base, s: secret });
  return `${ENROLL_URI_PREFIX}?${params.toString()}`;
}
