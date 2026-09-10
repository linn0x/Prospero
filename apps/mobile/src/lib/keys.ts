/**
 * 终端按键序列。纯逻辑,放 lib 里以便直接测(组件里会连带拉进 react-native)。
 */

/**
 * Ctrl + 某个键要发的字节。
 *
 * 字母映射到 0x01–0x1A(a→^A=0x01 … z→^Z=0x1A)。非字母键不受 Ctrl 影响,
 * 原样返回 —— ctrl 亮着时点方向键,应该还是方向键,而不是被吞掉或发成别的东西。
 *
 * 单独抽出来是因为这个映射错了很难发现:^C 之外的组合平时按得少,
 * 而一旦错就是静默发出一个完全不同的控制字符。
 */
export function ctrlCode(seq: string): string {
  if (seq.length !== 1) return seq;
  const ch = seq.toLowerCase();
  if (ch < "a" || ch > "z") return seq;
  return String.fromCharCode(ch.charCodeAt(0) - 96);
}

export interface TerminalModifiers { ctrl: boolean; option: boolean }
export const NO_TERMINAL_MODIFIERS: TerminalModifiers = { ctrl: false, option: false };

/** Option is the terminal's Alt/Meta key (ESC prefix), including macOS word navigation. */
export function terminalKeySequence(seq: string, { ctrl, option }: TerminalModifiers): string {
  if (!ctrl && !option) return seq;
  if (option && !ctrl && seq === "\x1b[D") return "\x1bb";
  if (option && !ctrl && seq === "\x1b[C") return "\x1bf";
  const cursor = /^\x1b\[([ABCDHF])$/u.exec(seq);
  const paging = /^\x1b\[([2356])~$/u.exec(seq);
  const modifier = 1 + (option ? 2 : 0) + (ctrl ? 4 : 0);
  if (cursor) return `\x1b[1;${modifier}${cursor[1]}`;
  if (paging) return `\x1b[${paging[1]};${modifier}~`;
  // Pasted/IME text and already modified escape sequences pass through untouched.
  if (seq.length !== 1) return seq;
  let key = ctrl ? ctrlCode(seq) : seq;
  if (ctrl && (seq === " " || seq === "@")) key = "\x00";
  if (ctrl && /^[\[\\\]\^_]$/u.test(seq)) key = String.fromCharCode(seq.charCodeAt(0) - 64);
  if (ctrl && seq === "?") key = "\x7f";
  return option ? `\x1b${key}` : key;
}
