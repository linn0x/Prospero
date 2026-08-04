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
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2]! + ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]!;
    if (b1 === undefined) {
      out += "==";
    } else {
      out += ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]!;
      out += b2 === undefined ? "=" : ALPHABET[b2 & 63]!;
    }
  }
  return out;
}

export function fromB64(s: string): Uint8Array {
  const trimmed = s.replace(/=+$/, "");
  if (trimmed.length % 4 === 1) {
    throw new ProtocolError("invalid base64 length", "format");
  }
  const out = new Uint8Array(Math.floor((trimmed.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < trimmed.length; i += 4) {
    const vals: number[] = [];
    for (let j = 0; j < 4 && i + j < trimmed.length; j++) {
      const code = trimmed.charCodeAt(i + j);
      const v = code < 128 ? REV[code]! : -1;
      if (v === -1) throw new ProtocolError("invalid base64 character", "format");
      vals.push(v);
    }
    const [v0, v1, v2, v3] = vals;
    out[o++] = (v0! << 2) | (v1! >> 4);
    if (v2 !== undefined) out[o++] = ((v1! & 15) << 4) | (v2 >> 2);
    if (v3 !== undefined) out[o++] = ((v2! & 3) << 6) | v3;
  }
  return out;
}

export function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64Url(s: string): Uint8Array {
  return fromB64(s.replace(/-/g, "+").replace(/_/g, "/"));
}
