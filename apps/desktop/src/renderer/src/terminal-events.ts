import type { Terminal } from "@xterm/xterm";
import { terminalBytes } from "./terminal-bytes";

type QueryParser = {
  registerCsiHandler: (id: { final: string; prefix?: string }, handler: (params: (number | number[])[]) => boolean) => { dispose(): void };
  registerOscHandler: (ident: number, handler: (data: string) => boolean) => { dispose(): void };
};

/**
 * Event mode has a daemon side for terminal capability/status replies. xterm
 * must not also answer those queries, otherwise applications see two replies.
 * Legacy PTY mode deliberately does not install these hooks.
 */
export function suppressDaemonTerminalQueries(parser: QueryParser): () => void {
  const disposables = [
    parser.registerCsiHandler({ final: "c" }, params => params.length === 0 || (params.length === 1 && params[0] === 0)), // DA1
    parser.registerCsiHandler({ final: "n" }, params => params.length === 1 && params[0] === 6), // DSR cursor position
    parser.registerOscHandler(10, data => data === "?"),
    parser.registerOscHandler(11, data => data === "?"),
  ];
  return () => disposables.forEach(disposable => disposable.dispose());
}

export async function writeTerminalEvents(terminal: Pick<Terminal, "write" | "resize">, events: unknown, active: () => boolean): Promise<void> {
  if (!Array.isArray(events) || events.length > 64) throw new Error("Invalid terminal event page");
  let index = 0;
  while (index < events.length) {
    const event = events[index];
    if (!active()) return;
    if (event?.type === "output" && typeof event.dataB64 === "string") {
      // Keep resize events as hard write boundaries: a resize changes the
      // screen geometry and must be observed in order by xterm.
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (index < events.length) {
        const output = events[index];
        if (output?.type !== "output" || typeof output.dataB64 !== "string") break;
        const bytes = terminalBytes(output.dataB64);
        chunks.push(bytes); length += bytes.byteLength; index += 1;
      }
      const merged = new Uint8Array(length);
      let offset = 0;
      for (const bytes of chunks) { merged.set(bytes, offset); offset += bytes.byteLength; }
      await new Promise<void>(done => terminal.write(merged, done));
      continue;
    } else if (event?.type === "resize" && Number.isSafeInteger(event.size?.cols) && Number.isSafeInteger(event.size?.rows) && event.size.cols >= 20 && event.size.cols <= 500 && event.size.rows >= 5 && event.size.rows <= 300) {
      terminal.resize(event.size.cols, event.size.rows);
      index += 1;
      continue;
    }
    throw new Error("Invalid terminal event");
  }
}
