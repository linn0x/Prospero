/**
 * UTF-8 编解码。优先用平台 TextEncoder/TextDecoder(Node / 新 Hermes),
 * 缺失时走纯 JS 兜底(旧 Hermes)。
 */

export function utf8Encode(s: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) i++; // 代理对占两个 code unit
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
    }
  }
  return Uint8Array.from(out);
}

export function utf8Decode(b: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(b);
  let out = "";
  let i = 0;
  while (i < b.length) {
    const b0 = b[i++]!;
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
    } else if ((b0 & 0xe0) === 0xc0) {
      cp = ((b0 & 31) << 6) | (b[i++]! & 63);
    } else if ((b0 & 0xf0) === 0xe0) {
      cp = ((b0 & 15) << 12) | ((b[i++]! & 63) << 6) | (b[i++]! & 63);
    } else {
      cp =
        ((b0 & 7) << 18) |
        ((b[i++]! & 63) << 12) |
        ((b[i++]! & 63) << 6) |
        (b[i++]! & 63);
    }
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 1023));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}
