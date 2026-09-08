import { describe, expect, it } from "vitest";
import { CAPABILITY_WORKSPACE_SUMMARY, parseC2S, parseS2C } from "../src/index.js";

describe("workspace summary protocol", () => {
  it("scopes requests to a session and correlates partial, unavailable and complete results", () => {
    expect(CAPABILITY_WORKSPACE_SUMMARY).toBe("workspace.summary.v1");
    expect(parseC2S({ type: "workspace.summary", sid: "session", requestId: "request" })).toEqual({ type: "workspace.summary", sid: "session", requestId: "request" });
    for (const size of [{ sizeBytes: null, sizeComplete: false }, { sizeBytes: 0, sizeComplete: true }, { sizeBytes: 123, sizeComplete: false }]) {
      const response = { type: "workspace.summary.result", sid: "session", requestId: "request", branch: null, checkedAt: 1, ...size };
      expect(parseS2C(response)).toEqual(response);
    }
    expect(() => parseC2S({ type: "workspace.summary", requestId: "request", path: "/arbitrary" })).toThrow();
    expect(() => parseS2C({ type: "workspace.summary.result", sid: "session", requestId: "request", branch: "main", checkedAt: 1, sizeBytes: -1, sizeComplete: true })).toThrow();
  });
});
