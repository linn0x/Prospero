export const DOCK_TOOLS = ["files", "search", "diff", "task", "execution", "terminal", "trajectory"] as const;
export type DockTool = typeof DOCK_TOOLS[number];
export type DockState = { tabs: DockTool[]; active: DockTool | undefined; visible: boolean; tabOrder?: string[] };
export type DockPreferences = { version: 1; width: number; autoWidth?: boolean; sessions: Array<{ id: string; state: DockState }> };
export const DOCK_STORAGE_KEY = "prospero.contextDock.v1";
export const DOCK_SESSION_LIMIT = 100;
export const DOCK_MIN_WIDTH = 320;
export const DOCK_MAX_WIDTH = 1200;
export const DOCK_DEFAULT_WIDTH = 560;
export const WORKSPACE_MIN_WIDTH = 420;
export const DOCK_DIVIDER_WIDTH = 1;

export function clampDockWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, Math.round(width))) : DOCK_DEFAULT_WIDTH;
}

export function dockNeedsOverlay(available: number, width: number): boolean {
  return available < WORKSPACE_MIN_WIDTH + clampDockWidth(width) + DOCK_DIVIDER_WIDTH;
}

export function workspaceDockLayout(available: number, preferred: number) {
  const maxWidth = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, Math.floor(available - WORKSPACE_MIN_WIDTH - DOCK_DIVIDER_WIDTH)));
  const width = Math.min(clampDockWidth(preferred), maxWidth);
  return { width, maxWidth, overlay: dockNeedsOverlay(available, width) };
}

export function defaultDockState(): DockState {
  return { tabs: ["files", "search", "diff"], active: "files", visible: false };
}

export function supportsTrajectory(session: { agent: string; kind: string }): boolean {
  return session.kind === "structured" && session.agent.trim().toLowerCase() === "deepseek";
}

export function sessionDockState(state: DockState | undefined, trajectory: boolean): DockState {
  const current = state ?? (trajectory ? { tabs: ["task", "trajectory", "execution"] as DockTool[], active: "task" as const, visible: false } : defaultDockState());
  const tabs = current.tabs.filter((tool) => tool !== "trajectory" || trajectory);
  return { ...current, tabs, active: current.active && tabs.includes(current.active) ? current.active : tabs[0] };
}

export function parseDockPreferences(raw: string | null): DockPreferences {
  const fallback: DockPreferences = { version: 1, width: DOCK_DEFAULT_WIDTH, autoWidth: true, sessions: [] };
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1) return fallback;
    const source = value as Record<string, unknown>;
    const sessions: DockPreferences["sessions"] = [];
    for (const item of Array.isArray(source["sessions"]) ? source["sessions"].slice(-DOCK_SESSION_LIMIT) : []) {
      if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || item.id.length > 160 || !item.state || typeof item.state !== "object") continue;
      const tabs = [...new Set(Array.isArray(item.state.tabs) ? item.state.tabs.filter((tab: unknown): tab is DockTool => DOCK_TOOLS.includes(tab as DockTool)) : [])] as DockTool[];
      const tabOrder = Array.isArray(item.state.tabOrder) ? [...new Set(item.state.tabOrder.filter((id: unknown): id is string => typeof id === "string" && id.length < 4096 && /^(tool|document):/.test(id)))].slice(0, 200) as string[] : undefined;
      sessions.push({ id: item.id, state: { tabs, active: tabs.includes(item.state.active) ? item.state.active as DockTool : tabs[0], visible: item.state.visible === true, ...(tabOrder ? { tabOrder } : {}) } });
    }
    return { version: 1, width: clampDockWidth(typeof source["width"] === "number" ? source["width"] : DOCK_DEFAULT_WIDTH), autoWidth: source["autoWidth"] === true, sessions };
  } catch {
    return fallback;
  }
}

export function updateDockPreferences(preferences: DockPreferences, id: string, state: DockState): DockPreferences {
  return { ...preferences, sessions: [...preferences.sessions.filter((item) => item.id !== id), { id, state }].slice(-DOCK_SESSION_LIMIT) };
}

export function closeDockTool(state: DockState, tool: DockTool): DockState {
  const index = state.tabs.indexOf(tool);
  const tabs = state.tabs.filter((item) => item !== tool);
  return { ...state, tabs, active: state.active === tool ? tabs[Math.max(0, index - 1)] : state.active };
}

export function openDockTool(state: DockState, tool: DockTool): DockState {
  return { ...state, tabs: state.tabs.includes(tool) ? state.tabs : [...state.tabs, tool], active: tool, visible: true };
}

export function readDockPreferences(): DockPreferences {
  try { return parseDockPreferences(localStorage.getItem(DOCK_STORAGE_KEY)); } catch { return parseDockPreferences(null); }
}

export function writeDockPreferences(preferences: DockPreferences): void {
  try { localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(preferences)); } catch {}
}
