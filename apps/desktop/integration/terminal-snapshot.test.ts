import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { configureRustTerminalUnicode } from "../src/renderer/src/terminal-unicode";

const binary = resolve("../../target/debug/examples", process.platform === "win32" ? "terminal_snapshot.exe" : "terminal_snapshot");
const write = (terminal: Terminal, bytes: Uint8Array) => new Promise<void>(done => terminal.write(bytes, done));

function state(terminal: Terminal) {
  const links = (terminal as unknown as { _core: { _oscLinkService: { getLinkData(id: number): { uri: string; id?: string } | undefined } } })._core._oscLinkService;
  const buffer = terminal.buffer.active;
  return {
    type: buffer.type, x: buffer.cursorX, y: buffer.cursorY, modes: terminal.modes,
    lines: Array.from({ length: terminal.rows }, (_, row) => Array.from({ length: terminal.cols }, (_, col) => {
      const cell = buffer.getLine(buffer.baseY + row)?.getCell(col);
      return [cell?.getChars() || (cell?.getWidth() === 0 ? "" : " "), cell?.getWidth(), cell?.getFgColor(), cell?.getBgColor(), cell?.isBold(), cell?.isItalic(), cell?.isUnderline(), links.getLinkData((cell as unknown as { extended?: { urlId: number } })?.extended?.urlId ?? 0)];
    })),
  };
}

