import { checkPermission } from "./auth.service.ts";
import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import type { User } from "../types.ts";

/**
 * ADR-018 Step 3: ロック取得・解放等のイベントを全クライアントに broadcast する。
 * 接続中の WSS ソケットを記録し、認可フィルタを掛けてから送信する。
 */

export interface Peer {
  socket: WebSocket;
  userId: number;
  deviceId: string;
  /**
   * 最後に heartbeat を受けた時刻 (ms)。二重接続の判定に使う。
   * 呼び出し側は渡さなくてよい — registerSocket が登録時に埋める。
   */
  lastSeenMs?: number;
}

/**
 * deviceId ごとに 1 本。**Set<socket> ではなく Map<deviceId> にしてある**のが
 * 要点で、理由は 2 つある:
 *
 * 1. 副作用の遮断 — heartbeat / terminate は deviceId 単位で lock と upload
 *    session を触る。同じ deviceId で 2 本目が張られると、2 本目が terminate を
 *    送るだけで 1 本目が保持している lock が全部解放され、進行中の upload が
 *    abort される。1 本目は何もしていないのに保存を失う。
 * 2. 検知 — 「同一 deviceId の WSS が同時に 2 本」は、単一インスタンス mutex の
 *    ある正規クライアントでは構造的に起きない。つまり token + deviceId が
 *    複製されて別の場所から接続された確実な signal。IP を見ないので動的 IP・
 *    モバイル回線・CGNAT でも誤検知しない。
 */
const peers = new Map<string, Peer>();

/**
 * 既存 peer を「生きている」とみなす猶予。client の heartbeat 間隔 (10s) の 2 倍。
 *
 * これが無いと、half-open TCP で server 側の socket が OPEN のまま残っている間
 * **正規クライアントの再接続を拒否し続ける**ことになり、一瞬の回線切断が
 * 長時間の接続不能に化ける。heartbeat が途絶えた peer は zombie として
 * 置き換えを許し、生きている peer が相手のときだけ 2 本目を拒否する。
 */
const PEER_LIVENESS_MS = 20 * 1000;

/** テスト用: peer 集合をリセットする。本番コードからは呼ばない。 */
export function _clearPeersForTesting(): void {
  peers.clear();
}

export type RegisterResult =
  | { ok: true }
  | { ok: false; reason: "duplicate_device" };

/**
 * WSS peer を登録する。同じ deviceId の peer が既に生きている場合は
 * **2 本目を拒否する** (1 本目を優先する — 既存セッションを壊さない)。
 */
export function registerSocket(peer: Peer): RegisterResult {
  const existing = peers.get(peer.deviceId);
  if (existing !== undefined && existing !== peer && isPeerAlive(existing)) {
    console.warn(
      `[wss] duplicate device rejected userId=${peer.userId} deviceId=${
        peer.deviceId.slice(0, 8)
      } (existing peer is alive)`,
    );
    return { ok: false, reason: "duplicate_device" };
  }
  if (existing !== undefined && existing !== peer) {
    // zombie を置き換える。旧 socket は自分で閉じておく (onclose は
    // identity 一致を見るので、遅れて発火しても新 peer を落とさない)。
    console.log(
      `[wss] replacing stale peer deviceId=${peer.deviceId.slice(0, 8)}`,
    );
    try {
      existing.socket.close(4409, "replaced by newer connection");
    } catch { /* 既に閉じている */ }
  }

  peer.lastSeenMs = Date.now();
  peers.set(peer.deviceId, peer);
  console.log(
    `[wss] registered peer userId=${peer.userId} deviceId=${
      peer.deviceId.slice(0, 8)
    } (total=${peers.size})`,
  );
  return { ok: true };
}

function isPeerAlive(peer: Peer): boolean {
  if (
    peer.socket.readyState !== WebSocket.OPEN &&
    peer.socket.readyState !== WebSocket.CONNECTING
  ) {
    return false;
  }
  return Date.now() - (peer.lastSeenMs ?? 0) < PEER_LIVENESS_MS;
}

/**
 * この socket が現在登録されている peer かどうか。
 *
 * deviceId 単位の副作用 (heartbeat による lock 延長、terminate による解放) は
 * **これが true のときだけ**実行する。拒否された 2 本目や置き換えられた
 * zombie が、生きている 1 本目の lock / session を道連れにしないための歯止め。
 */
export function isRegisteredPeer(peer: Peer): boolean {
  return peers.get(peer.deviceId) === peer;
}

/** heartbeat を受けたことを記録する。liveness 判定の入力。 */
export function touchPeer(peer: Peer): void {
  if (peers.get(peer.deviceId) === peer) peer.lastSeenMs = Date.now();
}

/**
 * peer の登録を外す。**identity が一致する場合のみ**消す — 拒否された
 * 2 本目の close が、登録済みの 1 本目を Map から落とさないため。
 */
