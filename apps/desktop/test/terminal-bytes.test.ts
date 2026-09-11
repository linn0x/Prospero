import { expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { terminalBytes } from "../src/renderer/src/terminal-bytes";

it("preserves Unicode and ANSI sequences split across terminal frames", async () => {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  try {
    const bytes = new TextEncoder().encode("\x1b[31m中文 🦀\x1b[0m");
    for (const byte of bytes) {
      await new Promise<void>(done => terminal.write(terminalBytes(btoa(String.fromCharCode(byte))), done));
    }
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("中文 🦀");
    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(1);
  } finally { terminal.dispose(); }
});
