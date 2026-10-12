import type { ClipboardKey } from "./terminal-clipboard";

export function terminalAgentNewline(event: ClipboardKey, agent: string): string | undefined {
  if (event.type !== "keydown" || event.defaultPrevented || event.isComposing || event.code !== "Enter" || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return undefined;
  if (agent === "claude") return "\x1b\r";
  if (agent === "codex") return "\x1b[13;2u";
  return undefined;
}

export function terminalAgentImageReference(agent: string, path: string): string | undefined {
  if (agent !== "claude" && agent !== "codex") return undefined;
  const quoted = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? path : path.replace(/["\\]/g, "\\$&");
  return `"${quoted}"`;
}
