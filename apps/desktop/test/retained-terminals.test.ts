import { describe, expect, it } from "vitest";
import { RETAINED_TERMINAL_LIMIT, retainTerminalIds } from "../src/renderer/src/workspace/retained-terminals";

describe("retained shell sessions", () => {
  it("keeps both terminals mounted across repeated switches without duplicates", () => {
    let ids: string[] = [];
    for (const id of ["a", "b", "a", "b", "a"]) ids = retainTerminalIds(ids, id);
    expect(ids).toEqual(["b", "a"]);
    expect(retainTerminalIds(ids, "a")).toBe(ids);
  });
  it("evicts the least recently selected shell at the memory limit", () => {
    const initial = Array.from({ length: RETAINED_TERMINAL_LIMIT }, (_, index) => `t${String(index)}`);
    const ids = retainTerminalIds(initial, "t1");
    expect(retainTerminalIds(ids, "next")).toEqual([
      ...initial.filter((id) => id !== "t0" && id !== "t1"),
      "t1",
      "next",
    ]);
  });
  it("does not evict shells when opening a chat or empty workspace", () => {
    const ids = ["a", "b"];
    expect(retainTerminalIds(ids)).toBe(ids);
  });
});
