/**
 * Admin CLI 用の共通 HTTP wrapper。
 *
 * `MIKURA_ADMIN_TOKEN` env var を読み、`MIKURA_ADMIN_URL` (default
 * http://127.0.0.1:8700) に対して Bearer 認証で localhost を叩く。
 *
 * Device-Id header: admin CLI は端末認証の対象ではないので、固定の
 * `cli-admin-xxxxxxxx-...` (= 32 char) を使う。bound token を CLI から
 * 叩く設計は無いので (= admin token は seed 由来 = boundDeviceId 未設定)
 * 一致 check で問題が出ることはない。
 *
 * 全 CLI は本 wrapper を介し、エラー format / token 解決を統一する。
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8700";
const CLI_DEVICE_ID = "cli-admin-static-device-id-00001";

export interface AdminClientOptions {
  baseUrl?: string;
  token?: string;
}

export class AdminClient {
  readonly baseUrl: string;
  readonly token: string;

  constructor(opts: AdminClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? Deno.env.get("MIKURA_ADMIN_URL") ??
      DEFAULT_BASE_URL;
    const tok = opts.token ?? Deno.env.get("MIKURA_ADMIN_TOKEN");
    if (!tok) {
      throw new AdminCliError(
        "MIKURA_ADMIN_TOKEN env var is required (= admin bearer token, e.g. from `deno task seed`)",
      );
    }
    this.token = tok;
  }

  private async req(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
      "X-Device-Id": CLI_DEVICE_ID,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    if (text && (text.startsWith("{") || text.startsWith("["))) {
      try {
        parsed = JSON.parse(text);
      } catch { /* keep as text */ }
    }
    return { status: res.status, body: parsed };
  }

  async get<T = unknown>(path: string): Promise<T> {
    return await this.ensureOk(await this.req("GET", path));
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return await this.ensureOk(await this.req("POST", path, body));
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return await this.ensureOk(await this.req("PUT", path, body));
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return await this.ensureOk(await this.req("DELETE", path));
  }

  // deno-lint-ignore require-await
  private async ensureOk<T>(
    res: { status: number; body: unknown },
  ): Promise<T> {
    if (res.status >= 200 && res.status < 300) {
      return res.body as T;
    }
    const message = (res.body && typeof res.body === "object" &&
        "message" in res.body)
      ? String((res.body as { message: unknown }).message)
      : JSON.stringify(res.body);
    throw new AdminCliError(`HTTP ${res.status}: ${message}`);
  }
}

export class AdminCliError extends Error {}

/** CLI から共通で呼ぶ entry point。catch して exit code を 1 に揃える。 */
export async function runCli(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AdminCliError) {
      console.error(e.message);
      Deno.exit(1);
    }
    throw e;
  }
}
