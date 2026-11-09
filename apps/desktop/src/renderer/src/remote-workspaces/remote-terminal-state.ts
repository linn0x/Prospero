import { PROSPERO_TERMINAL_THEME } from "../../../shared/terminal-typography";

export function remoteInputBase64(data: string): string {
  const bytes = new TextEncoder().encode(data);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

type TerminalFrame = { seq: number; data: string | Uint8Array; bytes: number; dimensions?: { cols: number; rows: number } };
type TerminalSink = { reset(cols: number, rows: number): void; write(data: string | Uint8Array, done: () => void): void };

export class RemoteTerminalBuffer {
  private sequence = -1;
  private awaitingSnapshot = true;
  private queue: TerminalFrame[] = [];
  private bytes = 0;
  private writing = false;
  private disposed = false;

  constructor(private sink: TerminalSink, private resync: () => void, private maxBytes = 2 * 1024 * 1024) {}

  snapshot(seq: number, ansi: string, cols: number, rows: number): void {
    if (this.disposed || !Number.isSafeInteger(seq) || seq < 0) return;
    if (![cols, rows].every(value => Number.isInteger(value) && value > 0 && value <= 1000)) throw new Error("Invalid remote terminal dimensions");
    if (ansi.length > 8 * 1024 * 1024) throw new Error("Remote terminal snapshot exceeds the display limit");
    this.queue = [];
    this.bytes = 0;
    this.sequence = seq;
    this.awaitingSnapshot = false;
    this.enqueue({ seq, data: ansi, bytes: ansi.length * 2, dimensions: { cols, rows } });
  }

  output(seq: number, dataB64: string): void {
    if (this.disposed || this.awaitingSnapshot || !Number.isSafeInteger(seq) || seq <= this.sequence) return;
    if (seq !== this.sequence + 1 || this.bytes + dataB64.length * .75 > this.maxBytes) {
      this.awaitingSnapshot = true;
      this.queue = [];
      this.bytes = 0;
      this.resync();
      return;
    }
    const binary = atob(dataB64);
    const data = Uint8Array.from(binary, character => character.charCodeAt(0));
    this.sequence = seq;
    this.enqueue({ seq, data, bytes: data.length });
  }

  private enqueue(frame: TerminalFrame): void {
    this.queue.push(frame);
    this.bytes += frame.bytes;
    this.flush();
  }

  private flush(): void {
    if (this.writing || this.disposed) return;
    const frame = this.queue.shift();
    if (!frame) return;
    this.bytes -= frame.bytes;
    this.writing = true;
    if (frame.dimensions) this.sink.reset(frame.dimensions.cols, frame.dimensions.rows);
    this.sink.write(frame.data, () => {
      this.writing = false;
      this.flush();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.bytes = 0;
  }
}

export function remoteTerminalTheme(style: Pick<CSSStyleDeclaration, "getPropertyValue">) {
  const color = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    background: color("--surface-sunken", PROSPERO_TERMINAL_THEME.background),
    foreground: color("--foreground", PROSPERO_TERMINAL_THEME.foreground),
    cursor: color("--foreground", PROSPERO_TERMINAL_THEME.cursor),
    cursorAccent: color("--surface-sunken", PROSPERO_TERMINAL_THEME.cursorAccent),
    selectionBackground: color("--selection", PROSPERO_TERMINAL_THEME.selectionBackground),
    black: color("--surface-0", PROSPERO_TERMINAL_THEME.black),
    brightBlack: color("--faint", PROSPERO_TERMINAL_THEME.brightBlack),
    red: color("--danger", PROSPERO_TERMINAL_THEME.red),
    brightRed: color("--danger", PROSPERO_TERMINAL_THEME.brightRed),
    green: color("--success", PROSPERO_TERMINAL_THEME.green),
    brightGreen: color("--success", PROSPERO_TERMINAL_THEME.brightGreen),
    yellow: color("--warning", PROSPERO_TERMINAL_THEME.yellow),
    brightYellow: color("--warning", PROSPERO_TERMINAL_THEME.brightYellow),
    blue: color("--primary", PROSPERO_TERMINAL_THEME.blue),
    brightBlue: color("--primary", PROSPERO_TERMINAL_THEME.brightBlue),
    magenta: color("--review", PROSPERO_TERMINAL_THEME.magenta),
    brightMagenta: color("--review", PROSPERO_TERMINAL_THEME.brightMagenta),
    cyan: color("--cyan", PROSPERO_TERMINAL_THEME.cyan),
    brightCyan: color("--cyan", PROSPERO_TERMINAL_THEME.brightCyan),
    white: color("--foreground-muted", PROSPERO_TERMINAL_THEME.white),
    brightWhite: color("--foreground", PROSPERO_TERMINAL_THEME.brightWhite),
  };
}
