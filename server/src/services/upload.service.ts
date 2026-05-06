/**
 * ADR-025: range PATCH ベースの chunked upload セッション。
 *
 * 設計の要点:
 *   - session の TTL は ADR-018 の lock TTL と一致させ、WSS heartbeat の
 *     refresh で同期延長する。lock 失効 = session 失効、孤児セッションの
 *     発生源を SSOT 化する (lock service が腰)。
 *   - 認可は POST /uploads (start) で 1 回だけ。以後の PATCH/finalize は
 *     (uploadId, deviceId) の照合 = 認証で十分とする。
 *   - finalize は DATA_ROOT と同一 FS にある STAGING_ROOT からの
 *     Deno.rename で原子 (POSIX rename(2) は同一 FS 内のみ atomic)。
 *   - temp は **DATA_ROOT の外側 (STAGING_ROOT)** に置く。DATA_ROOT
 *     の中だと /tree, listDirectory, watchFs から漏れる経路が増えて
 *     全 API surface でフィルタする必要が出る上、Docker 化時にボリューム
 *     永続化の粒度が選べなくなる (storage は永続、staging は tmpfs / 再起動で
 *     消えて良い、を分けたい)。デフォルトは cwd/staging、MIKURA_STAGING_ROOT で
 *     override 可能。staging という命名は「commit 前に積まれる場所」という
 *     DB / データパイプライン由来の語感を踏襲(`tmp` / `cache` だと
 *     disposability を誤って示唆するので避ける)。
 */
import * as path from "@std/path";
import { getKv } from "../kv/store.ts";
import { Keys } from "../kv/keys.ts";
import { getDataRoot } from "./file.service.ts";
import { getLock } from "./lock.service.ts";
import { broadcastFileEvent } from "./wsBroadcast.service.ts";
import type { UploadSession } from "../types.ts";

const STAGING_ROOT = Deno.env.get("MIKURA_STAGING_ROOT") ??
  path.join(Deno.cwd(), "staging");
const SESSION_TTL_MS = 30 * 1000; // ADR-018 lock TTL と一致
const MAX_PATH_LEN = 4096;

export function getStagingRoot(): string {
  return STAGING_ROOT;
}

export class UploadServiceError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}

function tempPathFor(uploadId: string): string {
  return path.join(STAGING_ROOT, uploadId);
}

async function ensureStagingRoot(): Promise<void> {
  await Deno.mkdir(STAGING_ROOT, { recursive: true });
}

/**
 * 起動時に STAGING_ROOT を実体化させる (sibling の DATA_ROOT 同様、
 * 不在のまま起動して最初の upload で初めて作られると診断ログが分かりにくい
 * ため起動チェックで揃える)。既存なら no-op。
 */
export async function initializeStagingRoot(): Promise<void> {
  await ensureStagingRoot();
}

function validateRelativePath(rel: string): string {
  if (!rel || rel.includes("\0") || rel.length > MAX_PATH_LEN) {
    throw new UploadServiceError("Invalid path", 400);
  }
  // absolute (server-relative) path として `/foo/bar.txt` 形式を期待。
  if (!rel.startsWith("/")) {
    throw new UploadServiceError("Path must start with /", 400);
  }
  if (rel.includes("/../") || rel.endsWith("/..") || rel === "/..") {
    throw new UploadServiceError("Invalid path", 400);
  }
  return rel;
}

function resolveDestination(rel: string): string {
  const stripped = rel.replace(/^\/+/, "");
  const storageRoot = getDataRoot();
  const fullPath = path.resolve(path.join(storageRoot, stripped));
  if (!fullPath.startsWith(path.resolve(storageRoot))) {
    throw new UploadServiceError("Invalid path", 400);
  }
  return fullPath;
}

function generateUploadId(): string {
  return crypto.randomUUID();
}

/**
 * (POST /uploads) 新規セッション作成。lock holder と一致しなければ 403。
 *
 * <p>baseFromExisting=true の場合、path に既存ファイルがあれば temp に
 * コピーしてから session を始める。これにより「既存ファイルを部分修正する」
 * 用途で、クライアント側に in-memory バッファを持たずに済む (modify-in-place
 * 対応)。新規作成 (CreateAsync 相当) では false を渡し、空 temp で開始する。</p>
 */
