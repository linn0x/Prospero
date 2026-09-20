/**
 * Convert terminal/tool output into safe plain text for React text nodes and
 * clipboard operations outside xterm.  Keep the real PTY byte stream untouched;
 * this is only for summaries/detail panes where ANSI and cursor-control bytes
 * otherwise render as mojibake and make copied output look corrupt.
 */
export function terminalPlainText(value: string): string {
  type State = "ground" | "escape" | "csi" | "osc" | "string" | "stringEscape";
  let state: State = "ground";
  let out = "";
  for (const ch of value.replace(/\r\n/g, "\n")) {
    if (state === "ground") {
      if (ch === "\x1b") { state = "escape"; continue; }
      if (ch === "\r") { if (!out.endsWith("\n")) out += "\n"; continue; }
      if (ch === "\b") {
        const last = out.charCodeAt(out.length - 1);
        out = out.slice(0, last >= 0xdc00 && last <= 0xdfff ? -2 : -1);
        continue;
      }
      if (ch === "\n" || ch === "\t") { out += ch; continue; }
      const code = ch.codePointAt(0) ?? 0;
      if (code === 0 || code < 32 || code === 127 || (code >= 128 && code <= 159)) continue;
      out += ch;
      continue;
    }
    if (state === "escape") {
      if (ch === "[") state = "csi";
      else if (ch === "]") state = "osc";
      else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") state = "string";
      else if (ch >= " " && ch <= "/") state = "escape";
      else state = ch === "\x1b" ? "escape" : "ground";
      continue;
    }
    if (state === "csi") {
      if (ch >= "@" && ch <= "~") state = "ground";
      else if (ch === "\x1b") state = "escape";
      continue;
    }
    if (state === "osc") {
      if (ch === "\x07") state = "ground";
      else if (ch === "\x1b") state = "stringEscape";
      continue;
    }
    if (state === "string") {
      if (ch === "\x07") state = "ground";
      else if (ch === "\x1b") state = "stringEscape";
      continue;
    }
    state = ch === "\\" ? "ground" : "string";
  }
  return out
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