export function unregisterSocket(peer: Peer): void {
  if (peers.get(peer.deviceId) !== peer) return;
  peers.delete(peer.deviceId);
  console.log(
    `[wss] unregistered peer deviceId=${
      peer.deviceId.slice(0, 8)
    } (total=${peers.size})`,
  );
}

export interface LockHolder {
  userId: number;
  deviceId: string;
  name: string;
}

async function resolveHolderName(userId: number): Promise<string> {
  const kv = await getKv();
  const user = await kv.get<User>(Keys.user(userId));
  return user.value?.name ?? `user#${userId}`;
}

/**
 * ロックの変化を broadcast する。
 *
 * `holder` は「そのロックを持っていた / 持つことになった端末」、
 * `originatorDeviceId` は「この変化を起こした端末」で、**別物になりうる**
 * (他端末がこちらのロックを解除した場合)。配信除外と client 側の自己フィルタは
 * originator で行う — holder で除外していた間、強制解除が当人の端末にだけ
 * 届かず、持っていないロックを持っていると信じ続けていた。
 */
export async function broadcastLockEvent(
  event: "lock_acquired" | "lock_released",
  filePath: string,
  holder: { userId: number; deviceId: string },
  originatorDeviceId: string = holder.deviceId,
): Promise<void> {
  // peers.size===0 (single-client 運用) なら log もスキップ。fileLogger は async
  // 化済みだが、broadcast burst (Excel save dance で 14 lock × 2 log) は黙らせる
  // 価値がある (log ファイルのノイズ削減 + GC 圧)。
  if (peers.size === 0) return;
  console.log(
    `[broadcast] ${event} path=${filePath} holder=${
      holder.deviceId.slice(0, 8)
    } by=${originatorDeviceId.slice(0, 8)} peers=${peers.size}`,
  );

  const name = await resolveHolderName(holder.userId);
  const payload = JSON.stringify({
    event,
    path: filePath,
    holder: { ...holder, name } satisfies LockHolder,
    originatorDeviceId,
  });

  let sent = 0;
  // 認可チェックは並列に。失敗 (権限なし) は黙って配信スキップ。
  // 自端末向けの broadcast はそもそも自分が起こした事象なので除外。除外は
  // **originator** で行う (holder で除外すると強制解除が当人に届かない)。
  await Promise.all(
    [...peers.values()].map(async (peer) => {
      if (peer.deviceId === originatorDeviceId) return;
      if (peer.socket.readyState !== WebSocket.OPEN) return;
      try {
        if (
          !(await checkPermission(peer.userId, filePath, "read"))
        ) {
          return;
        }
        peer.socket.send(payload);
        sent++;
      } catch (err) {
        console.error("broadcastLockEvent send failed:", err);
      }
    }),
  );
  console.log(`[broadcast] ${event} delivered to ${sent}/${peers.size} peers`);
}

/**
 * ファイルツリーの変化を全 peer に broadcast する。
 * Deno.watchFs ベースの観測 (events.ts 内) は OS / Deno のバージョンに
 * よって rename の "create" 側を取りこぼすことがあるため、API 経由の
 * 操作 (rename, finalize, create dir 等) はこの関数で**明示的に発火する**
 * ことで取りこぼし無し。watcher は外部書込み (data/ 直接編集等) の
 * 検出用に残してあり、両方が同じ event を吐いても client 側の
 * ApplyExternalEvent は idempotent なので害は無い。
 */
export async function broadcastFileEvent(
  event: "created" | "modified" | "deleted",
  filePath: string,
  meta?: { type: "file" | "directory"; size: number; lastModified: string },
  originatorDeviceId?: string,
): Promise<void> {
  if (peers.size === 0) return;

  // payload に originatorDeviceId を載せておくのは client 側 defense-in-depth。
  // server が万一フィルタ漏れしても、SyncEngine 側で自端末発の event を捨てて
  // 二重 ApplyExternalEvent + Shell.Notify を防げる。
  const base = event === "deleted" ? { event, path: filePath } : {
    event,
    path: filePath,
    type: meta?.type ?? "file",
    size: meta?.size ?? 0,
    lastModified: meta?.lastModified ?? new Date().toISOString(),
  };
  const payload = JSON.stringify(
    originatorDeviceId ? { ...base, originatorDeviceId } : base,
  );

  await Promise.all(
    [...peers.values()].map(async (peer) => {
      if (originatorDeviceId && peer.deviceId === originatorDeviceId) return;
      if (peer.socket.readyState !== WebSocket.OPEN) return;
      try {
        if (
          !(await checkPermission(peer.userId, filePath, "read"))
        ) {
          return;
        }
        peer.socket.send(payload);
      } catch (err) {
        console.error("broadcastFileEvent send failed:", err);
      }
    }),
  );
}
