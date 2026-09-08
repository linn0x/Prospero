const CJK_FONT_FAMILIES = ["PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC"];
const GENERIC_FONT_FAMILIES = new Set(["monospace", "sans-serif", "serif", "system-ui", "ui-monospace"]);

export const DEFAULT_TERMINAL_FONT_FAMILY = "Cascadia Mono, Consolas, SFMono-Regular, Menlo, monospace";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const TERMINAL_LINE_HEIGHT = 1.25;

/** Keep chosen fonts first, with explicit CJK fallbacks before generic families. */
export function terminalFontFamilyWithFallbacks(fontFamily: string): string {
  // Quoted family names can contain commas.
  const families = (fontFamily.match(/(?:"[^"]*"|'[^']*'|[^,])+/g) ?? [])
    .map((family) => family.trim()).filter(Boolean);
  const name = (family: string) => family.replace(/^(["'])(.*)\1$/, "$2").toLowerCase();
  const chosen = families.filter((family) => !GENERIC_FONT_FAMILIES.has(family.toLowerCase()));
  const generic = families.filter((family) => GENERIC_FONT_FAMILIES.has(family.toLowerCase()));
  // CJK fonts also contain Latin glyphs. Keep terminal columns monospaced even
  // when a saved preference only names a generic family.
  if (!chosen.length) chosen.push("Cascadia Mono", "Consolas", "SFMono-Regular", "Menlo");
  const available = new Set(families.map(name));
  const fallback = CJK_FONT_FAMILIES.filter((family) => !available.has(name(family)))
    .map((family) => `"${family}"`);
  return [...chosen, ...fallback, ...(generic.length ? generic : ["monospace"])].join(", ");
}
