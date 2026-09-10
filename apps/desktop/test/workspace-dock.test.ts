import { describe, expect, it } from "vitest";
import { clampDockWidth, closeDockTool, defaultDockState, dockNeedsOverlay, openDockTool, parseDockPreferences, updateDockPreferences, sessionDockState, supportsTrajectory, workspaceDockLayout } from "../src/renderer/src/workspace/dock-state";

describe("workspace dock preferences", () => {
  it("only offers trajectory for structured DeepSeek sessions and cleans stale preferences", () => {
    expect(supportsTrajectory({ agent: "deepseek", kind: "structured" })).toBe(true);
    for (const session of [{ agent: "codex", kind: "structured" }, { agent: "claude", kind: "structured" }, { agent: "deepseek", kind: "pty" }]) expect(supportsTrajectory(session)).toBe(false);
    const deepseek = openDockTool(sessionDockState(undefined, true), "trajectory");
    expect(deepseek.tabs).toContain("trajectory");
    const ordinary = sessionDockState(deepseek, false);
    expect(ordinary.tabs).not.toContain("trajectory");
    expect(ordinary.active).toBe("task");
    expect(sessionDockState({ ...deepseek, tabs: [], active: undefined }, true).tabs).toEqual([]);
  });
  it("closes and reopens tools while preserving neighboring selection", () => {
    const opened = openDockTool(defaultDockState(), "terminal");
    expect(opened.tabs).toEqual(["files", "search", "diff", "terminal"]);
    expect(openDockTool(opened, "terminal").tabs).toHaveLength(4);
    const closed = closeDockTool(opened, "terminal");
    expect(closed.active).toBe("diff");
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
    expect(parseDockPreferences('{"version":2,"width":999,"sessions":[]}').width).toBe(560);
    expect(parseDockPreferences("invalid").sessions).toEqual([]);
  });

  it("sanitizes unknown tools and invalid widths", () => {
    const preferences = parseDockPreferences(JSON.stringify({ version: 1, width: 9999, sessions: [{ id: "s", state: { tabs: ["task", "task", "danger"], active: "danger", visible: true } }] }));
    expect(preferences.width).toBe(1200);
    expect(preferences.sessions[0]?.state).toEqual({ tabs: ["task"], active: "task", visible: true });
    expect(clampDockWidth(Number.NaN)).toBe(560);
    expect(clampDockWidth(1)).toBe(320);
  });

  it("preserves at least 420px for content and uses overlay when space runs out", () => {
    expect(dockNeedsOverlay(781, 360)).toBe(false);
    expect(dockNeedsOverlay(780, 360)).toBe(true);
    expect(dockNeedsOverlay(1024 - 256, 360)).toBe(true);
    expect(dockNeedsOverlay(1280 - 256, 560)).toBe(false);
  });

  it("shrinks a saved wide dock before falling back to a sheet, without crossing the breakpoint repeatedly", () => {
    expect(workspaceDockLayout(1100, 1000)).toEqual({ width: 679, maxWidth: 679, overlay: false });
    expect(workspaceDockLayout(741, 1000)).toEqual({ width: 320, maxWidth: 320, overlay: false });
    expect(workspaceDockLayout(740, 1000)).toEqual({ width: 320, maxWidth: 320, overlay: true });
    expect(workspaceDockLayout(741, 1000).overlay).toBe(false);
    expect(workspaceDockLayout(1800, 1000).width).toBe(1000);
  });

  it("uses adaptive sizing for new preferences and preserves an existing manual width", () => {
    expect(parseDockPreferences(null).autoWidth).toBe(true);
    expect(parseDockPreferences(JSON.stringify({ version: 1, width: 420, sessions: [] }))).toMatchObject({ width: 420, autoWidth: false });
    const saved = updateDockPreferences(parseDockPreferences(null), "s", defaultDockState());
    expect(parseDockPreferences(JSON.stringify(saved)).autoWidth).toBe(true);
  });
});
