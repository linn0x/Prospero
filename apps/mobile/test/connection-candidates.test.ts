import { describe, expect, it } from "vitest";
import { selectConnectionCandidates } from "../src/lib/connection-candidates";
import type { StoredHost } from "../src/lib/hosts";

const host = (overrides: Partial<StoredHost> = {}): StoredHost => ({
  id: "host",
  name: "Mac",
  addrs: ["192.168.1.8", "10.0.0.8"],
  port: 7423,
  token: "0123456789abcdef",
  daemonPub: "daemon-public-key",
  pairedAt: 1,
  connectionMode: "auto",
  relay: { url: "wss://relay.example.com/v1", routeId: "route_0123456789", deviceId: "device_0123456789" },
  relayToken: "relay_token_0123456789",
  ...overrides,
});

describe("connection candidate policy", () => {
  it("direct only races every direct address", () => {
    const selected = selectConnectionCandidates(host({ connectionMode: "direct" }));
    expect(selected.candidates).toEqual([
      { path: "direct", addr: "192.168.1.8" },
      { path: "direct", addr: "10.0.0.8" },
    ]);
  });

  it("relay only opens no LAN candidates", () => {
    const selected = selectConnectionCandidates(host({ connectionMode: "relay" }));
    expect(selected.candidates).toHaveLength(1);
    expect(selected.candidates[0]?.path).toBe("relay");
  });

  it("auto creates direct and relay candidates in one batch", () => {
    const selected = selectConnectionCandidates(host());
    expect(selected.candidates.map((candidate) => candidate.path)).toEqual([
      "direct",
      "direct",
      "relay",
    ]);
  });

  it("keeps an auto direct fallback usable when a stale relay ticket is absent", () => {
    const selected = selectConnectionCandidates(host({ relayToken: undefined }));
    expect(selected.candidates.map((candidate) => candidate.path)).toEqual(["direct", "direct"]);
    expect(selected.relayCredentialsMissing).toBe(false);
  });

  it("blocks relay-only mode rather than silently falling back", () => {
    const selected = selectConnectionCandidates(host({ connectionMode: "relay", relayToken: undefined }));
    expect(selected.candidates).toEqual([]);
    expect(selected.relayCredentialsMissing).toBe(true);
  });
});
