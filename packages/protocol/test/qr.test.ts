import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PAIRING_FORMAT_VERSION,
  ProtocolError,
  decodePairingQR,
  deriveRelayRouteId,
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

function relay() {
  return {
    v: 1 as const,
    url: "wss://relay.example.com/v1",
    routeId: deriveRelayRouteId("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"),
    deviceId: "device_0123456789",
    token: "ticket_0123456789",
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

  it("v7 QR 可带 relay，旧 v7 形状会忽略未知 relay 字段", () => {
    const decoded = decodePairingQR(encodePairingQR({ ...makePayload(7), relay: relay() }));
    const legacyV7Shape = z.object({
      v: z.literal(7),
      name: z.string(),
      addrs: z.array(z.string()).min(1),
      port: z.number(),
      token: z.string(),
      pubKey: z.string(),
    });
    const legacyParsed = legacyV7Shape.parse(decoded);
    expect(decoded.relay).toEqual(relay());
    expect(legacyParsed).not.toHaveProperty("relay");
  });

  it("允许 relay-only QR，但没有 direct 和 relay 的 QR 无效", () => {
    const relayOnly = { ...makePayload(), addrs: [], relay: relay() };
    expect(decodePairingQR(encodePairingQR(relayOnly))).toEqual(relayOnly);
    expect(() => encodePairingQR({ ...makePayload(), addrs: [] })).toThrowError(/direct address or relay/);
  });

  it("ws relay 只允许显式 loopback 开发模式，且 token 不会进 URL query", () => {
    const devRelay = { ...relay(), url: "ws://127.0.0.1:8787" };
    expect(() => encodePairingQR({ ...makePayload(), relay: devRelay })).toThrowError(/must use wss/);
    const qr = encodePairingQR(
      { ...makePayload(), relay: devRelay },
      { allowInsecureLoopback: true },
    );
    expect(() => decodePairingQR(qr)).toThrowError(/must use wss/);
    expect(decodePairingQR(qr, { allowInsecureLoopback: true }).relay?.url).toBe(devRelay.url);
    expect(() =>
      encodePairingQR({ ...makePayload(), relay: { ...relay(), url: "wss://relay.example.com?token=x" } }),
    ).toThrowError(/must not contain credentials, query, or fragment/);
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
