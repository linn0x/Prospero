import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { configureRustTerminalUnicode } from "../src/renderer/src/terminal-unicode";
import { terminalFontFamilyWithFallbacks, uiFontFamilyWithFallbacks } from "../src/shared/terminal-typography";

describe("terminal font fallbacks", () => {
  it("adds Chinese fallbacks after the generic font", () => {
    const family = terminalFontFamilyWithFallbacks("Cascadia Mono, Consolas, monospace");
    expect(family.startsWith("Cascadia Mono, Consolas, ")).toBe(true);
    expect(family).toContain('"Microsoft YaHei UI"');
    expect(family).toContain(", monospace, \"PingFang SC\"");
  });

  it("preserves custom fonts and moves Chinese fallbacks after the generic font", () => {
    const family = terminalFontFamilyWithFallbacks('"Custom, Mono", "Microsoft YaHei", monospace');
    expect(family.startsWith('"Custom, Mono", monospace, "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei"')).toBe(true);
    expect(family.match(/"Microsoft YaHei"/g)).toHaveLength(1);
  });

  it("is stable when a font stack already contains the fallbacks", () => {
    const family = terminalFontFamilyWithFallbacks("Consolas, 'microsoft yahei ui', monospace");
    expect(terminalFontFamilyWithFallbacks(family)).toBe(family);
    expect(family).toContain(', monospace, "PingFang SC", "Microsoft YaHei UI"');
  });

  it("retains monospaced Latin glyphs with a generic-only preference", () => {
    const family = terminalFontFamilyWithFallbacks("ui-monospace, monospace");
    expect(family.startsWith("Cascadia Mono, Consolas, ")).toBe(true);
    expect(family).toContain(", ui-monospace, monospace, \"PingFang SC\"");
  });
});

describe("ui font fallbacks", () => {
  it("returns undefined when unset or blank so system defaults remain untouched", () => {
    expect(uiFontFamilyWithFallbacks(undefined, "darwin")).toBeUndefined();
    expect(uiFontFamilyWithFallbacks("", "darwin")).toBeUndefined();
    expect(uiFontFamilyWithFallbacks("   ", "linux")).toBeUndefined();
    expect(uiFontFamilyWithFallbacks("inherit", "darwin")).toBeUndefined();
    expect(uiFontFamilyWithFallbacks(";{}", "darwin")).toBeUndefined();
  });

  it("prepends custom UI fonts before platform and CJK fallbacks", () => {
    expect(uiFontFamilyWithFallbacks("Allo Variable, Allo", "darwin")).toBe(
      '"Allo Variable", "Allo", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif',
    );
    expect(uiFontFamilyWithFallbacks("Allo Variable, Allo", "win32")).toBe(
      '"Allo Variable", "Allo", "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", system-ui, sans-serif',
    );
  });

  it("deduplicates families, handles quoted names with commas, and strips unsafe characters", () => {
    const family = uiFontFamilyWithFallbacks('"Custom, Sans", PingFang SC, sans-serif, Inter;color:red', "darwin");
    expect(family).toBe(
      '"Custom, Sans", "PingFang SC", "Intercolorred", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Noto Sans CJK SC", sans-serif, system-ui',
    );
    expect(uiFontFamilyWithFallbacks(family, "darwin")).toBe(family);
  });
});

it("aligns CJK and emoji cells with the Rust terminal width provider", async () => {
  const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
  try {
    configureRustTerminalUnicode(terminal);
    await new Promise<void>(done => terminal.write("A中文🦀B", done));
    const line = terminal.buffer.active.getLine(0)!;
    expect(line.translateToString(true)).toBe("A中文🦀B");
    expect(line.getCell(1)?.getWidth()).toBe(2);
    expect(line.getCell(3)?.getWidth()).toBe(2);
    expect(line.getCell(5)?.getWidth()).toBe(2);
    expect(line.getCell(7)?.getChars()).toBe("B");
    expect(terminal.buffer.active.cursorX).toBe(8);
  } finally { terminal.dispose(); }
});
