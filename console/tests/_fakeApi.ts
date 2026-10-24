/**
 * ApiClient の手書き fake。
 *
 * console のテストで確かめたいのは「browser からの入力が、どんな upstream
 * リクエストに化けるか」なので、記録するのは (method, path, body) の並びで
 * 足りる。実 HTTP は張らない。
 */

import type { ApiResponse } from "../src/api/client.ts";

export interface RecordedCall {
  token: string;
  method: string;
  path: string;
  body?: unknown;
}

export class FakeApi {
  readonly calls: RecordedCall[] = [];

  /** `${method} ${path}` → 応答。未登録なら 200 + {} を返す。 */
  private readonly canned = new Map<string, ApiResponse<unknown>>();

  stub(method: string, path: string, res: ApiResponse<unknown>): void {
    this.canned.set(`${method} ${path}`, res);
  }

  get lastCall(): RecordedCall | undefined {
    return this.calls.at(-1);
  }

  /** 呼ばれた upstream path の一覧 (順序つき)。 */
  get paths(): string[] {
    return this.calls.map((c) => c.path);
  }

  // deno-lint-ignore require-await
  async request<T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<ApiResponse<T>> {
    this.calls.push({ token, method, path, body });
    const canned = this.canned.get(`${method} ${path}`);
    return (canned ?? { status: 200, body: {} }) as ApiResponse<T>;
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
