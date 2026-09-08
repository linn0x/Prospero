/** Convert common model-produced TeX delimiters without touching code spans/fences. */
export function normalizeMathDelimiters(value: string): string {
  return value.split(/(`{3,}[^\n]*\n[\s\S]*?(?:\n`{3,}|$)|~{3,}[^\n]*\n[\s\S]*?(?:\n~{3,}|$)|`+[^`\n]*`+)/g)
    .map((part, index) => index % 2 ? part : part
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, math: string) => `\n\n$$\n${math.trim()}\n$$\n\n`)
      .replace(/\\\(([^\n]*?)\\\)/g, (_, math: string) => `$${math}$`))
    .join("");
}

export function externalMarkdownUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}
