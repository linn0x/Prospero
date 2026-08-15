import { describe, expect, it } from "vitest";
import { SecurePipeRoundTripState } from "./secure-pipe-roundtrip-state.js";

const echo = new TextEncoder().encode("pipe-round-trip");

function completedTerminal(): { type: "complete"; acknowledged: true } {
  return { type: "complete", acknowledged: true };
}

describe("secure pipe ACK completion state", () => {
  it("accepts an EPIPE only after full echo, ACK finish, server acknowledgement, and close", () => {
    const state = new SecurePipeRoundTripState(echo);
    expect(state.receiveEcho(echo.subarray(0, 4))).toBe(false);
    expect(state.receiveEcho(echo.subarray(4))).toBe(true);
    state.acknowledgementFinished();
    state.socketError(Object.assign(new Error("read EPIPE"), { code: "EPIPE" }));
    expect(state.outcome).toEqual({ kind: "pending" });
    state.serverTerminal(completedTerminal());
    expect(state.outcome).toEqual({ kind: "response", data: echo, orderlyEpipe: true });
  });

  it("rejects an early EPIPE before the response", () => {
    const state = new SecurePipeRoundTripState(echo);
    state.socketError(Object.assign(new Error("read EPIPE"), { code: "EPIPE" }));
    expect(state.outcome).toMatchObject({ kind: "error", error: { code: "EPIPE" } });
  });

  it("rejects EPIPE when no ACK ever finishes", () => {
    const state = new SecurePipeRoundTripState(echo);
    expect(state.receiveEcho(echo)).toBe(true);
    state.socketError(Object.assign(new Error("read EPIPE"), { code: "EPIPE" }));
    state.serverTerminal(completedTerminal());
    state.timedOut(10);
    expect(state.outcome).toMatchObject({ kind: "error", error: { message: "Named pipe roundtrip timed out after 10ms" } });
  });

  it("rejects EPIPE after a wrong response", () => {
    const state = new SecurePipeRoundTripState(echo);
    state.receiveEcho(new TextEncoder().encode("wrong-response"));
    state.socketError(Object.assign(new Error("read EPIPE"), { code: "EPIPE" }));
    state.acknowledgementFinished();
    state.serverTerminal(completedTerminal());
    expect(state.outcome).toMatchObject({ kind: "error", error: { message: "Named pipe returned an invalid roundtrip response" } });
  });

  it("rejects EPIPE when the server terminal is not acknowledged", () => {
    const state = new SecurePipeRoundTripState(echo);
    expect(state.receiveEcho(echo)).toBe(true);
    state.acknowledgementFinished();
    state.socketError(Object.assign(new Error("read EPIPE"), { code: "EPIPE" }));
    state.serverTerminal({ type: "complete", acknowledged: false });
    expect(state.outcome).toMatchObject({
      kind: "error",
      error: { message: "Named pipe server did not complete an acknowledged roundtrip" },
    });
  });

  it("does not turn any non-EPIPE socket failure into success", () => {
    const state = new SecurePipeRoundTripState(echo);
    expect(state.receiveEcho(echo)).toBe(true);
    state.acknowledgementFinished();
    state.serverTerminal(completedTerminal());
    state.socketError(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
    expect(state.outcome).toMatchObject({ kind: "error", error: { code: "ECONNRESET" } });
  });
});
