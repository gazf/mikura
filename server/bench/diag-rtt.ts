/**
 * Diagnostic: per-PATCH の 2.2 ms がどこに消えてるかを分解する。
 *
 *   - (1) GET /health × N: pure HTTP RTT + middleware (auth skip 経路)
 *   - (2) GET /tree  × N: pure HTTP RTT + middleware (auth full path) + 1 KV op
 *   - (3) DELETE /locks/foo × N (in: 取れてない state で 403 を返す): auth full +
 *         service 1 op (file ops 無し)
 *   - (4) 1 session × N PATCH (4KB body): 実 PATCH 経路 (open/seek/write/close)
 *   - (5) 1 session × N PATCH (multipart 32 range × 4KB): bench:loopback 同等
 *   - (6) GET /content (full small file): Read 経路 baseline
 *         (permission + open + stat + read + close)
 *   - (7) GET /content Range 0-4095 (固定 offset): per-IRP 4K Read 経路
 *   - (8) GET /content Range 毎回 offset 変動: RND 4K Read 経路 (kernel cache
 *         miss を強制 — page 跨ぎで read-ahead が効きにくくなる)
 *
 * これで「HTTP 経路」「KV 経路」「file ops」の分担を切り出す。
 *
 * 実行:
 *   deno run --allow-all --unstable-kv bench/diag-rtt.ts
 */

import { authHeaders, setupBenchEnv } from "./_setup.ts";

const N = 256;
const BOUNDARY = "----mikuraDiag";

function buildMultipart(count: number, ioSize: number): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * ioSize;
    const end = start + ioSize - 1;
    parts.push(enc.encode(
      (i === 0 ? "" : "\r\n") +
        `--${BOUNDARY}\r\n` +
        "Content-Type: application/octet-stream\r\n" +
        `Content-Range: bytes ${start}-${end}/*\r\n\r\n`,
    ));
    const buf = new Uint8Array(ioSize);
    buf.fill(0x42);
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

async function timeN(
  label: string,
  n: number,
  fn: (i: number) => Promise<void>,
): Promise<void> {
  // warmup
  await fn(0);
  const t = performance.now();
  for (let i = 0; i < n; i++) await fn(i);
  const elapsed = performance.now() - t;
  console.log(
    `${label.padEnd(50)} | ${
      (elapsed / n * 1000).toFixed(1).padStart(7)
    } µs/req | total ${elapsed.toFixed(1)} ms`,
  );
}

