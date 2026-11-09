const CJK_FONT_FAMILIES = ["PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC"];
const GENERIC_FONT_FAMILIES = new Set(["monospace", "sans-serif", "serif", "system-ui", "ui-monospace"]);

export const DEFAULT_TERMINAL_FONT_FAMILY = "Cascadia Mono, Consolas, SFMono-Regular, Menlo, monospace";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const TERMINAL_LINE_HEIGHT = 1.25;

/**
 * Balanced Dark Carbon 16-color ANSI palette tuned for TUI coding agents
 * (Codex, Claude Code, Antigravity, Pi, lazygit, diff viewers).
 *
 * Key design choices:
 * - `black` (#20232b) is slightly elevated above `background` (#16171a) so TUI
 *   pills, prompt boxes, and status bars using ANSI 0 remain visible.
 * - `brightBlack` (#7d8597) provides ~4.4:1 contrast against #16171a so dim text,
 *   box-drawing borders (`╭─╮`), tree branches (`└`), and shaded ASCII art
 *   render crisply without washing out primary foreground text (#e6e9f0).
 * - Primary and bright ANSI hues (1-7, 9-15) have balanced perceptual lightness
 *   in OKLab so syntax highlighting and unified diffs never clash or glare.
 */
export const PROSPERO_TERMINAL_THEME = {
  background: "#16171a",
  foreground: "#e6e9f0",
  cursor: "#e6e9f0",
  cursorAccent: "#16171a",
  selectionBackground: "#2b3b5c",
  selectionForeground: "#f2f5fa",
  selectionInactiveBackground: "#222c42",
  scrollbarSliderBackground: "#8ba9ff33",
  scrollbarSliderHoverBackground: "#8ba9ff55",
  scrollbarSliderActiveBackground: "#8ba9ff77",
  black: "#20232b",
  red: "#f06b74",
  green: "#62c897",
  yellow: "#e8b259",
  blue: "#6ea4f8",
  magenta: "#b98ef5",
  cyan: "#59c4dc",
  white: "#c9d0de",
  brightBlack: "#7d8597",
  brightRed: "#ff878f",
  brightGreen: "#7ee0b0",
  brightYellow: "#f5c776",
  brightBlue: "#8cb8ff",
  brightMagenta: "#ceaaff",
  brightCyan: "#7ad9ee",
  brightWhite: "#f2f5fa",
} as const;

/** Keep chosen fonts first, with explicit CJK fallbacks before generic families. */
export function terminalFontFamilyWithFallbacks(fontFamily: string): string {
  // Quoted family names can contain commas.
  const families = (fontFamily.match(/(?:"[^"]*"|'[^']*'|[^,])+/g) ?? [])
    .map((family) => family.trim()).filter(Boolean);
  const name = (family: string) => family.replace(/^(["'])(.*)\1$/, "$2").toLowerCase();
  const cjkFamilies = new Set(CJK_FONT_FAMILIES.map((family) => family.toLowerCase()));
  const chosen = families.filter((family) => !GENERIC_FONT_FAMILIES.has(family.toLowerCase()) && !cjkFamilies.has(name(family)));
  const generic = families.filter((family) => GENERIC_FONT_FAMILIES.has(family.toLowerCase()));
  if (!chosen.length) chosen.push("Cascadia Mono", "Consolas", "SFMono-Regular", "Menlo");
  return [...chosen, ...(generic.length ? generic : ["monospace"]), ...CJK_FONT_FAMILIES.map((family) => `"${family}"`)].join(", ");
}
