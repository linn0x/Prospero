import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { configureRustTerminalUnicode } from "../src/renderer/src/terminal-unicode";

const write = (terminal: Terminal, data: Uint8Array | string) => new Promise<void>(done => terminal.write(data, done));
const state = (terminal: Terminal) => ({
  x: terminal.buffer.active.cursorX,
  text: terminal.buffer.active.getLine(0)?.translateToString(true),
  cells: Array.from({ length: 24 }, (_, x) => {
    const cell = terminal.buffer.active.getLine(0)?.getCell(x);
    return [cell?.getChars(), cell?.getWidth()];
  }),
});

it("preserves zero-payload continuation bytes at every UTF-8 split", async () => {
  const bytes = Buffer.from("e\u0301 👩‍💻 中文 \u2000 \u{10000}");
  const reference = new Terminal({ cols: 24, rows: 8, allowProposedApi: true });
  configureRustTerminalUnicode(reference);
  try {
    await write(reference, bytes);
    for (let split = 0; split <= bytes.length; split++) {
      const terminal = new Terminal({ cols: 24, rows: 8, allowProposedApi: true });
      configureRustTerminalUnicode(terminal);
      try {
        await write(terminal, bytes.subarray(0, split));
        await write(terminal, bytes.subarray(split));
        expect(state(terminal)).toEqual(state(reference));
      } finally { terminal.dispose(); }
    }
    const bytewise = new Terminal({ cols: 24, rows: 8, allowProposedApi: true });
    configureRustTerminalUnicode(bytewise);
    try {
      for (const byte of bytes) await write(bytewise, Uint8Array.of(byte));
      expect(state(bytewise)).toEqual(state(reference));
    } finally { bytewise.dispose(); }
  } finally { reference.dispose(); }
});

it("does not carry an incomplete scalar across a terminal reset", async () => {
  const terminal = new Terminal({ cols: 24, rows: 8, allowProposedApi: true });
  configureRustTerminalUnicode(terminal);
  try {
    await write(terminal, Uint8Array.of(0xe2, 0x80));
    terminal.reset();
    await write(terminal, "fresh");
    expect(state(terminal).text).toBe("fresh");
  } finally { terminal.dispose(); }
});
