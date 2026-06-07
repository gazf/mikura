/**
 * Deno.bench micro: server 側の per-call hot path 単体計測。
 *
 *   - parseMultipartRanges: write cache 経路の支配的コスト。1 / 32 / 256 range
 *     の 3 段で per-range overhead を分離する。
 *   - sha256 (auth.service): validateToken の cache miss / hashToken 経路で叩かれる
 *     CPU cost。
 *
 * 実行:
 *   deno bench --allow-env bench/multipart-parse.bench.ts
 */

import { parseMultipartRanges } from "../src/util/multipartRanges.ts";
import { hashToken } from "../src/services/auth.service.ts";

const BOUNDARY = "----mikuraBench";

function buildMultipartBody(
  rangeCount: number,
  rangeBytes: number,
): Uint8Array {
  // 与えられた range 数 / 各 range サイズで multipart/mixed body を組み立てて
  // Uint8Array で返す。実コード (HttpServerApi の MultipartRangesContent) と
  // 同じ wire 形式に揃える。
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (let i = 0; i < rangeCount; i++) {
    const start = i * rangeBytes;
    const end = start + rangeBytes - 1;
    const head = enc.encode(
      (i === 0 ? "" : "\r\n") +
        `--${BOUNDARY}\r\n` +
        "Content-Type: application/octet-stream\r\n" +
        `Content-Range: bytes ${start}-${end}/*\r\n\r\n`,
    );
    parts.push(head);
    const body = new Uint8Array(rangeBytes);
    // 中身は何でもよいが、parser の "boundary 風 byte 列を本文に含まない" 保証
    // のため、ASCII 印字可文字で埋めておく。
    body.fill(0x41);
    parts.push(body);
  }
  parts.push(enc.encode(`\r\n--${BOUNDARY}--\r\n`));

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const noopHandler = {
  onStart(_o: number, _l: number) {},
  onData(_c: Uint8Array) {},
};

const cases = [
  { name: "1 range × 4KB", count: 1, size: 4096 },
  { name: "32 ranges × 4KB", count: 32, size: 4096 },
  { name: "256 ranges × 4KB", count: 256, size: 4096 },
  { name: "1 range × 1MB", count: 1, size: 1024 * 1024 },
];

for (const c of cases) {
  const body = buildMultipartBody(c.count, c.size);
  Deno.bench({
    name: `parseMultipartRanges ${c.name}`,
    group: "parse",
    async fn() {
      // 1 iter ごとに ReadableStream を作り直さないと 2 回目以降に read できない。
      // 作成コストは µs オーダで bench 対象 (parse) より十分小さい。
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(body);
          ctrl.close();
        },
      });
      await parseMultipartRanges(stream, BOUNDARY, noopHandler);
    },
  });
}

// sha256: validateToken の hot path。GUID 同等の 36-char 入力で測る。
//
// (A) baseline = 旧 WebCrypto 実装相当 (crypto.subtle.digest async + 手書き hex loop)
// (B) 採用版 = @std/crypto digestSync (Wasm backed) + @std/encoding/hex
// node:crypto createHash も初期計測で 80x 出たが Node 互換層依存を避けて却下。

import { crypto as stdCrypto } from "@std/crypto";
import { encodeHex } from "@std/encoding/hex";

const sampleToken = "00112233-4455-6677-8899-aabbccddeeff";
const _encShared = new TextEncoder();

// (A) は旧実装相当を bench 内で再現 (auth.service.ts 側は既に std/crypto に
// 切り替わったため、baseline は import せずインライン定義する)。
const _HEX = "0123456789abcdef";
async function legacySha256(input: string): Promise<string> {
  const data = _encShared.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += _HEX[b >> 4] + _HEX[b & 0xF];
  }
  return out;
}

Deno.bench({
  name: "(A) baseline: crypto.subtle.digest + hex loop",
  group: "sha256",
  baseline: true,
  async fn() {
    await legacySha256(sampleToken);
  },
});

Deno.bench({
  name: "(B) std/crypto digestSync + encodeHex",
  group: "sha256",
  fn() {
    const buf = _encShared.encode(sampleToken);
    const hash = stdCrypto.subtle.digestSync("SHA-256", buf);
    encodeHex(new Uint8Array(hash));
  },
});

Deno.bench({
  name: "(C) hashToken (= 採用版 auth.service.ts 経路)",
  group: "sha256",
  async fn() {
    await hashToken(sampleToken);
  },
});
