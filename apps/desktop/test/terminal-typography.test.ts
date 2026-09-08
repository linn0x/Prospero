import { describe, expect, it } from "vitest";
import { terminalFontFamilyWithFallbacks } from "../src/shared/terminal-typography";

describe("terminal font fallbacks", () => {
  it("adds Chinese fallbacks before the old default's generic font", () => {
    const family = terminalFontFamilyWithFallbacks("Cascadia Mono, Consolas, monospace");
    expect(family.startsWith("Cascadia Mono, Consolas, ")).toBe(true);
    expect(family).toContain('"Microsoft YaHei UI"');
    expect(family.endsWith(", monospace")).toBe(true);
  });

  it("preserves custom fonts, including quoted commas and an explicit Chinese preference", () => {
    const family = terminalFontFamilyWithFallbacks('"Custom, Mono", "Microsoft YaHei", monospace');
    expect(family.startsWith('"Custom, Mono", "Microsoft YaHei", ')).toBe(true);
    expect(family.match(/"Microsoft YaHei"/g)).toHaveLength(1);
  });

  it("is stable when a font stack already contains the fallbacks", () => {
    const family = terminalFontFamilyWithFallbacks("Consolas, 'microsoft yahei ui', monospace");
    expect(terminalFontFamilyWithFallbacks(family)).toBe(family);
    expect(family).not.toContain('"Microsoft YaHei UI"');
  });

  it("retains monospaced Latin glyphs with a generic-only preference", () => {
    const family = terminalFontFamilyWithFallbacks("ui-monospace, monospace");
    expect(family.startsWith("Cascadia Mono, Consolas, ")).toBe(true);
    expect(family.endsWith("ui-monospace, monospace")).toBe(true);
  });
});
