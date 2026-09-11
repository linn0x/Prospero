import type { Terminal } from "@xterm/xterm";
import { terminalBytes } from "./terminal-bytes";

export async function writeTerminalEvents(terminal: Pick<Terminal, "write" | "resize">, events: unknown, active: () => boolean): Promise<void> {
  if (!Array.isArray(events) || events.length > 64) throw new Error("Invalid terminal event page");
  for (const event of events) {
    if (!active()) return;
    if (event?.type === "output" && typeof event.dataB64 === "string") {
      await new Promise<void>(done => terminal.write(terminalBytes(event.dataB64), done));
    } else if (event?.type === "resize" && Number.isSafeInteger(event.size?.cols) && Number.isSafeInteger(event.size?.rows) && event.size.cols >= 20 && event.size.cols <= 500 && event.size.rows >= 5 && event.size.rows <= 300) {
      terminal.resize(event.size.cols, event.size.rows);
    } else throw new Error("Invalid terminal event");
  }
}
