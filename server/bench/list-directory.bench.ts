/**
 * `listDirectory` の stat-skip 最適化効果を測る micro-benchmark。
 *
 * シナリオ: 同一 dir の中に N dir + N file を置き、`listDirectory` を呼んで
 * 完了までの時間を計測する。
 *
 * 比較:
 *   - "current (stat skipped for dirs)": file.service.ts の現実装
 *   - "all-stat (baseline)": どの entry も stat を呼ぶ legacy 等価実装
 *
 * 実行:
 *   deno bench --allow-env --allow-read --allow-write \
 *     bench/list-directory.bench.ts
 *
 * 期待効果: dir 半分の混在 dir で syscall 数が ~50% 削減 → wall time も
 * 同程度短縮 (ext4 / tmpfs では stat の dentry cache が効くので絶対値は
 * 小さいが、相対倍率は明確に出る)。
 */

import * as path from "@std/path";
import { listDirectory } from "../src/services/file.service.ts";
import type { FileEntry } from "../src/types.ts";

const DATA_ROOT = Deno.env.get("MIKURA_DATA_ROOT") ??
  path.join(Deno.cwd(), "data");

const DIR_COUNT = 50;
const FILE_COUNT = 50;
const BENCH_DIR = "/__bench_listdir__";
const BENCH_FULL = path.join(DATA_ROOT, BENCH_DIR.slice(1));

async function seedFixture(): Promise<void> {
  await Deno.mkdir(BENCH_FULL, { recursive: true });
  for (let i = 0; i < DIR_COUNT; i++) {
    await Deno.mkdir(path.join(BENCH_FULL, `d${i}`), { recursive: true });
  }
  // 各 file には少しだけ content を入れて stat.size が non-zero になるようにする
  // (legacy 経路が「size=0 だから stat 不要」のショートカットを取らないことの確認用)。
  for (let i = 0; i < FILE_COUNT; i++) {
    await Deno.writeFile(
      path.join(BENCH_FULL, `f${i}.txt`),
      new Uint8Array([0x68, 0x69]),
    );
  }
}

async function cleanupFixture(): Promise<void> {
  await Deno.remove(BENCH_FULL, { recursive: true }).catch(() => {});
}

await cleanupFixture();
await seedFixture();

/**
 * legacy 実装 (全 entry stat) の等価コピー。本物の listDirectory と
 * 同じ出力 shape を返すよう揃える (sort も)。
 */
async function listDirectoryAllStat(relativePath: string): Promise<FileEntry[]> {
  const fullPath = path.join(DATA_ROOT, relativePath.replace(/^\/+/, ""));
  const entries: FileEntry[] = [];
  for await (const entry of Deno.readDir(fullPath)) {
    const stat = await Deno.stat(path.join(fullPath, entry.name));
    entries.push({
      name: entry.name,
      type: entry.isDirectory ? "directory" : "file",
      size: entry.isDirectory ? 0 : stat.size,
      lastModified: (stat.mtime ?? new Date()).toISOString(),
    });
  }
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

Deno.bench({
  name: `listDirectory ${DIR_COUNT} dirs + ${FILE_COUNT} files (all-stat baseline)`,
  group: "list-dir",
  baseline: true,
  async fn() {
    await listDirectoryAllStat(BENCH_DIR);
  },
});

Deno.bench({
  name: `listDirectory ${DIR_COUNT} dirs + ${FILE_COUNT} files (stat-skip for dirs)`,
  group: "list-dir",
  async fn() {
    await listDirectory(BENCH_DIR);
  },
});

globalThis.addEventListener("unload", () => {
  // best-effort cleanup; process exit でも tmpfs/data dir を残さないため。
  try {
    Deno.removeSync(BENCH_FULL, { recursive: true });
  } catch (_) { /* ignore */ }
});
