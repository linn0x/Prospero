import { afterEach, expect, it } from "vitest";
import { clearTerminalReadingState, readTerminalReadingState, saveTerminalReadingState } from "../src/renderer/src/workspace/terminal-reading-state";

afterEach(() => clearTerminalReadingState());

it("keeps bounded per-session reading intent and sanitizes transient values", () => {
  expect(readTerminalReadingState("a")).toEqual({ viewport: 0, followBottom: true, find: "" });
  expect(saveTerminalReadingState("a", { viewport: 12.8, followBottom: false, find: "needle" })).toEqual({ viewport: 12, followBottom: false, find: "needle" });
  expect(readTerminalReadingState("a")).toEqual({ viewport: 12, followBottom: false, find: "needle" });
  expect(saveTerminalReadingState("a", { viewport: -5, find: "x".repeat(300) })).toEqual({ viewport: 0, followBottom: false, find: "x".repeat(256) });
});

it("evicts least recently used sessions after the fixed bound", () => {
  for (let i = 0; i < 64; i++) saveTerminalReadingState(`s${i}`, { viewport: i });
  readTerminalReadingState("s0");
  saveTerminalReadingState("new", { viewport: 1 });
  expect(readTerminalReadingState("s0").viewport).toBe(0);
  expect(readTerminalReadingState("s1")).toEqual({ viewport: 0, followBottom: true, find: "" });
});
