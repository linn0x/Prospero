/**
 * 配对 QR 载荷编解码。
 * QR 内容:`prospero://pair?d=<base64url(JSON)>`
 * 一次扫码带走:全部网卡候选地址 + 端口 + token + daemon 公钥。
 */
import { fromB64Url, toB64Url } from "./b64.js";
import { ProtocolError } from "./errors.js";
import { PROTOCOL_VERSION } from "./messages.js";
import { PairingPayloadSchema, type PairingPayload } from "./schemas.js";
import { utf8Decode, utf8Encode } from "./utf8.js";

const PREFIX = "prospero://pair?d=";

export function encodePairingQR(payload: PairingPayload): string {
  const p = PairingPayloadSchema.parse(payload);
  return PREFIX + toB64Url(utf8Encode(JSON.stringify(p)));
}

export function decodePairingQR(text: string): PairingPayload {
  if (!text.startsWith(PREFIX)) {
    throw new ProtocolError("not a Prospero pairing QR", "format");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(fromB64Url(text.slice(PREFIX.length))));
  } catch {
    throw new ProtocolError("pairing payload is not valid base64url JSON", "format");
  }
  const parsed = PairingPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProtocolError("pairing payload failed validation", "format");
  }
  if (parsed.data.v !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      `pairing payload version ${parsed.data.v} not supported (local ${PROTOCOL_VERSION})`,
      "version",
    );
  }
  return parsed.data;
}
