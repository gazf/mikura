/**
 * Loopback HTTP throughput harness.
 *
 * 同一 host (WSL2) 内で実 server を spawn → tmpfs storage → fetch ループで
 * upload session を叩く。Windows / WinFsp / WSL2 network stack 外しの最終構成
 * (Phase B-loopback = ADR 検討時の baseline)。
 *
 * 実行例:
 *   deno run --allow-all bench/upload-loopback.ts \
 *      --scenario=seq1m --size-mb=128 --concurrency=8 --iters=3
 *
 *   deno run --allow-all bench/upload-loopback.ts --scenario=all
 *
 * 出力: 各シナリオの中央値 MB/s / IOPS / PATCH count / 全 elapsed。
 *
 * 構成: lock 取得 → POST /uploads → PATCH ループ → POST /uploads/:id/finalize
 *       (PATCH は coalescer 模倣で multipart/mixed をまとめて投げる版もある)。
 */

import { authHeaders, setupBenchEnv } from "./_setup.ts";

interface CliArgs {
  scenario: string;
  sizeMb: number;
  concurrency: number;
  ranges: number;
  iters: number;
  warmup: number;
}

function parseArgs(): CliArgs {
  const map = new Map<string, string>();
  for (const a of Deno.args) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq < 0) {
      map.set(a.slice(2), "true");
    } else {
      map.set(a.slice(2, eq), a.slice(eq + 1));
    }
  }
  return {
    scenario: map.get("scenario") ?? "all",
    sizeMb: parseInt(map.get("size-mb") ?? "64", 10),
    concurrency: parseInt(map.get("concurrency") ?? "8", 10),
    ranges: parseInt(map.get("ranges") ?? "16", 10),
    iters: parseInt(map.get("iters") ?? "3", 10),
    warmup: parseInt(map.get("warmup") ?? "1", 10),
  };
}

interface ScenarioPlan {
  name: string;
  ioSize: number;
  concurrency: number;
  // multipart 1 PATCH に詰める range 数。1 なら raw PATCH (Content-Range header)、
  // >1 なら multipart/mixed PATCH。
  rangesPerPatch: number;
  sequential: boolean;
}

const SCENARIOS: Record<string, ScenarioPlan> = {
  seq1m: {
    name: "SEQ 1M Q=8 raw",
    ioSize: 1024 * 1024,
    concurrency: 8,
    rangesPerPatch: 1,
    sequential: true,
  },
  seq128k: {
    name: "SEQ 128K Q=32 multipart",
    ioSize: 128 * 1024,
    concurrency: 4,
    rangesPerPatch: 8,
    sequential: true,
  },
  rnd4k: {
    name: "RND 4K Q=32 multipart",
    ioSize: 4 * 1024,
    concurrency: 4,
    rangesPerPatch: 32,
    sequential: false,
  },
};

const BOUNDARY = "----mikuraLoopback";

function buildMultipart(
  count: number,
  ioSize: number,
  fillByte: number,
  offsets: number[],
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const off = offsets[i];
    const start = off;
    const end = off + ioSize - 1;
    parts.push(enc.encode(
      (i === 0 ? "" : "\r\n") +
        `--${BOUNDARY}\r\n` +
        "Content-Type: application/octet-stream\r\n" +
        `Content-Range: bytes ${start}-${end}/*\r\n\r\n`,
    ));
    const buf = new Uint8Array(ioSize);
    buf.fill(fillByte);
    parts.push(buf);
  }
  parts.push(enc.encode(`\r\n--${BOUNDARY}--\r\n`));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface BenchResult {
  name: string;
  totalBytes: number;
  patches: number;
  elapsedMs: number;
  mbps: number;
  iops: number;
}

