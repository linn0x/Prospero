import { describe, expect, it } from "vitest";
import { NoticeGate } from "../src/renderer/src/notifications/notifications";

describe("desktop notification deduplication", () => {
  it("suppresses repeated polling failures without hiding new problems or later retries", () => {
    const gate = new NoticeGate();
    const failed = { kind: "error" as const, message: "Disconnected" };
    expect(gate.accept(failed, 0)).toBe(true);
    expect(gate.accept(failed, 1_000)).toBe(false);
    expect(gate.accept(failed, 29_999)).toBe(false);
    expect(gate.accept({ kind: "warning", message: "Approval needed" }, 2_000)).toBe(true);
    expect(gate.accept(failed, 30_000)).toBe(true);
    expect(gate.accept({ ...failed, message: " " }, 31_000)).toBe(false);
  });
  it("deduplicates streaming updates using stable event keys with bounded storage", () => {
    const gate = new NoticeGate();
    expect(gate.accept({ kind: "warning", key: "session:request", message: "Waiting" }, 0)).toBe(true);
    expect(gate.accept({ kind: "warning", key: "session:request", message: "Still waiting" }, 1_000)).toBe(false);
    for (let index = 0; index < 100; index++) gate.accept({ kind: "error", message: String(index) }, 1_000);
    expect(gate.accept({ kind: "warning", key: "session:request", message: "Waiting" }, 1_000)).toBe(true);
  });
});
