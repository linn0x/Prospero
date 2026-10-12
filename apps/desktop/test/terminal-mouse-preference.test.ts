import { expect, it } from "vitest";
import { readTerminalMousePreference, writeTerminalMousePreference } from "../src/renderer/src/workspace/TerminalMouseToggle";

it("keeps each session's mouse mode while inheriting the existing global preference", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  expect(readTerminalMousePreference(storage, "first")).toBe(true);
  writeTerminalMousePreference(false, storage);
  expect(readTerminalMousePreference(storage, "first")).toBe(false);
  writeTerminalMousePreference(true, storage, "first");
  expect(readTerminalMousePreference(storage, "first")).toBe(true);
  expect(readTerminalMousePreference(storage, "second")).toBe(false);
  writeTerminalMousePreference(false, storage, "first");
  expect(readTerminalMousePreference(storage, "first")).toBe(false);
});
