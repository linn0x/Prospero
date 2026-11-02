import { describe, expect, it } from "vitest";
import { parseC2S, parseS2C } from "../src/schemas.js";

describe("mobile desktop parity", () => {
  it("round trips lifecycle identities and requires explicit native binding UUIDs", () => {
    const nativeId = "d86e69bd-a3f1-4713-bfbd-cb5c2ac50390";
    expect(parseC2S({ type: "session.archive", sid: "same-session", requestId: "archive", nativeId })).toMatchObject({ nativeId });
    expect(() => parseC2S({ type: "session.resume", sid: "same-session", requestId: "resume", nativeId: "last" })).toThrow();
    const session = { id: "same-session", agent: "codex", kind: "pty", status: "done", title: "Saved", cwd: "/work", createdAt: 1, cols: 80, rows: 24, archived: true, revision: 3,
      nativeSession: { runtimeId: "instance-one", nativeId, managed: true, state: "archived", error: null } };
    expect(parseS2C({ type: "session.lifecycle.result", sid: session.id, requestId: "archive", ok: true, session })).toMatchObject({ session });
  });
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

it.each(["launch.models", "agent.models", "agent.control.result", "agent.modes"])("accepts absent Rust catalog values in %s without weakening nonempty values", (type) => {
  const input = { type, requestId: "catalog", sid: "session", agent: "claude", models: [], modes: [], action: "model.set", ok: true,
    currentModel: null, currentEffort: null, currentPreset: null, currentMode: null };
  const parsed = parseS2C(input) as Record<string, unknown>;
  expect(parsed.currentEffort).toBeUndefined();
  expect(parsed.currentModel).toBeUndefined();
  expect(parsed.currentPreset).toBeUndefined();
  expect(parsed.currentMode).toBeUndefined();
  expect(() => parseS2C({ ...input, [type === "agent.modes" ? "currentMode" : "currentModel"]: 42 })).toThrow();
});
