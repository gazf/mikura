import { Hono } from "hono";
import {
  refreshDeviceLocks,
  releaseDeviceLocks,
} from "../services/lock.service.ts";
import {
  abortDeviceSessions,
  refreshDeviceSessions,
} from "../services/upload.service.ts";
import {
  registerSocket,
  unregisterSocket,
} from "../services/wsBroadcast.service.ts";
import type {
  AuthUser,
  PermissionContext,
} from "../services/auth.service.ts";

type Env = {
  Variables: {
    user: AuthUser;
    permCtx: PermissionContext;
  };
};

interface IncomingMessage {
  type?: string;
  deviceId?: string;
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

    const peer = {
      socket,
      userId: user.id,
      deviceId: user.deviceId,
    };

    socket.onopen = () => {
      registerSocket(peer);
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

      if (msg.deviceId !== user.deviceId) {
        console.log(
          `[wss] message rejected (deviceId mismatch): expected=${
            user.deviceId.slice(0, 8)
          } got=${(msg.deviceId ?? "").slice(0, 8)} type=${msg.type}`,
        );
        return;
      }

      if (msg.type === "heartbeat") {
        console.log(
          `[wss] heartbeat from deviceId=${user.deviceId.slice(0, 8)}`,
        );
        refreshDeviceLocks(user.deviceId).then((n) => {
          if (n > 0) {
            console.log(
              `[wss] refreshed ${n} lock(s) for ${user.deviceId.slice(0, 8)}`,
            );
          }
        }).catch((err) => {
          console.error("refreshDeviceLocks failed:", err);
        });
        // ADR-025: upload session の TTL も lock と一緒に延長する。
        refreshDeviceSessions(user.deviceId).then((n) => {
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
        releaseDeviceLocks(user.deviceId).then((n) => {
          console.log(
            `[wss] terminate released ${n} lock(s) for ${
              user.deviceId.slice(0, 8)
            }`,
          );
        }).catch((err) => {
          console.error("releaseDeviceLocks failed:", err);
        });
        // ADR-025: 終了に合わせて未 finalize の upload session も abort。
        abortDeviceSessions(user.deviceId).then((n) => {
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
