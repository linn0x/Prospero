/**
 * 纯 JS base64 / base64url。React Native(Hermes)没有 Buffer,
 * atob/btoa 对二进制不可靠,protocol 包必须自带实现。
 */
import { ProtocolError } from "./errors.js";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const REV = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) REV[ALPHABET.charCodeAt(i)] = i;

export function toB64(bytes: Uint8Array): string {
  // Tiny string appends create millions of rope nodes before the final JSON
  // frame flattens them. Keep scratch space bounded and join flat chunks.
  const chunks: string[] = [];
  const chars: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    chars.push(ALPHABET[b0 >> 2]!, ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!);
    if (b1 === undefined) {
      chars.push("=", "=");
    } else {
      chars.push(ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!, b2 === undefined ? "=" : ALPHABET[b2 & 63]!);
    }
    if (chars.length === 16_384) {
      chunks.push(chars.join(""));
      chars.length = 0;
    }
  }
  if (chars.length > 0) chunks.push(chars.join(""));
  return chunks.join("");
}

export function fromB64(s: string): Uint8Array {
  const trimmed = s.replace(/=+$/, "");
  if (trimmed.length % 4 === 1) {
    throw new ProtocolError("invalid base64 length", "format");
  }
  const out = new Uint8Array(Math.floor((trimmed.length * 3) / 4));
  const vals = new Int16Array(4);
  let o = 0;
  for (let i = 0; i < trimmed.length; i += 4) {
    const count = Math.min(4, trimmed.length - i);
    for (let j = 0; j < count; j++) {
      const code = trimmed.charCodeAt(i + j);
      const v = code < 128 ? REV[code]! : -1;
      if (v === -1) throw new ProtocolError("invalid base64 character", "format");
      vals[j] = v!;
    }
    const [v0, v1, v2, v3] = vals;
    out[o++] = (v0! << 2) | (v1! >> 4);
    if (count > 2) out[o++] = ((v1! & 15) << 4) | (v2! >> 2);
    if (count > 3) out[o++] = ((v2! & 3) << 6) | v3!;
  }
  return out;
}

export function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64Url(s: string): Uint8Array {
  return fromB64(s.replace(/-/g, "+").replace(/_/g, "/"));
}
