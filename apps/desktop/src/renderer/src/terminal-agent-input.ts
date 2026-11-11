import type { ClipboardKey } from "./terminal-clipboard";

export function terminalAgentNewline(event: ClipboardKey, agent: string): string | undefined {
  if (event.type !== "keydown" || event.defaultPrevented || event.isComposing || (event.code !== "Enter" && event.code !== "NumpadEnter") || !event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return undefined;
  if (agent === "claude") return "\x1b\r";
  if (agent === "codex" || agent === "pi" || agent === "agy" || agent === "opencode" || agent === "grok" || agent === "trae" || agent === "deepseek") return "\x1b[13;2u";
  return undefined;
}

const IMAGE_PASTE_AGENTS = new Set([
  "claude",
  "codex",
  "pi",
  "agy",
  "opencode",
  "grok",
  "trae",
  "deepseek",
  "shell",
]);

export function supportsTerminalImagePaste(agent: string): boolean {
  return IMAGE_PASTE_AGENTS.has(agent);
}

export function terminalAgentImageReference(agent: string, path: string): string | undefined {
  if (!supportsTerminalImagePaste(agent) || !path || path.includes("\0")) return undefined;
  const isWindowsPath = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path);
  if (agent === "shell") {
    if (isWindowsPath) return `"${path.replace(/"/g, '\\"')}"`;
    return `'${path.replace(/'/g, "'\\''")}'`;
  }
  const quoted = isWindowsPath ? path.replace(/"/g, '\\"') : path.replace(/["\\]/g, "\\$&");
  return `"${quoted}"`;
}
