/**
 * console.log / warn / error を stdout に加えて mikura-server.log にも tee する。
 * main.ts から最初に initFileLogger() を呼ぶことで全モジュールに反映される。
 *
 * 出力先: server/ 配下の mikura-server.log (CWD は deno task dev で server/ に固定)。
 * 起動毎にローテーションせず追記モード (履歴を残す)。
 */

const LOG_FILE = "mikura-server.log";

let logFile: Deno.FsFile | null = null;
const encoder = new TextEncoder();

// ファイル書き込みを async 直列化する。writeSync で event loop を blocking する
// 旧実装は heartbeat / broadcast burst のたびに ~10-50µs ずつ event loop を
// 止めて並行 PATCH 処理に微小な jitter を載せていた。async 化 + Promise chain
// で順序は維持しつつ書き込み中に他の async タスクを止めない。
//
// 失敗 (disk full 等) は黙って捨てる: 元の console 出力は stdout に残るし、
// fileLogger は tee なので片肺になっても致命ではない。
let writeChain: Promise<void> = Promise.resolve();

async function writeAllAsync(bytes: Uint8Array): Promise<void> {
  if (!logFile) return;
  let written = 0;
  while (written < bytes.length) {
    written += await logFile.write(bytes.subarray(written));
  }
}

function ts(): string {
  const d = new Date();
  // [HH:MM:SS.mmm]
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${
    pad(d.getMilliseconds(), 3)
  }]`;
}

function writeLine(level: string, args: unknown[]): void {
  if (!logFile) return;
  const text = args
    .map((
      a,
    ) => (typeof a === "string" ? a : Deno.inspect(a, { colors: false })))
    .join(" ");
  const bytes = encoder.encode(`${ts()} ${level} ${text}\n`);
  writeChain = writeChain.then(() => writeAllAsync(bytes)).catch(() => {});
}

export function initFileLogger(): void {
  if (logFile) return;
  logFile = Deno.openSync(LOG_FILE, {
    create: true,
    write: true,
    append: true,
  });

  const banner = `\n${ts()} --- mikura-server started ---\n`;
  logFile.writeSync(encoder.encode(banner));

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeLine("LOG ", args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeLine("WARN", args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    writeLine("ERR ", args);
  };
}
