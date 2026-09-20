import { describe, expect, it } from "vitest";
import { retainTerminalIds } from "../src/renderer/src/workspace/retained-terminals";

describe("retained shell sessions", () => {
  it("keeps both terminals mounted across repeated switches without duplicates", () => {
    let ids: string[] = [];
    for (const id of ["a", "b", "a", "b", "a"]) ids = retainTerminalIds(ids, id);
    expect(ids).toEqual(["b", "a"]);
    expect(retainTerminalIds(ids, "a")).toBe(ids);
  });
  it("evicts the least recently selected shell at the memory limit", () => {
    const ids = retainTerminalIds(["a", "b", "c", "d"], "b");
    expect(retainTerminalIds(ids, "e")).toEqual(["c", "d", "b", "e"]);
  });
  it("does not evict shells when opening a chat or empty workspace", () => {
    const ids = ["a", "b"];
    expect(retainTerminalIds(ids)).toBe(ids);
  });
});
