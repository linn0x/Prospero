const CJK_FONT_FAMILIES = ["PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC"];
const GENERIC_FONT_FAMILIES = new Set(["monospace", "sans-serif", "serif", "system-ui", "ui-monospace"]);
const UI_GENERIC_FONT_FAMILIES = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "cursive",
  "fantasy",
  "emoji",
  "math",
  "fangsong",
]);
const UI_KEYWORD_FONTS = new Map<string, string>([
  ...Array.from(UI_GENERIC_FONT_FAMILIES, (keyword) => [keyword, keyword] as const),
  ["-apple-system", "-apple-system"],
  ["blinkmacsystemfont", "BlinkMacSystemFont"],
]);
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "default"]);

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

function parseFontFamilies(fontFamily: string): string[] {
  // Quoted family names can contain commas.
  return (fontFamily.match(/(?:"[^"]*"|'[^']*'|[^,])+/g) ?? [])
    .map((family) => family.trim())
    .filter(Boolean);
}

function unquoteFontFamily(family: string): string {
  return family.replace(/^(["'])(.*)\1$/, "$2").trim();
}

/** Keep chosen fonts first, with explicit CJK fallbacks before generic families. */
export function terminalFontFamilyWithFallbacks(fontFamily: string): string {
  const families = parseFontFamilies(fontFamily);
  const cjkFamilies = new Set(CJK_FONT_FAMILIES.map((family) => family.toLowerCase()));
  const chosen = families.filter((family) => !GENERIC_FONT_FAMILIES.has(family.toLowerCase()) && !cjkFamilies.has(unquoteFontFamily(family).toLowerCase()));
  const generic = families.filter((family) => GENERIC_FONT_FAMILIES.has(family.toLowerCase()));
  if (!chosen.length) chosen.push("Cascadia Mono", "Consolas", "SFMono-Regular", "Menlo");
  return [...chosen, ...(generic.length ? generic : ["monospace"]), ...CJK_FONT_FAMILIES.map((family) => `"${family}"`)].join(", ");
}

/** Build a CSS font-family list for custom UI typography while preserving platform CJK fallbacks. */
export function uiFontFamilyWithFallbacks(fontFamily: string | undefined, platform: string): string | undefined {
  if (typeof fontFamily !== "string" || !fontFamily.trim()) return undefined;
  const named: string[] = [];
  const generic: string[] = [];
  const seen = new Set<string>();
  const pushUnique = (target: string[], formatted: string, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    target.push(formatted);
  };
  for (const raw of parseFontFamilies(fontFamily)) {
    const cleaned = unquoteFontFamily(raw).replace(/[;"'\\{}\r\n<>:/\x00-\x1f]/g, "").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (CSS_WIDE_KEYWORDS.has(key)) continue;
    const keyword = UI_KEYWORD_FONTS.get(key);
    if (keyword && UI_GENERIC_FONT_FAMILIES.has(keyword)) pushUnique(generic, keyword, key);
    else if (keyword) pushUnique(named, keyword, key);
    else pushUnique(named, `"${cleaned}"`, key);
  }
  if (!named.length && !generic.length) return undefined;
  const fallbacks = platform === "darwin"
    ? ["-apple-system", "BlinkMacSystemFont", '"SF Pro Text"', '"PingFang SC"', '"Noto Sans CJK SC"']
    : ['"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei UI"', '"Microsoft YaHei"', '"Noto Sans CJK SC"', '"Noto Sans SC"'];
  for (const fallback of fallbacks) pushUnique(named, fallback, unquoteFontFamily(fallback).toLowerCase());
  for (const fallback of ["system-ui", "sans-serif"]) pushUnique(generic, fallback, fallback);
  return [...named, ...generic].join(", ");
}
