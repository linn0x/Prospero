import { describe, expect, it } from "vitest";
import {
  PAIRING_FORMAT_VERSION,
  ProtocolError,
  decodePairingQR,
  encodePairingQR,
  generateKeyPairB64,
  hostIdForDaemonPublicKey,
  type PairingPayload,
} from "../src/index.js";

function makePayload(v = PAIRING_FORMAT_VERSION): PairingPayload {
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

  it("daemon 与 App 可从同一公钥得到深链主机 ID", () => {
    const p = makePayload();
    const id = hostIdForDaemonPublicKey(p.pubKey);
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[a-zA-Z0-9]+$/);
    expect(hostIdForDaemonPublicKey(p.pubKey)).toBe(id);
  });

  it("拒绝非 Prospero QR", () => {
    expect(() => decodePairingQR("https://example.com")).toThrowError(
      /not a Prospero/,
    );
  });

  it("拒绝不支持的版本", () => {
    const qr = encodePairingQR(makePayload(999));
    try {
      decodePairingQR(qr);
      expect.unreachable();
    } catch (e) {
      expect((e as ProtocolError).code).toBe("version");
    }
  });

  it("接受形状相同的 v5 旧二维码，配对格式不再跟 API 版本一起升级", () => {
    expect(decodePairingQR(encodePairingQR(makePayload(5))).v).toBe(5);
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
