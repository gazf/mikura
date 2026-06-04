/**
 * `multipart/byteranges` (RFC 7233 §A) を request body として受け取るための
 * streaming parser。HTTP の応答 (206 Partial Content) で複数 range を返す媒体
 * 型を、こちらでは「単一 PATCH に複数 range の書込みを束ねる」用途で request
 * body として再利用している (ADR は別途記載)。
 *
 * 設計:
 *   - body 全体を RAM に展開しない。各 part の header 行はバッファに溜めるが、
 *     part body は readExact で逐次 sink 呼出に渡す。part body のサイズが GB
 *     級でも常駐メモリは header + 1 chunk 分しか使わない。
 *   - 終端判定は Content-Range の長さで行うので、body 内に boundary 風の
 *     バイト列があっても誤検出しない (汎用 multipart parser より単純で速い)。
 *   - boundary は Content-Type の `boundary=` パラメータから抽出して渡す。
 *
 * 入力フォーマット (RFC 7233 §A):
 *
 *     \r\n--BOUNDARY\r\n
 *     Content-Type: application/octet-stream\r\n
 *     Content-Range: bytes 0-499/*\r\n
 *     \r\n
 *     <500 bytes of payload>
 *     \r\n--BOUNDARY\r\n
 *     Content-Type: application/octet-stream\r\n
 *     Content-Range: bytes 1000-1499/*\r\n
 *     \r\n
 *     <500 bytes of payload>
 *     \r\n--BOUNDARY--\r\n
 *
 * `Content-Type` は省略可、Content-Range は必須。先頭の preamble は RFC で
 * 任意なので skip する。
 */

export class MultipartByterangesError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function extractBoundary(contentType: string): string | null {
  // boundary=value または boundary="value" を抽出。RFC 2046 では boundary に
  // 引用符付き形が許可されているので両対応。値は ASCII 印字可文字のみ想定。
  const m = contentType.match(/boundary=("([^"]+)"|([^\s;]+))/i);
  if (!m) return null;
  return m[2] ?? m[3] ?? null;
}

/**
 * 1 part に対するハンドラ。先頭で onStart(offset, length) が 1 回呼ばれ、
 * その後 onData(chunk) が累計 `length` バイトになるまで複数回呼ばれる。
 * onStart で例外を投げると残り part は読まずに abort する。
 */
export interface PartHandler {
  onStart(offset: number, length: number): Promise<void> | void;
  onData(chunk: Uint8Array): Promise<void> | void;
}

class StreamReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf: Uint8Array = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  /** 直近の CRLF までを 1 行として返す。EOF なら null。 */
  async readLine(): Promise<string | null> {
    while (true) {
      const idx = this.findCRLF();
      if (idx >= 0) {
        const line = this.buf.subarray(0, idx);
        this.buf = this.buf.subarray(idx + 2);
        return new TextDecoder("utf-8", { fatal: false }).decode(line);
      }
      const r = await this.reader.read();
      if (r.done) return null;
      this.append(r.value);
    }
  }

  /**
   * 正確に n バイトを stream から取り出して sink に渡す。
   * 既に buf にある分は最優先で消費する。EOF が来たら例外。
   */
  async readExact(
    n: number,
    sink: (chunk: Uint8Array) => Promise<void> | void,
  ): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      if (this.buf.length === 0) {
        const r = await this.reader.read();
        if (r.done) {
          throw new MultipartByterangesError(
            `Premature EOF: ${remaining} bytes short`,
          );
        }
        this.buf = r.value;
      }
      const take = Math.min(remaining, this.buf.length);
      await sink(this.buf.subarray(0, take));
      this.buf = this.buf.subarray(take);
      remaining -= take;
    }
  }

  private findCRLF(): number {
    // 完全一致 \r\n を探す。本来 multipart は LF のみのケースもあるが、
    // RFC 2046 は CRLF 必須なのでこちらでも厳密にする。
    for (let i = 0; i + 1 < this.buf.length; i++) {
      if (this.buf[i] === 0x0D && this.buf[i + 1] === 0x0A) return i;
    }
    return -1;
  }

  private append(chunk: Uint8Array): void {
    if (this.buf.length === 0) {
      this.buf = chunk;
      return;
    }
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }
}

const CONTENT_RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+|\*)$/;

/**
 * `multipart/byteranges` body を逐次パースし、各 part に対して handler を呼ぶ。
 * 戻り値はパースした part 数。
 */
export async function parseMultipartByteranges(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  handler: PartHandler,
): Promise<{ rangeCount: number }> {
  const reader = new StreamReader(body);
  const delim = `--${boundary}`;
  const tail = `--${boundary}--`;

  // RFC 上 preamble (boundary 前の任意テキスト) は無視。最初の boundary 行まで読み飛ばす。
  // 先頭が boundary そのものなのが普通だが、念のため複数行 skip 対応。
  while (true) {
    const line = await reader.readLine();
    if (line === null) {
      throw new MultipartByterangesError("No boundary found in body");
    }
    if (line === delim) break;
    if (line === tail) return { rangeCount: 0 };
  }

  let rangeCount = 0;
  while (true) {
    // header block: blank line で終端。Content-Range だけ拾う。
    let contentRange: string | null = null;
    while (true) {
      const line = await reader.readLine();
      if (line === null) {
        throw new MultipartByterangesError("Truncated part headers");
      }
      if (line === "") break;
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (name === "content-range") contentRange = value;
    }
    if (!contentRange) {
      throw new MultipartByterangesError("Missing Content-Range in part");
    }

    const m = contentRange.match(CONTENT_RANGE_RE);
    if (!m) {
      throw new MultipartByterangesError(
        `Invalid Content-Range: ${contentRange}`,
      );
    }
    const start = parseInt(m[1], 10);
    const end = parseInt(m[2], 10);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new MultipartByterangesError(
        `Invalid Content-Range bounds: ${contentRange}`,
      );
    }
    const length = end - start + 1;

    await handler.onStart(start, length);
    await reader.readExact(length, async (chunk) => {
      await handler.onData(chunk);
    });
    rangeCount++;

    // body の直後は `\r\n--BOUNDARY...`。readLine で先頭 CRLF を 1 行 (空) として
    // 食い、続く 1 行で boundary or terminator を判定する。
    const sep = await reader.readLine();
    if (sep !== "") {
      throw new MultipartByterangesError(
        `Expected CRLF after part body, got: ${sep}`,
      );
    }
    const next = await reader.readLine();
    if (next === null) throw new MultipartByterangesError("Truncated after part");
    if (next === tail) return { rangeCount };
    if (next !== delim) {
      throw new MultipartByterangesError(`Bad boundary line: ${next}`);
    }
  }
}
