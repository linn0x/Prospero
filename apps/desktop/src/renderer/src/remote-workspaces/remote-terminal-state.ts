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
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: color("--surface-sunken"), foreground: color("--foreground"), cursor: color("--foreground"),
    cursorAccent: color("--surface-sunken"), selectionBackground: color("--selection"),
    black: color("--surface-0"), brightBlack: color("--faint"), red: color("--danger"), brightRed: color("--danger"),
    green: color("--success"), brightGreen: color("--success"), yellow: color("--warning"), brightYellow: color("--warning"),
    blue: color("--primary"), brightBlue: color("--primary"), magenta: color("--review"), brightMagenta: color("--review"),
    cyan: color("--cyan"), brightCyan: color("--cyan"), white: color("--foreground-muted"), brightWhite: color("--foreground"),
  };
}