async function main() {
  const env = await setupBenchEnv({});
  console.log(`# diag-rtt baseUrl=${env.baseUrl}`);
  console.log(`# N=${N} (serial requests, 1 connection via fetch keep-alive)`);
  console.log();

  const headers = authHeaders(env);

  try {
    // (1) GET /health — middleware short-circuits auth (no Bearer required)
    await timeN("(1) GET /health (no auth)", N, async () => {
      const r = await fetch(`${env.baseUrl}/health`);
      await r.body?.cancel();
    });

    // (2) GET /tree — auth full + 1 KV iter
    await timeN("(2) GET /tree (auth + KV iter)", N, async () => {
      const r = await fetch(`${env.baseUrl}/tree`, { headers });
      await r.body?.cancel();
    });

    // (3) GET /locks/nonexistent — auth + service (no file ops)
    await timeN(
      "(3) GET /locks/diag-nonexistent (auth + KV get)",
      N,
      async () => {
        const r = await fetch(
          `${env.baseUrl}/locks/diag-nonexistent-${performance.now() | 0}`,
          { headers },
        );
        await r.body?.cancel();
      },
    );

    // (4) 1 session, N × single-range PATCH (4KB body, current per-PATCH code path)
    {
      const filePath = `/diag-single-${crypto.randomUUID().slice(0, 8)}.bin`;
      let r = await fetch(`${env.baseUrl}/locks${filePath}`, {
        method: "POST",
        headers,
      });
      await r.body?.cancel();
      r = await fetch(`${env.baseUrl}/uploads`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, baseFromExisting: false }),
      });
      const { uploadId } = await r.json() as { uploadId: string };
      const body4k = new Uint8Array(4096);
      body4k.fill(0x42);

      await timeN(
        "(4) PATCH /uploads/:id 4KB raw (open+seek+write+close)",
        N,
        async (i) => {
          const off = i * 4096;
          const rr = await fetch(`${env.baseUrl}/uploads/${uploadId}`, {
            method: "PATCH",
            headers: {
              ...headers,
              "Content-Range": `bytes ${off}-${off + 4095}/*`,
            },
            body: body4k,
          });
          await rr.body?.cancel();
        },
      );

      // cleanup
      await fetch(`${env.baseUrl}/uploads/${uploadId}`, {
        method: "DELETE",
        headers,
      });
      await fetch(`${env.baseUrl}/locks${filePath}`, {
        method: "DELETE",
        headers,
      });
    }

    // (5) 1 session, N × multipart PATCH (32 range × 4KB) ― bench:loopback の RND 4K 相当
    {
      const filePath = `/diag-multi-${crypto.randomUUID().slice(0, 8)}.bin`;
      let r = await fetch(`${env.baseUrl}/locks${filePath}`, {
        method: "POST",
        headers,
      });
      await r.body?.cancel();
      r = await fetch(`${env.baseUrl}/uploads`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, baseFromExisting: false }),
      });
      const { uploadId } = await r.json() as { uploadId: string };
      const mpBody = buildMultipart(32, 4096);

      await timeN(
        "(5) PATCH multipart 32×4KB (open+32×seek+32×write+close)",
        N,
        async () => {
          const rr = await fetch(`${env.baseUrl}/uploads/${uploadId}`, {
            method: "PATCH",
            headers: {
              ...headers,
              "Content-Type": `multipart/mixed; boundary=${BOUNDARY}`,
            },
            body: mpBody,
          });
          await rr.body?.cancel();
        },
      );

      await fetch(`${env.baseUrl}/uploads/${uploadId}`, {
        method: "DELETE",
        headers,
      });
      await fetch(`${env.baseUrl}/locks${filePath}`, {
        method: "DELETE",
        headers,
      });
    }

    // (6)-(8): Read 経路。fixture file (64MB, 0x42 fill) を 1 個 PUT で作って
    // から GET /content の 3 パターンを叩く。fixture は session 経由ではなく
    // PUT /content で書く (per-file 単発 stream)。
    {
      const filePath = `/diag-read-${crypto.randomUUID().slice(0, 8)}.bin`;
      const fixtureSize = 64 * 1024 * 1024; // 64MB
      {
        const lockR = await fetch(`${env.baseUrl}/locks${filePath}`, {
          method: "POST",
          headers,
        });
        await lockR.body?.cancel();
        const body = new Uint8Array(fixtureSize);
        body.fill(0x42);
        const putR = await fetch(`${env.baseUrl}/content${filePath}`, {
          method: "PUT",
          headers,
          body,
        });
        if (!putR.ok) {
          throw new Error(`PUT /content fixture: ${putR.status}`);
        }
        await putR.body?.cancel();
        await fetch(`${env.baseUrl}/locks${filePath}`, {
          method: "DELETE",
          headers,
        });
      }

      // (6) GET /content フル読み (=Range なし、small but representative)。
      //     1MB だけ取得して stream 経路の overhead を見る。
      await timeN(
        "(6) GET /content Range 0-1MB (open+seek+stream+close)",
        N,
        async () => {
          const rr = await fetch(`${env.baseUrl}/content${filePath}`, {
            headers: { ...headers, Range: "bytes=0-1048575" },
          });
          await rr.body?.cancel();
        },
      );

      // (7) GET /content Range 4KB 固定 offset — kernel page cache が温まる
      //     ので "file ops のみ" + "kernel cache hit" 経路を測れる。
      await timeN(
        "(7) GET /content Range 0-4095 固定 (kernel cache hit)",
        N,
        async () => {
          const rr = await fetch(`${env.baseUrl}/content${filePath}`, {
            headers: { ...headers, Range: "bytes=0-4095" },
          });
          await rr.body?.cancel();
        },
      );

      // (8) GET /content Range 4KB 毎回 offset 変動 — RND 4K 同等。
      //     64MB / 4KB = 16384 page、N 回踏む offset を全部別 page に散らす。
      const offsets = new Uint32Array(N);
      let seed = 0xDEADBEEF >>> 0;
      for (let i = 0; i < N; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const slot = seed % (fixtureSize / 4096);
        offsets[i] = slot * 4096;
      }
      await timeN(
        "(8) GET /content Range 4KB 変動 offset (RND 4K)",
        N,
        async (i) => {
          const off = offsets[i];
          const rr = await fetch(`${env.baseUrl}/content${filePath}`, {
            headers: { ...headers, Range: `bytes=${off}-${off + 4095}` },
          });
          await rr.body?.cancel();
        },
      );

      // cleanup
      await fetch(`${env.baseUrl}/locks${filePath}`, {
        method: "DELETE",
        headers,
      });
      // file 自体は DATA_ROOT が tmpfs なので env.cleanup() で消える。
    }

    console.log();
    console.log("# 解釈:");
    console.log(
      "#   (1) = pure HTTP route 最小 = TCP + hono dispatch + JSON response",
    );
    console.log(
      "#   (2)-(1) = auth middleware (validateToken cache hit + upsertDevice cached)",
    );
    console.log("#   (3)-(2) = lock service (KV get path) - tree iter コスト");
    console.log("#   (4)-(3) = file ops (open + 1 seek + 1 write + close)");
    console.log("#   (5)-(4) = multipart parse + 31 extra seek+write");
    console.log(
      "#   (7)-(3) = Read file ops (open + stat + seek + read 4KB + close) cache hit",
    );
    console.log("#   (8)-(7) = kernel page cache miss + seek 実コスト");
  } finally {
    await env.cleanup();
  }
}

if (import.meta.main) {
  await main();
}
