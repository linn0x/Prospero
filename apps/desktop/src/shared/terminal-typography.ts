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
  const cjkFamilies = new Set(CJK_FONT_FAMILIES.map((family) => family.toLowerCase()));
  const chosen = families.filter((family) => !GENERIC_FONT_FAMILIES.has(family.toLowerCase()) && !cjkFamilies.has(name(family)));
  const generic = families.filter((family) => GENERIC_FONT_FAMILIES.has(family.toLowerCase()));
  if (!chosen.length) chosen.push("Cascadia Mono", "Consolas", "SFMono-Regular", "Menlo");
  return [...chosen, ...(generic.length ? generic : ["monospace"]), ...CJK_FONT_FAMILIES.map((family) => `"${family}"`)].join(", ");
}
