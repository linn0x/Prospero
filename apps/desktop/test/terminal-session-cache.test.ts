import { describe, expect, it } from "vitest";
import {
  updateTerminalSessionCacheEntries,
  type TerminalSessionCacheEntry,
  type TerminalSessionCacheLimits,
} from "../src/renderer/src/terminal-session-cache";

const limits: TerminalSessionCacheLimits = {
  maxEntries: 2,
  maxEntryChars: 8,
  maxTotalChars: 10,
};

function entry(sessionId: string, serialized: string): TerminalSessionCacheEntry {
  return { sessionId, serialized, cursor: 1, cols: 80, rows: 24 };
}

describe("terminal session cache", () => {
  it("keeps the most recently used bounded session entries", () => {
    let entries = updateTerminalSessionCacheEntries([], entry("a", "aaa"), limits);
    entries = updateTerminalSessionCacheEntries(entries, entry("b", "bbb"), limits);
    entries = updateTerminalSessionCacheEntries(entries, entries[0]!, limits);
    entries = updateTerminalSessionCacheEntries(entries, entry("c", "ccc"), limits);

    expect(entries.map((item) => item.sessionId)).toEqual(["a", "c"]);
  });

  it("evicts oldest entries until the total character budget is satisfied", () => {
    let entries = updateTerminalSessionCacheEntries([], entry("a", "aaaaaa"), limits);
    entries = updateTerminalSessionCacheEntries(entries, entry("b", "bbbbbb"), limits);

    expect(entries).toEqual([entry("b", "bbbbbb")]);
  });

  it("rejects oversized or invalid replacements without retaining stale data", () => {
    const current = [entry("a", "valid")];

    expect(updateTerminalSessionCacheEntries(current, entry("a", "x".repeat(9)), limits)).toEqual([]);
    expect(updateTerminalSessionCacheEntries(current, { ...entry("a", "next"), cursor: -1 }, limits)).toEqual([]);
  });
});
