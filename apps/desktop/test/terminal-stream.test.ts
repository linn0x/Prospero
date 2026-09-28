import { describe, expect, it } from "vitest";
import { TerminalStreamKind, decodeTerminalFrame, encodeTerminalFrame } from "../src/shared/terminal-stream";

describe("terminal stream v1 codec", () => {
  it("round-trips the big-endian header without losing a safe sequence", () => {
    const frame = { kind: TerminalStreamKind.Output, sequence: Number.MAX_SAFE_INTEGER, payload: Uint8Array.of(27, 91, 109) };
    expect(decodeTerminalFrame(encodeTerminalFrame(frame), "server")).toEqual(frame);
  });
  it("rejects direction, malformed length, and invalid control payloads", () => {
    const input = encodeTerminalFrame({ kind: TerminalStreamKind.Input, sequence: 1, payload: Uint8Array.of(1) });
    expect(() => decodeTerminalFrame(input, "server")).toThrow("Unexpected");
    const malformed = input.slice(0); new DataView(malformed).setUint32(12, 2, false);
    expect(() => decodeTerminalFrame(malformed, "client")).toThrow("Invalid");
    expect(() => encodeTerminalFrame({ kind: TerminalStreamKind.Ready, sequence: 1, payload: Uint8Array.of(1) })).toThrow("empty");
    expect(() => encodeTerminalFrame({ kind: TerminalStreamKind.ResizeRequest, sequence: 1, payload: Uint8Array.of(0, 19, 0, 5) })).toThrow("dimensions");
  });
});
