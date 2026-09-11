import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { configureRustTerminalUnicode } from "../src/renderer/src/terminal-unicode";

const binary = resolve("../../target/debug/examples", process.platform === "win32" ? "terminal_snapshot.exe" : "terminal_snapshot");
const write = (terminal: Terminal, bytes: Uint8Array) => new Promise<void>(done => terminal.write(bytes, done));

function state(terminal: Terminal) {
  const buffer = terminal.buffer.active;
  return {
    type: buffer.type, x: buffer.cursorX, y: buffer.cursorY, modes: terminal.modes,
    lines: Array.from({ length: terminal.rows }, (_, row) => Array.from({ length: terminal.cols }, (_, col) => {
      const cell = buffer.getLine(buffer.baseY + row)?.getCell(col);
      return [cell?.getChars() || (cell?.getWidth() === 0 ? "" : " "), cell?.getWidth(), cell?.getFgColor(), cell?.getBgColor(), cell?.isBold(), cell?.isItalic(), cell?.isUnderline()];
    })),
  };
}

describe("Rust terminal checkpoints restored into the existing xterm", () => {
  for (const [name, before, after] of [
    ["Unicode and color", "\x1b[31m中文 🦀\x1b[0m", " next"],
    ["alternate screen and saved primary cursor", "primary\x1b[?1049h\x1b[2;5Halternate", "\x1b[?1049l next"],
    ["scroll margins and origin", "first\x1b[2;6r\x1b[?6h\x1b[3;2Hmiddle", "\r\nnext\r\nlast"],
    ["saved cursor and attributes", "\x1b[32mfirst\x1b7\x1b[5;4H\x1b[31msecond", "\x1b8restored"],
    ["input modes", "\x1b[?1034h\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b=\x1b[?1hinput", "\x1b[?1003l"],
    ["partial CSI", "hello\x1b[31;", "1mred"],
    ["partial OSC", "hello\x1b]0;part", "ial\x07next"],
    ["OSC interrupted by another escape", "hello\x1b]0;ignored\x1b[?2004h", "next"],
    ["DCS with a bell before its terminator", "hello\x1bPignored\x07", "tail\x1b\\next"],
    ["line wrapping", "abcdefghijklmnopqrstuvwx", "1234567890\r\nnext"],
  ]) {
    it(name!, async () => {
      const size = { cols: 24, rows: 8 };
      const bytes = Buffer.from(before!);
      const result = spawnSync(binary, [], { input: JSON.stringify({ size, chunks: Array.from(bytes, byte => Buffer.from([byte]).toString("base64")) }), encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const snapshot = JSON.parse(result.stdout);
      const original = new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true });
      const restored = new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true });
      configureRustTerminalUnicode(original); configureRustTerminalUnicode(restored);
      try {
        await write(original, bytes);
        await write(restored, Buffer.from(snapshot.dataB64, "base64"));
        expect(state(restored)).toEqual(state(original));
        await write(original, Buffer.from(after!));
        await write(restored, Buffer.from(after!));
        expect(state(restored)).toEqual(state(original));
      } finally { original.dispose(); restored.dispose(); }
    });
  }

  it("keeps an incomplete UTF-8 scalar until the next output frame", async () => {
    const bytes = Buffer.from("中文🦀"); const prefix = bytes.subarray(0, bytes.length - 2); const tail = bytes.subarray(bytes.length - 2);
    const size = { cols: 24, rows: 8 };
    const result = spawnSync(binary, [], { input: JSON.stringify({ size, chunks: [prefix.toString("base64")] }), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const original = new Terminal({ ...size, allowProposedApi: true }); const restored = new Terminal({ ...size, allowProposedApi: true });
    configureRustTerminalUnicode(original); configureRustTerminalUnicode(restored);
    try {
      await write(original, prefix); await write(restored, Buffer.from(JSON.parse(result.stdout).dataB64, "base64"));
      await write(original, tail); await write(restored, tail);
      expect(state(restored)).toEqual(state(original));
    } finally { original.dispose(); restored.dispose(); }
  });

  it("does not silently checkpoint unsupported combining state", () => {
    const result = spawnSync(binary, [], { input: JSON.stringify({ size: { cols: 24, rows: 8 }, chunks: [Buffer.from("e\u0301").toString("base64")] }), encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cannot be checkpointed");
  });
});
