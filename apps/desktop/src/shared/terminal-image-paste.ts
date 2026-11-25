/**
 * CLI/shell agent runtimes that accept pasted image file paths in Prospero
 * integrated terminals (native Ghostty and xterm).
 */
export const TERMINAL_IMAGE_PASTE_AGENTS = new Set([
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

/** Returns true when a terminal session running `agent` supports clipboard image paste. */
export function supportsTerminalImagePaste(agent: string): boolean {
  return TERMINAL_IMAGE_PASTE_AGENTS.has(agent);
}
