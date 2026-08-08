/**
 * API サーバへの HTTP クライアント。
 *
 * ADR-033: console は Deno KV を開かず、権限判定も自前では持たない。認可は
 * 全て API サーバ側の `authMiddleware` + `requireAdmin` が行い、console は
 * 「admin token を持った 1 クライアント」として振る舞う (= cli/adminClient.ts
 * と同じ立場)。
 *
 * bearer token は session ごとに保持され、この関数の引数として渡される。
 * console プロセスが disk に書くことも、browser に返すこともない。
 */

export interface ApiResponse<T> {
  status: number;
  /** JSON として読めた場合のみ入る。204 / 非 JSON では undefined。 */
  body?: T;
  /** エラー時に server が返した message (あれば)。 */
  message?: string;
}

export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly deviceId: string,
  ) {}

  async request<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Device-Id": this.deviceId,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, init);
    } catch (e) {
      // API サーバが落ちている / 到達できない。console 自体は生きているので
      // 502 に畳んで UI 側で「API サーバに繋がらない」と出せるようにする。
      return {
        status: 502,
        message: `API server unreachable: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }

    if (res.status === 204) return { status: res.status };

    const text = await res.text();
    if (text.length === 0) return { status: res.status };

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        status: res.status,
        message: `API server returned non-JSON (${res.status})`,
      };
    }

    if (res.ok) return { status: res.status, body: parsed as T };

    const message = typeof parsed === "object" && parsed !== null &&
        typeof (parsed as { message?: unknown }).message === "string"
      ? (parsed as { message: string }).message
      : `API server returned ${res.status}`;
    return { status: res.status, body: parsed as T, message };
  }

  get<T>(token: string, path: string): Promise<ApiResponse<T>> {
    return this.request<T>(token, "GET", path);
  }

  post<T>(
    token: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    return this.request<T>(token, "POST", path, body);
  }

  put<T>(token: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(token, "PUT", path, body);
  }

  delete<T>(token: string, path: string): Promise<ApiResponse<T>> {
    return this.request<T>(token, "DELETE", path);
  }
}
