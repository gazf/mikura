import { Hono } from "@hono/hono";
import {
  refreshDeviceLocks,
  releaseDeviceLocks,
} from "../services/lock.service.ts";
import {
  abortDeviceSessions,
  refreshDeviceSessions,
} from "../services/upload.service.ts";
import {
  isRegisteredPeer,
  type Peer,
  registerSocket,
  touchPeer,
  unregisterSocket,
} from "../services/wsBroadcast.service.ts";
import { logAudit } from "../services/audit.service.ts";
import type { AuthUser } from "../services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
  };
};

interface IncomingMessage {
  type?: string;
  deviceId?: string;
}

/** audit 用の直近 IP。判定には使わない付随情報 (auth ミドルウェアと同じ導出)。 */
function clientIp(c: { req: { header(name: string): string | undefined } }) {
  return c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
    c.req.header("X-Real-IP") ?? "unknown";
}

export function registerEventRoutes(app: Hono<Env>) {
  app.get("/events", (c) => {
    // 接続ユーザーを auth ミドルウェアから取得。
    // ファイル変更通知は file.service / upload.service が API operation の
    // 完了直後に broadcastFileEvent で明示発火する設計に統一されている
    // (Deno.watchFs ベースの観測は OS / Deno 依存で取りこぼし・冗長発火が
    // あったため撤去)。
    const user = c.get("user");
    const { socket, response } = Deno.upgradeWebSocket(c.req.raw);

    const peer: Peer = {
      socket,
      userId: user.id,
      deviceId: user.deviceId,
    };

    socket.onopen = () => {
      const result = registerSocket(peer);
      if (result.ok) return;

      // 同じ deviceId の WSS が既に生きている。正規クライアントは単一
      // インスタンス mutex で 2 本張らないので、これは token + deviceId が
      // 複製された signal。1 本目は触らず 2 本目だけ閉じ、admin が revoke を
      // 判断できるように監査ログへ残す (IP は付随情報。判定には使わない)。
      logAudit(
        user.id,
        "wss_duplicate_device",
        `device:${user.deviceId.slice(0, 8)}`,
        clientIp(c),
      ).catch((err) => console.error("logAudit failed:", err));
      try {
        socket.close(4409, "duplicate device");
      } catch { /* 既に閉じている */ }
    };

    // ADR-018 Step 2/3: WSS heartbeat / terminate。deviceId は接続時に検証済みの
    // user.deviceId と一致する場合のみ受理 (なりすまし防止)。
    socket.onmessage = (ev) => {
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }

      // deviceId 単位の副作用 (lock 延長 / 解放、session abort) を持つので、
      // **登録済みの peer からのメッセージだけ**受理する。拒否された 2 本目や
      // 置き換えられた zombie が、生きている 1 本目の lock を道連れにしない。
      if (!isRegisteredPeer(peer)) return;

      if (msg.deviceId !== user.deviceId) {
        console.log(
          `[wss] message rejected (deviceId mismatch): expected=${
            user.deviceId.slice(0, 8)
          } got=${(msg.deviceId ?? "").slice(0, 8)} type=${msg.type}`,
        );
        return;
      }

      if (msg.type === "heartbeat") {
        touchPeer(peer);
        console.log(
          `[wss] heartbeat from deviceId=${user.deviceId.slice(0, 8)}`,
        );
        refreshDeviceLocks(user.deviceId, user.id).then((n) => {
          if (n > 0) {
            console.log(
              `[wss] refreshed ${n} lock(s) for ${user.deviceId.slice(0, 8)}`,
            );
          }
        }).catch((err) => {
          console.error("refreshDeviceLocks failed:", err);
        });
        // ADR-025: upload session の TTL も lock と一緒に延長する。
        refreshDeviceSessions(user.deviceId, user.id).then((n) => {
          if (n > 0) {
            console.log(
              `[wss] refreshed ${n} upload session(s) for ${
                user.deviceId.slice(0, 8)
              }`,
            );
          }
        }).catch((err) => {
          console.error("refreshDeviceSessions failed:", err);
        });
      } else if (msg.type === "terminate") {
        console.log(
          `[wss] terminate from deviceId=${user.deviceId.slice(0, 8)}`,
        );
        releaseDeviceLocks(user.deviceId, user.id).then((n) => {
          console.log(
            `[wss] terminate released ${n} lock(s) for ${
              user.deviceId.slice(0, 8)
            }`,
          );
        }).catch((err) => {
          console.error("releaseDeviceLocks failed:", err);
        });
        // ADR-025: 終了に合わせて未 finalize の upload session も abort。
        abortDeviceSessions(user.deviceId, user.id).then((n) => {
          if (n > 0) {
            console.log(
              `[wss] terminate aborted ${n} upload session(s) for ${
                user.deviceId.slice(0, 8)
              }`,
            );
          }
        }).catch((err) => {
          console.error("abortDeviceSessions failed:", err);
        });
      }
    };

    const cleanup = () => {
      unregisterSocket(peer);
    };
    socket.onclose = cleanup;
    socket.onerror = cleanup;

    return response;
  });
}
