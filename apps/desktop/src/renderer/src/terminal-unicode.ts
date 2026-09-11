import { TERMINAL_WIDTH_0, TERMINAL_WIDTH_2 } from "@prospero/protocol/rust-daemon";
import type { Terminal } from "@xterm/xterm";

function contains(ranges: readonly (readonly [number, number])[], value: number): boolean {
  let left = 0; let right = ranges.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    const range = ranges[middle]!;
    if (value < range[0]) right = middle;
    else if (value > range[1]) left = middle + 1;
    else return true;
  }
  return false;
}

export function configureRustTerminalUnicode(terminal: Terminal): void {
  const wcwidth = (value: number): 0 | 1 | 2 => contains(TERMINAL_WIDTH_0, value) ? 0 : contains(TERMINAL_WIDTH_2, value) ? 2 : 1;
  terminal.unicode.register({ version: "prospero-rust-1", wcwidth, charProperties: (value, preceding) => {
    const width = wcwidth(value); const previousWidth = (preceding >> 1) & 3;
    return width === 0 && previousWidth > 0 ? previousWidth * 2 + 1 : width * 2;
  } });
  terminal.unicode.activeVersion = "prospero-rust-1";
}
