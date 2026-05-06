import * as path from "@std/path";
import { statfs } from "node:fs/promises";
import { broadcastFileEvent } from "./wsBroadcast.service.ts";
import type { FileEntry } from "../types.ts";

const DATA_ROOT = Deno.env.get("MIKURA_DATA_ROOT") ??
  path.join(Deno.cwd(), "data");

function resolveAndValidate(relativePath: string): string {
  // Reject null bytes
  if (relativePath.includes("\0")) {
    throw new FileServiceError("Invalid path", 400);
  }

  // Strip leading slashes so path.join doesn't treat it as absolute
  const stripped = relativePath.replace(/^\/+/, "");

  // Normalize and resolve
  const normalized = stripped
    ? path.normalize(stripped).replace(/\\/g, "/")
    : ".";

  // Reject path traversal
  if (
    normalized.startsWith("..") || normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    throw new FileServiceError("Invalid path", 400);
  }

  const fullPath = path.join(DATA_ROOT, normalized);
  const resolved = path.resolve(fullPath);

  // Ensure it's within the storage root
  if (!resolved.startsWith(path.resolve(DATA_ROOT))) {
    throw new FileServiceError("Invalid path", 400);
  }

  return resolved;
}

export class FileServiceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

export async function listDirectory(
  relativePath: string,
): Promise<FileEntry[]> {
  const fullPath = resolveAndValidate(relativePath);
  const entries: FileEntry[] = [];

  try {
    for await (const entry of Deno.readDir(fullPath)) {
      const stat = await Deno.stat(path.join(fullPath, entry.name));
      entries.push({
        name: entry.name,
        type: entry.isDirectory ? "directory" : "file",
        size: entry.isDirectory ? 0 : stat.size,
        lastModified: (stat.mtime ?? new Date()).toISOString(),
      });
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new FileServiceError("Not found", 404);
    }
    throw e;
  }

  return entries.sort((a, b) => {
    // Directories first, then by name
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export interface FileStat {
  size: number;
  lastModified: string;
}

export async function statFile(relativePath: string): Promise<FileStat> {
  const fullPath = resolveAndValidate(relativePath);
  const stat = await Deno.stat(fullPath);
  return {
    size: stat.size,
    lastModified: (stat.mtime ?? new Date()).toISOString(),
  };
}

export async function getFileInfo(
  relativePath: string,
): Promise<FileEntry> {
  const fullPath = resolveAndValidate(relativePath);

  try {
    const stat = await Deno.stat(fullPath);
    const name = path.basename(fullPath);
    return {
      name,
      type: stat.isDirectory ? "directory" : "file",
      size: stat.size,
      lastModified: (stat.mtime ?? new Date()).toISOString(),
    };
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new FileServiceError("Not found", 404);
    }
    throw e;
  }
}

export async function readFile(
  relativePath: string,
  offset?: number,
  length?: number,
): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
  const fullPath = resolveAndValidate(relativePath);

  let file: Deno.FsFile;
  try {
    file = await Deno.open(fullPath, { read: true });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new FileServiceError("Not found", 404);
    }
    throw e;
  }

  const stat = await file.stat();
  if (stat.isDirectory) {
    file.close();
    throw new FileServiceError("Is a directory", 400);
  }

  const totalSize = stat.size;

  if (offset !== undefined && offset > 0) {
    await file.seek(offset, Deno.SeekMode.Start);
  }

  const actualLength = length ?? totalSize - (offset ?? 0);

  let bytesRead = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const remaining = actualLength - bytesRead;
      if (remaining <= 0) {
        controller.close();
        file.close();
        return;
      }

      const chunkSize = Math.min(65536, remaining);
      const buf = new Uint8Array(chunkSize);
      const n = await file.read(buf);
      if (n === null || n === 0) {
        controller.close();
        file.close();
        return;
      }

      bytesRead += n;
      controller.enqueue(buf.subarray(0, n));
    },
    cancel() {
      file.close();
    },
  });

  return { stream, size: totalSize };
}

export async function writeFile(
  relativePath: string,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  const fullPath = resolveAndValidate(relativePath);

  // Ensure parent directory exists
  const dir = path.dirname(fullPath);
  await Deno.mkdir(dir, { recursive: true });

  const file = await Deno.open(fullPath, {
    write: true,
    create: true,
    truncate: true,
  });

  try {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writeAll(file, value);
    }
  } finally {
    file.close();
  }

  // API-based broadcast: API 経由の mutation を意図のレイヤで通知する。
  // 旧来は Deno.watchFs ベースだったが、rename を取りこぼす等 OS 依存の
  // 不安定さがあったため、各 API operation で明示発火する設計に切替えた。
  const stat = await Deno.stat(fullPath);
  await broadcastFileEvent("modified", relativePath, {
    type: "file",
    size: stat.size,
    lastModified: (stat.mtime ?? new Date()).toISOString(),
  });
}

