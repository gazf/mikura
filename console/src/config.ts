/**
 * console プロセスの設定。全て環境変数から読む。
 *
 * ADR-033: console は API サーバとは別プロセスで、既定 loopback bind。
 * 「管理していない間は起動していない」が前提なので、設定は最小限に留める。
 */

export interface ConsoleConfig {
  /** console が listen する host。既定 loopback (= 公開しない)。 */
  host: string;
  /** console が listen する port。 */
  port: number;
  /**
   * API サーバの base URL。console が dial する **内部** アドレスであって、
   * client に配る public URL ではない (後者は API サーバ側の
   * MIKURA_PUBLIC_URL が SSOT — ADR-034)。
   */
  apiUrl: string;
  /**
   * API サーバへ送る `X-Device-Id`。console はマウントしないので実体の無い
   * 論理 ID だが、authMiddleware が形式検証するので規約 (8-128 chars
   * [A-Za-z0-9_-]) は満たす必要がある。
   */
  deviceId: string;
  /**
   * session cookie に `Secure` を付けるか。loopback の平文 HTTP では
   * `Secure` を付けると cookie が一切保存されないので既定 off。
   * TLS 終端の後ろに置く場合は必ず on にする。
   */
  cookieSecure: boolean;
  /** session の idle timeout (ms)。無操作でこれを超えたら破棄。 */
  sessionIdleMs: number;
  /** session の絶対寿命 (ms)。操作中でもこれを超えたら破棄。 */
  sessionAbsoluteMs: number;
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (got: ${raw})`);
  }
  return n;
}

export function loadConfig(): ConsoleConfig {
  const apiUrlRaw = Deno.env.get("MIKURA_API_URL")?.trim() ||
    "http://127.0.0.1:8700";
  let apiUrl: string;
  try {
    const parsed = new URL(apiUrlRaw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("must be http/https");
    }
    apiUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch (e) {
    throw new Error(
      `MIKURA_API_URL is invalid: ${apiUrlRaw} (${
        e instanceof Error ? e.message : e
      })`,
    );
  }

  const deviceId = Deno.env.get("MIKURA_CONSOLE_DEVICE_ID")?.trim() ||
    "mikura-console";
  if (!DEVICE_ID_RE.test(deviceId)) {
    throw new Error(
      `MIKURA_CONSOLE_DEVICE_ID must match ${DEVICE_ID_RE} (got: ${deviceId})`,
    );
  }

  return {
    host: Deno.env.get("MIKURA_CONSOLE_HOST")?.trim() || "127.0.0.1",
    port: envInt("MIKURA_CONSOLE_PORT", 8701),
    apiUrl,
    deviceId,
    cookieSecure: Deno.env.get("MIKURA_CONSOLE_COOKIE_SECURE") === "true",
    sessionIdleMs: envInt("MIKURA_CONSOLE_SESSION_IDLE_MINUTES", 30) * 60_000,
    sessionAbsoluteMs: envInt("MIKURA_CONSOLE_SESSION_MAX_HOURS", 8) *
      3_600_000,
  };
}