describe("Rust terminal checkpoints restored into the existing xterm", () => {
  for (const [name, before, after] of [
    ["Claude color-scheme notification mode", "\x1b[?2031h\x1b]10;?\x07\x1b]11;?\x1b\\\x1b[?2004h中文 shell", "\x1b[?2031l\r\nnext"],
    ["combining characters and continuation", "e\u0301", "\u0308 next"],
    ["combining across checkpoint", "e", "\u0301 next"],
    ["emoji ZWJ and variation selectors", "👩‍💻 ❤️ ✈️", "\u0301 next"],
    ["combining at wrap boundary", "abcdefghijklmnopqrstuvwe\u0301", "\u0308 next"],
    ["no-wrap final column retains its own color", "\x1b[?7labcdefghijklmnopqrstuvw\x1b[31mx", "\u0308Z"],
    ["no-wrap combining stays on the final cell", "\x1b[?7labcdefghijklmnopqrstuvwx\u0301", "\u0308Z"],
    ["no-wrap wide combining at the final cell", "\x1b[?7labcdefghijklmnopqrstuv中\u0301", "\u0308Z"],
    ["no-wrap final column is overwritten", "\x1b[?7labcdefghijklmnopqrstuvwxY", "\u0301Z"],
    ["insert mode shifts by the character width", "1234567890\x1b[1G\x1b[4h中", "\u0301X"],
    ["insert mode shifts combined wide cells", "1234567890\x1b[1G\x1b[4h👩‍💻", "\u0301X"],
    ["wide insert wraps into populated row", "abcdefghijklmnopqrstuvwx\r\n1234567890\x1b[1;24H\x1b[4h中", "\u0301X"],
    ["wide wrapping clears the old last cell", "abcdefghijklmnopqrstuvwx\x1b[1;24H中", " next"],
    ["insert mode and combining", "1234567890\x1b[1G\x1b[4he\u0301", "\u0308X"],
    ["hyperlinks retain URI and active link", "\x1b]8;id=docs;https://example.com/指南\x1b\\e\u0301 👩‍💻", " more\x1b]8;;\x07 end"],
    ["hyperlinks and PUA proxy collisions", "\x1b]8;;https://example.com\x07link\x1b]8;;\x07 \u{f0000}\u{20000}e\u0301", " next"],
    ["combined saved primary and alternate screens", "e\u0301 primary\x1b[?1049h👩‍💻 alt", "\x1b[?1049l next"],
    ["Unicode and color", "\x1b[31m中文 🦀\x1b[0m", " next"],
    ["truecolor dump remains exact", "\x1b[38;2;10;20;30mRGB\x1b[48;2;50;60;70mBG", " next"],
    ["custom tab stops survive a checkpoint", "\x1b[3g\x1b[5G\x1bH\x1b[1G", "\tTAB"],
    ["alternate screen and saved primary cursor", "primary\x1b[?1049h\x1b[2;5Halternate", "\x1b[?1049l next"],
    ["scroll margins and origin", "first\x1b[2;6r\x1b[?6h\x1b[3;2Hmiddle", "\r\nnext\r\nlast"],
    ["saved cursor and attributes", "\x1b[32mfirst\x1b7\x1b[5;4H\x1b[31msecond", "\x1b8restored"],
    ["input modes", "\x1b[?1034h\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b=\x1b[?1hinput", "\x1b[?1003l"],
    ["partial CSI", "hello\x1b[31;", "1mred"],
    ["partial OSC", "hello\x1b]0;part", "ial\x07next"],
    ["OSC interrupted by another escape", "hello\x1b]0;ignored\x1b[?2004h", "next"],
    ["DCS with a bell before its terminator", "hello\x1bPignored\x07", "tail\x1b\\next"],
    ["line wrapping", "abcdefghijklmnopqrstuvwx", "1234567890\r\nnext"],
    ["wide overlap restored after re-enabling wrap", "\x1b[?7l" + "a".repeat(22) + "中X\x1b[?7h\x1b[1;24HY", "Z"],
    ["wide overlap survives repaint erase and insert", "\x1b[?7l" + "a".repeat(22) + "中X\x1b[1;23HY", "\x1b[4hZ\x1b[4l\x1b[2KQ"],
    ["delete before wide overlap preserves column 23", "\x1b[?7l" + "a".repeat(22) + "中X\x1b[1;22H\x1b[P", "Q"],
    ["ignored wide at no-wrap final column", "\x1b[?7l" + "a".repeat(24) + "\x1b[1;24H界", "Z"],
    ["wide repaint retains the overlapping neighbor", "\x1b[?7l" + "a".repeat(22) + "中X\x1b[1;22H界", "Q"],
    ["multiple overlapping pairs retain their columns", "\x1b[?7l" + "a".repeat(22) + "中X\x1b[1;19H\x1b[4P\x1b[1;23H界Y", "\x1b[1;20HZ"],
    ["deleting an overlap head preserves its narrow cell", "\x1b[?7l" + "a".repeat(22) + "中X\x1b[1;20H\x1b[4P", "Q"],
    ["interior overlap retains color and hyperlink", "\x1b[?7l\x1b[31m\x1b]8;;https://example.com\x07" + "a".repeat(22) + "中X\x1b]8;;\x07\x1b[0m\x1b[1;22H\x1b[P", "Q"],
    ["overlap on a wrapped continuation line", "b".repeat(24) + "a\x1b[?7l" + "a".repeat(21) + "中X\x1b[2;22H\x1b[P", "Q"],
  ]) {
    it(name!, async () => {
      const size = { cols: 24, rows: 8 };
      const bytes = Buffer.from(before!);
      const result = spawnSync(binary, [], { input: JSON.stringify({ size, chunks: Array.from(bytes, byte => Buffer.from([byte]).toString("base64")) }), encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      const snapshot = JSON.parse(result.stdout);
      const original = new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true });
      const restored = new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true });
      const continued = new Terminal({ cols: size.cols, rows: size.rows, allowProposedApi: true });
      configureRustTerminalUnicode(original); configureRustTerminalUnicode(restored); configureRustTerminalUnicode(continued);
      try {
        await write(original, bytes);
        await write(restored, Buffer.from(snapshot.dataB64, "base64"));
        expect(state(restored)).toEqual(state(original));
        await write(original, Buffer.from(after!));
        await write(restored, Buffer.from(after!));
        expect(state(restored)).toEqual(state(original));
        const next = spawnSync(binary, [], { input: JSON.stringify({ size, chunks: [bytes.toString("base64"), Buffer.from(after!).toString("base64")] }), encoding: "utf8" });
        expect(next.status, next.stderr).toBe(0);
        await write(continued, Buffer.from(JSON.parse(next.stdout).dataB64, "base64"));
        expect(state(continued)).toEqual(state(original));
      } finally { original.dispose(); restored.dispose(); continued.dispose(); }
    });
  }

  it.each([
    "\x1b[?7l" + "a".repeat(24) + "\x1b[1;24H界",
    "\x1b[?7l" + "a".repeat(22) + "中界",
  ])("preserves combining continuation after an ignored wide glyph (%#)", async before => {
    const size = { cols: 24, rows: 8 };
    const result = spawnSync(binary, [], { input: JSON.stringify({ size, chunks: [Buffer.from(before).toString("base64")] }), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const original = new Terminal({ ...size, allowProposedApi: true });
    const restored = new Terminal({ ...size, allowProposedApi: true });
    configureRustTerminalUnicode(original); configureRustTerminalUnicode(restored);
    try {
      await write(original, Buffer.from(before));
      await write(restored, Buffer.from(JSON.parse(result.stdout).dataB64, "base64"));
      expect(state(restored)).toEqual(state(original));
      await write(original, Buffer.from("\u0301Z")); await write(restored, Buffer.from("\u0301Z"));
      expect(state(restored)).toEqual(state(original));
    } finally { original.dispose(); restored.dispose(); }
  });

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

  it.each([
    "prefix \x1b]8;;https://example.com\x07e\u0301 👩‍💻 ❤️ tail\x1b]8;;\x07",
    "\x1b[?7l" + "a".repeat(22) + "中X\x1b[1;22H\x1b[P",
    "b".repeat(24) + "a\x1b[?7l" + "a".repeat(21) + "中X\x1b[2;22H\x1b[P",
  ])("keeps combined cells, links and overlaps through resize after restoring (%#)", async before => {
    const size = { cols: 24, rows: 8 };
    const result = spawnSync(binary, [], { input: JSON.stringify({ size, chunks: [Buffer.from(before).toString("base64")] }), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const original = new Terminal({ ...size, allowProposedApi: true });
    const restored = new Terminal({ ...size, allowProposedApi: true });
    configureRustTerminalUnicode(original); configureRustTerminalUnicode(restored);
    try {
      await write(original, Buffer.from(before));
      await write(restored, Buffer.from(JSON.parse(result.stdout).dataB64, "base64"));
      original.resize(16, 8); restored.resize(16, 8);
      await write(original, Buffer.from(" next")); await write(restored, Buffer.from(" next"));
      expect(state(restored)).toEqual(state(original));
    } finally { original.dispose(); restored.dispose(); }
  });
});
