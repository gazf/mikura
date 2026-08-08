/**
 * browser session の保管。**プロセスメモリのみ**、disk には書かない。
 *
 * ADR-033: console は「必要なときだけ起動する管理ツール」なので、再起動で
 * session が消えるのは仕様。永続化すると admin token が disk に落ちることに
 * なり、console を落としている間の攻撃面をゼロにするという前提が崩れる。
 *
 * session が抱えるのは admin bearer token そのもの。browser 側に渡るのは
 * opaque な session id だけで、token は一度も browser に返らない。
 */

export interface Session {
  /** API サーバへの admin bearer token。browser には返さない。 */
  token: string;
  /** 表示用。login 時に `GET /admin/users` の結果から解決する。 */
  userName: string;
  userId: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionStoreOptions {
  idleMs: number;
  absoluteMs: number;
  /** テスト用。既定は Date.now。 */
  now?: () => number;
}

/** cookie 名。`__Host-` prefix は Secure 必須なので loopback 平文では使えない。 */
export const SESSION_COOKIE = "mikura_console_session";

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly now: () => number;

  constructor(opts: SessionStoreOptions) {
    this.idleMs = opts.idleMs;
    this.absoluteMs = opts.absoluteMs;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * session id は 256bit の乱数。`crypto.randomUUID()` (122bit) より広く取る
   * — session id は total order の推測耐性が要る唯一の値なので、ここだけは
   * 余裕を持たせる。
   */
  create(token: string, userId: number, userName: string): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const id = encodeBase64Url(bytes);
    const t = this.now();
    this.sessions.set(id, {
      token,
      userId,
      userName,
      createdAt: t,
      lastSeenAt: t,
    });
    return id;
  }

  /**
   * 有効なら session を返し、`lastSeenAt` を更新する。期限切れなら破棄して
   * undefined。呼ぶたびに sweep も走らせる (専用 timer を持たないのは、
   * 起動しっぱなしを想定しないプロセスで timer を回す意味が薄いため)。
   */
  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    this.sweep();
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.isExpired(s)) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastSeenAt = this.now();
    return s;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  /** テスト・診断用。 */
  get size(): number {
    return this.sessions.size;
  }

  private isExpired(s: Session): boolean {
    const t = this.now();
    return t - s.lastSeenAt > this.idleMs ||
      t - s.createdAt > this.absoluteMs;
  }

  private sweep(): void {
    for (const [id, s] of this.sessions) {
      if (this.isExpired(s)) this.sessions.delete(id);
    }
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
