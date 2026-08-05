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