async function writeAll(file: Deno.FsFile, data: Uint8Array): Promise<void> {
  let written = 0;
  while (written < data.length) {
    written += await file.write(data.subarray(written));
  }
}

export async function deleteFile(relativePath: string): Promise<void> {
  const fullPath = resolveAndValidate(relativePath);

  try {
    const stat = await Deno.stat(fullPath);
    await Deno.remove(fullPath, { recursive: stat.isDirectory });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new FileServiceError("Not found", 404);
    }
    throw e;
  }

  await broadcastFileEvent("deleted", relativePath);
}

export async function createFolder(relativePath: string): Promise<void> {
  const fullPath = resolveAndValidate(relativePath);

  try {
    await Deno.mkdir(fullPath, { recursive: false });
  } catch (e) {
    if (e instanceof Deno.errors.AlreadyExists) {
      throw new FileServiceError("Already exists", 409);
    }
    if (e instanceof Deno.errors.NotFound) {
      // 親が存在しない (recursive:false の意図)
      throw new FileServiceError("Parent directory not found", 404);
    }
    throw e;
  }

  const stat = await Deno.stat(fullPath);
  await broadcastFileEvent("created", relativePath, {
    type: "directory",
    size: 0,
    lastModified: (stat.mtime ?? new Date()).toISOString(),
  });
}

export async function renameEntry(
  oldRelativePath: string,
  newRelativePath: string,
): Promise<void> {
  const oldFull = resolveAndValidate(oldRelativePath);
  const newFull = resolveAndValidate(newRelativePath);

  if (oldFull === newFull) return;

  try {
    // 上書きしない: 衝突時は 409
    try {
      await Deno.stat(newFull);
      throw new FileServiceError("Destination already exists", 409);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }

    // 親ディレクトリは存在を要求 (recursive:true で勝手に作らない)
    await Deno.rename(oldFull, newFull);
  } catch (e) {
    if (e instanceof FileServiceError) throw e;
    if (e instanceof Deno.errors.NotFound) {
      throw new FileServiceError("Not found", 404);
    }
    throw e;
  }

  // Deno.watchFs ベースの観測は rename を IN_MOVED_FROM/IN_MOVED_TO 2 個に
  // 分解するが、新 path 側 (IN_MOVED_TO) を取りこぼすバージョンがある
  // (実機でそれを踏んだ)。ここで明示的に旧 path の deleted と新 path の
  // created を発火しておけば、別 client は確実に tree を更新できる。
  const newStat = await Deno.stat(newFull);
  await broadcastFileEvent("deleted", oldRelativePath);
  await broadcastFileEvent("created", newRelativePath, {
    type: newStat.isDirectory ? "directory" : "file",
    size: newStat.isDirectory ? 0 : newStat.size,
    lastModified: (newStat.mtime ?? new Date()).toISOString(),
  });
}

export function getDataRoot(): string {
  return DATA_ROOT;
}

/**
 * 起動時に DATA_ROOT を実体化させる。dir が無い状態では /tree が 404、
 * /volume が 500 になり、クライアントの InitializeAsync が落ちる。書き込み
 * 系は recursive mkdir で自動作成するため一貫性が崩れる、これを起動側で
 * 揃える。既に存在していれば no-op (recursive: true)。
 */
export async function ensureDataRoot(): Promise<void> {
  await Deno.mkdir(DATA_ROOT, { recursive: true });
}

export interface VolumeStats {
  totalSize: number;
  freeSize: number;
}

/**
 * DATA_ROOT が乗っている FS の容量を返す (statfs(2) 経由)。
 * 注意: dir 自身ではなく**それを乗せている FS** の stats なので、Docker の
 * bind mount や named volume でも host 側の実 FS 容量が反映される。
 * Deno には組込みの statvfs API が無いので Node 互換 fs.statfs を使う。
 * blocks = 全ブロック数、bavail = 非 root 利用可ブロック数 (= 一般ユーザに
 * とっての "空き")、bsize = ブロックサイズ。
 */
export async function getVolumeStats(): Promise<VolumeStats> {
  const s = await statfs(DATA_ROOT);
  return {
    totalSize: Number(s.bsize) * Number(s.blocks),
    freeSize: Number(s.bsize) * Number(s.bavail),
  };
}

export interface TreeEntry extends FileEntry {
  path: string;
}

export async function getTree(): Promise<TreeEntry[]> {
  const results: TreeEntry[] = [];

  async function walk(relPath: string): Promise<void> {
    const entries = await listDirectory(relPath);
    for (const entry of entries) {
      const entryPath = relPath === "/"
        ? `/${entry.name}`
        : `${relPath}/${entry.name}`;
      results.push({ ...entry, path: entryPath });
      if (entry.type === "directory") {
        await walk(entryPath);
      }
    }
  }

  await walk("/");
  return results;
}
