import { describe, expect, it } from "vitest";
import { encodePairingQR, generateKeyPairB64, PAIRING_FORMAT_VERSION, type PairingPayload } from "@prospero/protocol";
import { decodeManualPairing, PairingAddressError, parsePairingAddress } from "../src/lib/manual-pairing";

const payload: PairingPayload = {
  v: PAIRING_FORMAT_VERSION,
  name: "Test computer",
  addrs: ["192.168.1.10"],
  port: 7423,
  token: "0123456789abcdef",
  pubKey: generateKeyPairB64().publicKey,
};

describe("manual pairing endpoint", () => {
  it("allows an address override without changing the authenticated device identity", () => {
    const result = decodeManualPairing(encodePairingQR(payload), " 10.8.0.2:8000 ");
    expect(result).toEqual({ ...payload, addrs: ["10.8.0.2"], port: 8000 });
    expect(payload.addrs).toEqual(["192.168.1.10"]);
  });

  it("uses the QR port unless explicitly overridden and preserves pasted-QR compatibility", () => {
    const code = ` ${encodePairingQR(payload)} `;
    expect(decodeManualPairing(code, "10.8.0.2").port).toBe(payload.port);
    expect(decodeManualPairing(code, " ")).toEqual(payload);
  });

  it("formats IPv6 so the existing websocket URL builder receives a bracketed address", () => {
    expect(parsePairingAddress("2001:DB8::1")).toEqual({ addr: "[2001:db8::1]" });
    expect(parsePairingAddress("[2001:db8::1]:65535")).toEqual({ addr: "[2001:db8::1]", port: 65535 });
    expect(parsePairingAddress("::1")).toEqual({ addr: "[::1]" });
    expect(parsePairingAddress("::ffff:192.168.1.10")).toEqual({ addr: "[::ffff:192.168.1.10]" });
    expect(parsePairingAddress("2001:db8:0:0:0:0:0:1")).toEqual({ addr: "[2001:db8:0:0:0:0:0:1]" });
  });

  it.each([
    "example.com", "https://192.168.1.10", "192.168.1.10/ws", "192.168.1.10@evil.example",
    "999.1.1.1", "192.168.1", "192.168.001.1", "192.168.1.10:", "192.168.1.10:0",
    "192.168.1.10:65536", "192.168.1.10:4.5", "192.168.1.10:-1", "192.168.1.10:1e3",
    "[2001:db8::1]:", "[2001:db8::1]:0", "2001::db8::1", "2001:db8:1", ":::1",
    "[192.168.1.1]", "[::gggg]", "::ffff:999.1.1.1", "fe80::1%eth0", "2001:db8:0:0:0:0:0:0:1",
  ])("rejects invalid or ambiguous endpoint %s", (value) => {
    expect(() => parsePairingAddress(value)).toThrow(PairingAddressError);
  });

  it("rejects a token or short numeric code without a trusted daemon public key", () => {
    expect(() => decodeManualPairing("123456", "192.168.1.10")).toThrow();
    expect(() => decodeManualPairing(payload.token, "192.168.1.10")).toThrow();
  });

  it("preserves relay credentials and relay URL policy when an IP is supplied", () => {
    const relay = { v: 1 as const, url: "wss://relay.example.com/v1", routeId: "A".repeat(43), deviceId: "device_0123456789", token: "ticket_0123456789" };
    const encoded = encodePairingQR({ ...payload, relay });
    expect(decodeManualPairing(encoded, "10.8.0.2").relay).toEqual(relay);
    const developmentCode = encodePairingQR({ ...payload, relay: { ...relay, url: "ws://127.0.0.1:8787" } }, { allowInsecureLoopback: true });
    expect(() => decodeManualPairing(developmentCode, "10.8.0.2")).toThrow(/wss/);
  });
});
