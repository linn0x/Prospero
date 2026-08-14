import { describe, expect, it } from "vitest";
import { RELAY_PROTOCOL_VERSION, type RelayPairing } from "@prospero/protocol";
import { advanceRelayClient, relayFailureFromControl } from "../src/lib/relay-client-state";

const relay: RelayPairing = {
  v: RELAY_PROTOCOL_VERSION,
  url: "wss://relay.example.com/v1",
  routeId: "route_0123456789",
  deviceId: "device_0123456789",
  token: "relay_token_0123456789",
};

describe("relay client control state", () => {
  it("opens with client.open, waits through pending, then starts E2E only at stream.ready", () => {
    const opened = advanceRelayClient("opening", "opened", relay);
    expect(opened.state).toBe("awaiting_ready");
    expect(opened.action).toMatchObject({ type: "send_connect" });
    expect((opened.action as { frame: string }).frame).toContain('"client.open"');

    const pending = advanceRelayClient("awaiting_ready", {
      type: "client.status",
      v: RELAY_PROTOCOL_VERSION,
      status: "pending",
      streamId: "stream_0123456789",
      expiresAt: Date.now() + 1_000,
    }, relay);
    expect(pending).toEqual({ state: "awaiting_ready", action: null });

    const ready = advanceRelayClient("awaiting_ready", {
      type: "stream.ready",
      v: RELAY_PROTOCOL_VERSION,
      streamId: "stream_0123456789",
    }, relay);
    expect(ready).toEqual({ state: "e2e", action: { type: "start_e2e" } });
  });

  it("maps relay authentication and retryable pressure to actionable categories", () => {
    expect(relayFailureFromControl({
      type: "error",
      v: RELAY_PROTOCOL_VERSION,
      code: "unauthorized",
      message: "ticket rejected",
    })).toMatchObject({ failure: "relay_auth" });
    expect(relayFailureFromControl({
      type: "error",
      v: RELAY_PROTOCOL_VERSION,
      code: "rate_limited",
      message: "slow down",
      retryAfterMs: 1_000,
    })).toMatchObject({ failure: "relay_rate_limit" });
  });
});