export async function createSession(
  filePath: string,
  userId: number,
  deviceId: string,
  baseFromExisting = false,
): Promise<UploadSession> {
  validateRelativePath(filePath);

  // ADR-016: write lock を持っている device しかセッションを開けない。
  // lock 不在もしくは holder mismatch は 403。
  const lock = await getLock(filePath);
  if (!lock || lock.userId !== userId || lock.deviceId !== deviceId) {
    throw new UploadServiceError(
      "Lock holder mismatch (write lock required)",
      403,
    );
  }

  await ensureStagingRoot();
  const uploadId = generateUploadId();
  const tempPath = tempPathFor(uploadId);

  if (baseFromExisting) {
    // 既存 path のスナップショットを base にする。同一 FS 内なので CoW があれば
    // O(1)、無くてもデータコピー 1 回で済む。path が無ければ空 temp で開始。
    const dest = resolveDestination(filePath);
    try {
      await Deno.copyFile(dest, tempPath);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        const f = await Deno.open(tempPath, {
          write: true,
          create: true,
          truncate: true,
        });
        f.close();
      } else {
        throw e;
      }
    }
  } else {
    // O_CREAT 相当で空ファイルを作る。
    const file = await Deno.open(tempPath, {
      write: true,
      create: true,
      truncate: true,
    });
    file.close();
  }

  const now = new Date();
  const session: UploadSession = {
    uploadId,
    userId,
    deviceId,
    path: filePath,
    tempPath,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  };

  const kv = await getKv();
  const tx = await kv.atomic()
    .set(Keys.upload(uploadId), session, { expireIn: SESSION_TTL_MS })
    .set(Keys.uploadByDevice(deviceId, uploadId), null, {
      expireIn: SESSION_TTL_MS,
    })
    .commit();

  if (!tx.ok) {
    // 万一 KV 競合が起きたら temp を消して上位に返す。
    await Deno.remove(tempPath).catch(() => {});
    throw new UploadServiceError("Failed to create session", 500);
  }

  return session;
}

async function loadSession(
  uploadId: string,
  deviceId: string,
): Promise<UploadSession> {
  const kv = await getKv();
  const entry = await kv.get<UploadSession>(Keys.upload(uploadId));
  if (!entry.value) throw new UploadServiceError("Session not found", 404);
  if (entry.value.deviceId !== deviceId) {
    throw new UploadServiceError("Session not owned by this device", 403);
  }
  return entry.value;
}

/**
 * (PATCH /uploads/:uploadId) 任意 offset への chunk 書込み。
 *
 * ReadableStream を直接 file.write に流し、HTTP body を一旦 RAM に
 * 展開しない。8MB chunk なら 8MB 分の中間メモリが消える。同一 session への
 * 並行 PATCH は OS level で seek+write が独立するため安全 (call ごとに open)。
 */
export async function writeChunk(
  uploadId: string,
  deviceId: string,
  offset: number,
  body: ReadableStream<Uint8Array>,
): Promise<{ writtenAt: number; size: number }> {
  if (!Number.isFinite(offset) || offset < 0) {
    throw new UploadServiceError("Invalid offset", 400);
  }
  const session = await loadSession(uploadId, deviceId);

  const file = await Deno.open(session.tempPath, { write: true, read: true });
  try {
    await file.seek(offset, Deno.SeekMode.Start);
    const reader = body.getReader();
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      let written = 0;
      while (written < r.value.length) {
        written += await file.write(r.value.subarray(written));
      }
    }
    const stat = await file.stat();
    return { writtenAt: offset, size: stat.size };
  } finally {
    file.close();
  }
}

/**
 * (POST /uploads/:uploadId/finalize) サイズ確定 → 実 path に rename。
 * 同一 FS 内の rename(2) なので原子的。
 */
