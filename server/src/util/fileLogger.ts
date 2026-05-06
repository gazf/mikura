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
  const line = `${ts()} ${level} ${text}\n`;
  try {
    logFile.writeSync(encoder.encode(line));
  } catch {
    // ファイル書き込みに失敗しても元の console 動作は維持される。
  }
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