async function runScenario(
  env: Awaited<ReturnType<typeof setupBenchEnv>>,
  plan: ScenarioPlan,
  sizeMb: number,
): Promise<BenchResult> {
  const filePath = `/bench-${crypto.randomUUID().slice(0, 8)}.bin`;
  const totalBytes = sizeMb * 1024 * 1024;
  const totalIos = Math.floor(totalBytes / plan.ioSize);
  const patchesNeeded = Math.ceil(totalIos / plan.rangesPerPatch);

  const headers = authHeaders(env);

  // 1) Acquire lock (require for /uploads).
  {
    const r = await fetch(`${env.baseUrl}/locks${filePath}`, {
      method: "POST",
      headers,
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`lock acquire failed: ${r.status} ${body}`);
    }
    await r.body?.cancel();
  }

  // 2) POST /uploads (create session).
  let uploadId: string;
  {
    const r = await fetch(`${env.baseUrl}/uploads`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath, baseFromExisting: false }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`create session: ${r.status} ${body}`);
    }
    const j = await r.json() as { uploadId: string };
    uploadId = j.uploadId;
  }

  // 3) random offset 列の生成 (Sequential なら ascending、RND なら shuffle)。
  //    全体で sizeMb 分の IO を生成し、conccurrency 本の worker に分配。
  const offsetSlots: number[] = [];
  for (let i = 0; i < totalIos; i++) offsetSlots.push(i * plan.ioSize);
  if (!plan.sequential) {
    // Fisher-Yates with fixed-seed PRNG (LCG) for reproducibility.
    let seed = 0xBEEFCAFE >>> 0;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let i = offsetSlots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [offsetSlots[i], offsetSlots[j]] = [offsetSlots[j], offsetSlots[i]];
    }
  }

  // 4) 計測区間: PATCH を concurrency 本で fan-out。
  const t0 = performance.now();
  let patchesSent = 0;
  const lock = { idx: 0 };

  async function worker() {
    while (true) {
      // モノトニックに patch 番号を assign。
      const myIdx = lock.idx++;
      if (myIdx >= patchesNeeded) return;
      const ioStart = myIdx * plan.rangesPerPatch;
      const ioEnd = Math.min(ioStart + plan.rangesPerPatch, totalIos);
      const slice = offsetSlots.slice(ioStart, ioEnd);

      if (plan.rangesPerPatch === 1) {
        // 単 range raw PATCH
        const off = slice[0];
        const buf = new Uint8Array(plan.ioSize);
        buf.fill(0x42);
        const r = await fetch(`${env.baseUrl}/uploads/${uploadId}`, {
          method: "PATCH",
          headers: {
            ...headers,
            "Content-Range": `bytes ${off}-${off + plan.ioSize - 1}/*`,
          },
          body: buf,
        });
        if (!r.ok) {
          const body = await r.text();
          throw new Error(`patch ${myIdx}: ${r.status} ${body}`);
        }
        await r.body?.cancel();
      } else {
        // multipart/mixed PATCH
        const body = buildMultipart(slice.length, plan.ioSize, 0x42, slice);
        const r = await fetch(`${env.baseUrl}/uploads/${uploadId}`, {
          method: "PATCH",
          headers: {
            ...headers,
            "Content-Type": `multipart/mixed; boundary=${BOUNDARY}`,
          },
          body,
        });
        if (!r.ok) {
          const t = await r.text();
          throw new Error(`multipart patch ${myIdx}: ${r.status} ${t}`);
        }
        await r.body?.cancel();
      }
      patchesSent++;
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < plan.concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  const elapsedMs = performance.now() - t0;

  // 5) finalize + abort lock (計測 outside)。
  {
    const r = await fetch(`${env.baseUrl}/uploads/${uploadId}/finalize`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ size: totalBytes }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`finalize: ${r.status} ${body}`);
    }
    await r.body?.cancel();
  }
  {
    const r = await fetch(`${env.baseUrl}/locks${filePath}`, {
      method: "DELETE",
      headers,
    });
    await r.body?.cancel();
  }

  return {
    name: plan.name,
    totalBytes,
    patches: patchesSent,
    elapsedMs,
    mbps: totalBytes / 1_000_000 / (elapsedMs / 1000),
    iops: totalIos / (elapsedMs / 1000),
  };
}

function median<T>(xs: T[], key: (x: T) => number): T {
  const sorted = [...xs].sort((a, b) => key(a) - key(b));
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  const args = parseArgs();
  const scenarioKeys = args.scenario === "all"
    ? Object.keys(SCENARIOS)
    : [args.scenario];
  for (const k of scenarioKeys) {
    if (!(k in SCENARIOS)) {
      console.error(`unknown scenario: ${k}`);
      Deno.exit(2);
    }
  }

  const env = await setupBenchEnv({});
  console.log(
    `# upload-loopback baseUrl=${env.baseUrl} dataRoot=${env.dataRoot}`,
  );
  console.log(
    `# size-mb=${args.sizeMb} warmup=${args.warmup} iters=${args.iters}`,
  );
  console.log();
  console.log(
    "scenario                    |   MB/s |   IOPS | PATCHes | elapsed",
  );
  console.log(
    "---------------------------- -------- -------- --------- ---------",
  );

  try {
    for (const k of scenarioKeys) {
      const plan = SCENARIOS[k];
      for (let w = 0; w < args.warmup; w++) {
        await runScenario(env, plan, Math.max(8, Math.floor(args.sizeMb / 4)));
      }
      const samples: BenchResult[] = [];
      for (let i = 0; i < args.iters; i++) {
        samples.push(await runScenario(env, plan, args.sizeMb));
      }
      const med = median(samples, (r) => r.mbps);
      console.log(
        `${plan.name.padEnd(27)} | ${med.mbps.toFixed(1).padStart(6)} | ${
          med.iops.toFixed(0).padStart(6)
        } | ${med.patches.toString().padStart(7)} | ${
          med.elapsedMs.toFixed(0).padStart(6)
        }ms`,
      );
    }
  } finally {
    await env.cleanup();
  }
}

if (import.meta.main) {
  await main();
}
