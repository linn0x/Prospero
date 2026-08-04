import { describe, expect, it } from "vitest";
import {
  ProtocolError,
  decodePairingQR,
  encodePairingQR,
  generateKeyPairB64,
  type PairingPayload,
} from "../src/index.js";

function makePayload(v = 0): PairingPayload {
  return {
    v,
    name: "MacBook-Pro",
    addrs: ["192.168.1.23", "10.8.0.2"],
    port: 7423,
    token: "0123456789abcdef",
    pubKey: generateKeyPairB64().publicKey,
  };
}

describe("pairing QR", () => {
  it("编解码往返", () => {
    const p = makePayload();
    const qr = encodePairingQR(p);
    expect(qr.startsWith("prospero://pair?d=")).toBe(true);
    expect(decodePairingQR(qr)).toEqual(p);
  });

  it("拒绝非 Prospero QR", () => {
    expect(() => decodePairingQR("https://example.com")).toThrowError(
      /not a Prospero/,
    );
  });

  it("拒绝不支持的版本", () => {
    const qr = encodePairingQR(makePayload(1));
    try {
      decodePairingQR(qr);
      expect.unreachable();
    } catch (e) {
      expect((e as ProtocolError).code).toBe("version");
    }
  });

  it("拒绝损坏的载荷", () => {
    expect(() => decodePairingQR("prospero://pair?d=!!!")).toThrowError(
      ProtocolError,
    );
    expect(() => decodePairingQR("prospero://pair?d=e30")).toThrowError( // {} 的 base64url
      ProtocolError,
    );
  });
});
