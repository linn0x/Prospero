import { describe, expect, it } from "vitest";
import { nextLivenessAction } from "../src/lib/connection-liveness";

describe("connection liveness", () => {
  it("keeps v12 and older compatible by never sending the v13 application ping", () => {
    expect(nextLivenessAction({ protocolVersion: 12, lastRecvAt: 10_000, lastPingAt: 0, pendingPingId: null }, 25_000))
      .toBe("none");
  });

  it("sends encrypted v13 pings every fifteen seconds and waits for pong", () => {
    const state = { protocolVersion: 13, lastRecvAt: 10_000, lastPingAt: 10_000, pendingPingId: null };
    expect(nextLivenessAction(state, 24_999)).toBe("none");
    expect(nextLivenessAction(state, 25_000)).toBe("send_ping");
    expect(nextLivenessAction({ ...state, pendingPingId: "ping-1" }, 40_000)).toBe("none");
  });

  it("reconnects a silent socket even if it is still OPEN", () => {
    expect(nextLivenessAction({ protocolVersion: 13, lastRecvAt: 0, lastPingAt: 0, pendingPingId: "ping-1" }, 35_000))
      .toBe("reconnect");
  });
});
