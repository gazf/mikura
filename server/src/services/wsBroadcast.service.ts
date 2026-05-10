import { checkPermission } from "./auth.service.ts";
import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import type { User } from "../types.ts";

/**
 * ADR-018 Step 3: ロック取得・解放等のイベントを全クライアントに broadcast する。
 * 接続中の WSS ソケットを記録し、認可フィルタを掛けてから送信する。
 */

interface Peer {
  socket: WebSocket;
  userId: number;
  deviceId: string;
}

const peers = new Set<Peer>();

/** テスト用: peer 集合をリセットする。本番コードからは呼ばない。 */
export function _clearPeersForTesting(): void {
  peers.clear();
}

export function registerSocket(peer: Peer): void {
  peers.add(peer);
  console.log(
    `[wss] registered peer userId=${peer.userId} deviceId=${
      peer.deviceId.slice(0, 8)
    } (total=${peers.size})`,
  );
}

export function unregisterSocket(peer: Peer): void {
  peers.delete(peer);
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

export async function broadcastLockEvent(
  event: "lock_acquired" | "lock_released",
  filePath: string,
  holder: { userId: number; deviceId: string },
): Promise<void> {
  console.log(
    `[broadcast] ${event} path=${filePath} holder=${
      holder.deviceId.slice(0, 8)
    } peers=${peers.size}`,
  );
  if (peers.size === 0) return;

  const name = await resolveHolderName(holder.userId);
  const payload = JSON.stringify({
    event,
    path: filePath,
    holder: { ...holder, name } satisfies LockHolder,
  });

  let sent = 0;
  // 認可チェックは並列に。失敗 (権限なし) は黙って配信スキップ。
  // 自端末向けの broadcast はそもそも自分が起こした事象なので除外。
  await Promise.all(
    [...peers].map(async (peer) => {
      if (peer.deviceId === holder.deviceId) return;
      if (peer.socket.readyState !== WebSocket.OPEN) return;
      try {
        if (!(await checkPermission(peer.userId, filePath, "read"))) return;
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
    [...peers].map(async (peer) => {
      if (originatorDeviceId && peer.deviceId === originatorDeviceId) return;
      if (peer.socket.readyState !== WebSocket.OPEN) return;
      try {
        if (!(await checkPermission(peer.userId, filePath, "read"))) return;
        peer.socket.send(payload);
      } catch (err) {
        console.error("broadcastFileEvent send failed:", err);
      }
    }),
  );
}
