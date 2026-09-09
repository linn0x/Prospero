import { describe, expect, it } from "vitest";
import { terminalFontFamilyWithFallbacks } from "../src/shared/terminal-typography";

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
