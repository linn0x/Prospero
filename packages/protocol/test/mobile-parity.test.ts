import { describe, expect, it } from "vitest";
import { parseC2S, parseS2C } from "../src/schemas.js";

describe("mobile desktop parity", () => {
  it("preserves byte snapshots without breaking legacy ANSI snapshots", () => {
    const snapshot = { type: "term.snapshot", sid: "terminal", ansi: "old screen", seq: 42, cols: 80, rows: 24 };
    expect(parseS2C(snapshot)).toEqual(snapshot);
    const bytes = { ...snapshot, ansi: "", dataB64: "5Lit5paHAP8=" };
    expect(parseS2C(bytes)).toEqual(bytes);
  });

  it("requires a correlated fork and preserves its result", () => {
    expect(() => parseC2S({ type: "session.fork", sid: "source" })).toThrow();
    const request = { type: "session.fork", sid: "source", requestId: "request" };
    expect(parseC2S(request)).toEqual(request);
    const result = { type: "session.fork.result", sid: "source", requestId: "request", ok: false, error: "busy", code: "bad_message" };
    expect(parseS2C(result)).toEqual(result);
  });
});
