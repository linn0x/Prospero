import { describe, expect, it } from "vitest";
import { moveTabBefore, orderedTabIds, tabReorderKey } from "../src/renderer/src/components/tab-strip-state";
import { parseDockPreferences } from "../src/renderer/src/workspace/dock-state";

describe("tab ordering", () => {
  it("moves a terminal between documents and retains every tab once", () => {
    const ids = ["document:a", "document:b", "tool:terminal", "tool:files"];
    expect(moveTabBefore(ids, "tool:terminal", "document:b")).toEqual(["document:a", "tool:terminal", "document:b", "tool:files"]);
    expect(moveTabBefore(ids, "document:a", null)).toEqual(["document:b", "tool:terminal", "tool:files", "document:a"]);
    expect(ids[0]).toBe("document:a");
  });
  it("ignores stale drop targets without dropping or duplicating tabs", () => {
    expect(moveTabBefore(["a", "b"], "a", "closed")).toEqual(["a", "b"]);
    expect(moveTabBefore(["a", "b"], "closed", "a")).toEqual(["a", "b"]);
    expect(moveTabBefore(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(orderedTabIds(["b", "closed", "a", "b"], ["a", "b", "new"])).toEqual(["b", "a", "new"]);
  });
  it("restores a mixed document/tool order while rejecting invalid stored entries", () => {
    const prefs = parseDockPreferences(JSON.stringify({ version: 1, sessions: [{ id: "session", state: { tabs: ["files", "terminal"], active: "terminal", visible: true, tabOrder: ["tool:terminal", "document:a", null, 7, "invalid", "document:a"] } }] }));
    expect(prefs.sessions[0]?.state.tabOrder).toEqual(["tool:terminal", "document:a"]);
  });
  it("uses Command on macOS and Control on Windows without capturing native Ctrl-click", () => {
    const key = { key: "ArrowRight", shiftKey: true, metaKey: false, ctrlKey: true, altKey: false };
    expect(tabReorderKey(key, "win32")).toBe(true);
    expect(tabReorderKey(key, "darwin")).toBe(false);
    expect(tabReorderKey({ ...key, metaKey: true, ctrlKey: false }, "darwin")).toBe(true);
    expect(tabReorderKey({ ...key, shiftKey: false }, "win32")).toBe(false);
    expect(tabReorderKey({ ...key, altKey: true }, "win32")).toBe(false);
  });
});
