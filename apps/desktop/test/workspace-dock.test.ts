import { describe, expect, it } from "vitest";
import { clampDockWidth, closeDockTool, defaultDockState, dockNeedsOverlay, openDockTool, parseDockPreferences, updateDockPreferences } from "../src/renderer/src/workspace/dock-state";

describe("workspace dock preferences", () => {
  it("closes and reopens tools while preserving neighboring selection", () => {
    const opened = openDockTool(defaultDockState(), "terminal");
    expect(opened.tabs).toEqual(["task", "diff", "execution", "terminal"]);
    expect(openDockTool(opened, "terminal").tabs).toHaveLength(4);
    const closed = closeDockTool(opened, "terminal");
    expect(closed.active).toBe("execution");
    expect(closed.visible).toBe(true);
    expect(opened.active).toBe("terminal");
    expect(closeDockTool({ tabs: ["task"], active: "task", visible: true }, "task")).toEqual({ tabs: [], active: undefined, visible: true });
  });

  it("restores separate sessions with a bounded versioned record", () => {
    let preferences = parseDockPreferences(null);
    for (let index = 0; index < 5000; index += 1) preferences = updateDockPreferences(preferences, `session-${index}`, openDockTool(defaultDockState(), index % 2 ? "diff" : "terminal"));
    const restored = parseDockPreferences(JSON.stringify(preferences));
    expect(restored.sessions).toHaveLength(100);
    expect(restored.sessions[0]?.id).toBe("session-4900");
    expect(restored.sessions.at(-1)?.state.active).toBe("diff");
    expect(parseDockPreferences('{"version":2,"width":999,"sessions":[]}').width).toBe(360);
    expect(parseDockPreferences("invalid").sessions).toEqual([]);
  });

  it("sanitizes unknown tools and invalid widths", () => {
    const preferences = parseDockPreferences(JSON.stringify({ version: 1, width: 9999, sessions: [{ id: "s", state: { tabs: ["task", "task", "danger"], active: "danger", visible: true } }] }));
    expect(preferences.width).toBe(560);
    expect(preferences.sessions[0]?.state).toEqual({ tabs: ["task"], active: "task", visible: true });
    expect(clampDockWidth(Number.NaN)).toBe(360);
    expect(clampDockWidth(1)).toBe(300);
  });

  it("preserves at least 420px for content and uses overlay when space runs out", () => {
    expect(dockNeedsOverlay(788, 360)).toBe(false);
    expect(dockNeedsOverlay(787, 360)).toBe(true);
    expect(dockNeedsOverlay(1024 - 256, 360)).toBe(true);
    expect(dockNeedsOverlay(1280 - 256, 560)).toBe(false);
  });
});