export async function finalizeSession(
  uploadId: string,
  deviceId: string,
  finalSize: number,
): Promise<{ size: number; lastModified: string }> {
  if (!Number.isFinite(finalSize) || finalSize < 0) {
    throw new UploadServiceError("Invalid size", 400);
  }
  const session = await loadSession(uploadId, deviceId);

  // ftruncate(finalSize) — sparse 末尾の切り詰め / 0-byte 確定の両方に対応。
  const file = await Deno.open(session.tempPath, { write: true, read: true });
  try {
    await file.truncate(finalSize);
  } finally {
    file.close();
  }

  // 実 path 解決と親 dir 作成。
  const dest = resolveDestination(session.path);
  await Deno.mkdir(path.dirname(dest), { recursive: true });

  // POSIX rename(2): 同一 FS 内なら原子的、上書き許可。
  await Deno.rename(session.tempPath, dest);

  const stat = await Deno.stat(dest);
  const lastModified = (stat.mtime ?? new Date()).toISOString();

  // ADR-024 の WSS broadcast 補強: rename 経由の create を Deno.watchFs が
  // 取りこぼすケースに備えて、finalize 側で明示的に modified を発火する
  // (file.service.ts.renameEntry と同じ理由)。staging→storage の rename
  // は他 client から見ると「path の中身が変わった」イベント。
  await broadcastFileEvent("modified", session.path, {
    type: "file",
    size: stat.size,
    lastModified,
  });

  // KV エントリを掃除。
  const kv = await getKv();
  await kv.atomic()
    .delete(Keys.upload(uploadId))
    .delete(Keys.uploadByDevice(deviceId, uploadId))
    .commit();

  return { size: stat.size, lastModified };
}

/**
 * (DELETE /uploads/:uploadId) セッション破棄。Cleanup-without-Modified、
 * クライアントクラッシュ後の lock 失効連動などから呼ばれる。
 */
export async function abortSession(
  uploadId: string,
  deviceId: string,
): Promise<void> {
  const session = await loadSession(uploadId, deviceId);
  await Deno.remove(session.tempPath).catch(() => {});
  const kv = await getKv();
  await kv.atomic()
    .delete(Keys.upload(uploadId))
    .delete(Keys.uploadByDevice(deviceId, uploadId))
    .commit();
}

/**
 * heartbeat 連動: 当該 device が保持する全セッションの TTL を再設定する。
 * lock service の refreshDeviceLocks と同じタイミングで呼ばれる前提。
 */
export async function refreshDeviceSessions(
  deviceId: string,
): Promise<number> {
  const kv = await getKv();
  let refreshed = 0;
  const iter = kv.list({ prefix: Keys.uploadsByDevicePrefix(deviceId) });
  for await (const entry of iter) {
    const uploadId = entry.key[2] as string;
    const sessionEntry = await kv.get<UploadSession>(Keys.upload(uploadId));
    if (!sessionEntry.value) {
      // 既に finalize/abort 済み → 残骸の逆引きを掃除。
      await kv.delete(entry.key);
      continue;
    }
    const refreshedSession: UploadSession = {
      ...sessionEntry.value,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    };
    const tx = await kv.atomic()
      .check(sessionEntry)
      .set(Keys.upload(uploadId), refreshedSession, {
        expireIn: SESSION_TTL_MS,
      })
      .set(Keys.uploadByDevice(deviceId, uploadId), null, {
        expireIn: SESSION_TTL_MS,
      })
      .commit();
    if (tx.ok) refreshed++;
  }
  return refreshed;
}

/**
 * 切断時等: 当該 device の全セッションを abort する。
 * lock service の releaseDeviceLocks と一緒に呼ぶ前提。
 */
export async function abortDeviceSessions(
  deviceId: string,
): Promise<number> {
  const kv = await getKv();
  let aborted = 0;
  const iter = kv.list({ prefix: Keys.uploadsByDevicePrefix(deviceId) });
  for await (const entry of iter) {
    const uploadId = entry.key[2] as string;
    const sessionEntry = await kv.get<UploadSession>(Keys.upload(uploadId));
    if (sessionEntry.value) {
      await Deno.remove(sessionEntry.value.tempPath).catch(() => {});
    }
    await kv.atomic()
      .delete(Keys.upload(uploadId))
      .delete(entry.key)
      .commit();
    aborted++;
  }
  return aborted;
}

// テストから session 一覧を覗くためのヘルパ (本番コードからは使わない想定)。
export async function _listSessionsForTesting(
  deviceId: string,
): Promise<UploadSession[]> {
  const kv = await getKv();
  const sessions: UploadSession[] = [];
  const iter = kv.list({ prefix: Keys.uploadsByDevicePrefix(deviceId) });
  for await (const entry of iter) {
    const uploadId = entry.key[2] as string;
    const sessionEntry = await kv.get<UploadSession>(Keys.upload(uploadId));
    if (sessionEntry.value) sessions.push(sessionEntry.value);
  }
  return sessions;
}
