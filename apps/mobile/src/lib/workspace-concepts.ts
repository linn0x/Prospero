import { useEffect } from "react";
import { create } from "zustand";
import type { OrchestrationWorktreeAsset, SessionInfo } from "@prospero/protocol";
import { projectName, type SessionProject } from "./session-projects";

export const WORKSPACE_CONCEPTS_STORAGE_KEY = "prospero.workspaceConcepts.v1";

export type WorkspaceSortMode = "recent" | "name";

export interface PersistedWorkspaceConcepts {
  savedWorkspaces: Record<string, string[]>;
  pinnedWorkspaces: Record<string, string[]>;
  pinnedSessions: Record<string, string[]>;
  workspaceSort: WorkspaceSortMode;
}

export interface ConceptsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

const DEFAULT_CONCEPTS: PersistedWorkspaceConcepts = {
  savedWorkspaces: {},
  pinnedWorkspaces: {},
  pinnedSessions: {},
  workspaceSort: "recent",
};

const lazyAsyncStorage: ConceptsStorage = {
  async getItem(key) {
    try {
      const mod = await import("@react-native-async-storage/async-storage");
      return await mod.default.getItem(key);
    } catch {
      return null;
    }
  },
  async setItem(key, value) {
    try {
      const mod = await import("@react-native-async-storage/async-storage");
      await mod.default.setItem(key, value);
    } catch {
      // Ignore storage write errors in non-native or sandboxed test environments.
    }
  },
};

export function normalizeWorkspacePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^[A-Za-z]:[\\/]*$/u.test(trimmed)) return `${trimmed[0]!.toUpperCase()}:\\`;
  return trimmed.replace(/[\\/]+$/u, "") || "/";
}

export function workspacePathKey(raw: string): string {
  const normalized = normalizeWorkspacePath(raw).replace(/\\/g, "/");
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function sanitizeStringMap(
  value: unknown,
  maxPerHost = 120,
  normalizeItem = normalizeWorkspacePath,
  keyForItem = workspacePathKey,
): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [hostId, list] of Object.entries(value)) {
    if (!hostId || hostId.length > 160 || !Array.isArray(list)) continue;
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      if (typeof entry !== "string") continue;
      const trimmed = normalizeItem(entry);
      if (!trimmed || trimmed.length > 1024) continue;
      const key = keyForItem(trimmed);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(trimmed);
      if (deduped.length >= maxPerHost) break;
    }
    if (deduped.length > 0) result[hostId] = deduped;
  }
  return result;
}

function parsePersistedConcepts(raw: string | null): PersistedWorkspaceConcepts {
  if (!raw) return DEFAULT_CONCEPTS;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceConcepts>;
    return {
      savedWorkspaces: sanitizeStringMap(parsed.savedWorkspaces),
      pinnedWorkspaces: sanitizeStringMap(parsed.pinnedWorkspaces),
      pinnedSessions: sanitizeStringMap(
        parsed.pinnedSessions,
        200,
        (id) => id.trim(),
        (id) => id.trim(),
      ),
      workspaceSort: parsed.workspaceSort === "name" ? "name" : "recent",
    };
  } catch {
    return DEFAULT_CONCEPTS;
  }
}

export interface WorkspaceConceptsStore extends PersistedWorkspaceConcepts {
  hydrated: boolean;
  hydrate(): Promise<void>;
  addWorkspace(hostId: string, cwd: string): void;
  forgetWorkspace(hostId: string, cwd: string): void;
  togglePinWorkspace(hostId: string, cwd: string): void;
  togglePinSession(hostId: string, sid: string): void;
  setWorkspaceSort(sort: WorkspaceSortMode): void;
}

export function createWorkspaceConceptsStore(storage: ConceptsStorage = lazyAsyncStorage) {
  let hydrateInFlight: Promise<void> | null = null;
  let writeQueue = Promise.resolve();

  function persistConcepts(state: PersistedWorkspaceConcepts): void {
    const payload: PersistedWorkspaceConcepts = {
      savedWorkspaces: state.savedWorkspaces,
      pinnedWorkspaces: state.pinnedWorkspaces,
      pinnedSessions: state.pinnedSessions,
      workspaceSort: state.workspaceSort,
    };
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(() => storage.setItem(WORKSPACE_CONCEPTS_STORAGE_KEY, JSON.stringify(payload)))
      .catch(() => undefined);
  }

  return create<WorkspaceConceptsStore>()((set, get) => ({
    ...DEFAULT_CONCEPTS,
    hydrated: false,
    hydrate: () => {
      if (get().hydrated) return Promise.resolve();
      if (hydrateInFlight) return hydrateInFlight;
      hydrateInFlight = storage
        .getItem(WORKSPACE_CONCEPTS_STORAGE_KEY)
        .then((raw) => {
          if (get().hydrated) return;
          set({ ...parsePersistedConcepts(raw), hydrated: true });
        })
        .catch(() => {
          set({ hydrated: true });
        })
        .finally(() => {
          hydrateInFlight = null;
        });
      return hydrateInFlight;
    },
    addWorkspace: (hostId, cwd) => {
      const normalized = normalizeWorkspacePath(cwd);
      if (!hostId || !normalized) return;
      const key = workspacePathKey(normalized);
      const current = get().savedWorkspaces[hostId] ?? [];
      if (current.some((item) => workspacePathKey(item) === key)) return;
      const savedWorkspaces = {
        ...get().savedWorkspaces,
        [hostId]: [normalized, ...current].slice(0, 120),
      };
      set({ savedWorkspaces, hydrated: true });
      persistConcepts({ ...get(), savedWorkspaces });
    },
    forgetWorkspace: (hostId, cwd) => {
      const key = workspacePathKey(cwd);
      if (!hostId || !key) return;
      const nextSaved = (get().savedWorkspaces[hostId] ?? []).filter(
        (item) => workspacePathKey(item) !== key,
      );
      const nextPinned = (get().pinnedWorkspaces[hostId] ?? []).filter(
        (item) => workspacePathKey(item) !== key,
      );
      const savedWorkspaces = { ...get().savedWorkspaces, [hostId]: nextSaved };
      const pinnedWorkspaces = { ...get().pinnedWorkspaces, [hostId]: nextPinned };
      set({ savedWorkspaces, pinnedWorkspaces, hydrated: true });
      persistConcepts({ ...get(), savedWorkspaces, pinnedWorkspaces });
    },
    togglePinWorkspace: (hostId, cwd) => {
      const normalized = normalizeWorkspacePath(cwd);
      const key = workspacePathKey(normalized);
      if (!hostId || !key) return;
      const current = get().pinnedWorkspaces[hostId] ?? [];
      const exists = current.some((item) => workspacePathKey(item) === key);
      const next = exists
        ? current.filter((item) => workspacePathKey(item) !== key)
        : [normalized, ...current].slice(0, 60);
      const pinnedWorkspaces = { ...get().pinnedWorkspaces, [hostId]: next };
      const savedCurrent = get().savedWorkspaces[hostId] ?? [];
      const savedWorkspaces =
        !exists && !savedCurrent.some((item) => workspacePathKey(item) === key)
          ? { ...get().savedWorkspaces, [hostId]: [normalized, ...savedCurrent].slice(0, 120) }
          : get().savedWorkspaces;
      set({ pinnedWorkspaces, savedWorkspaces, hydrated: true });
      persistConcepts({ ...get(), pinnedWorkspaces, savedWorkspaces });
    },
    togglePinSession: (hostId, sid) => {
      if (!hostId || !sid) return;
      const current = get().pinnedSessions[hostId] ?? [];
      const next = current.includes(sid)
        ? current.filter((id) => id !== sid)
        : [sid, ...current].slice(0, 120);
      const pinnedSessions = { ...get().pinnedSessions, [hostId]: next };
      set({ pinnedSessions, hydrated: true });
      persistConcepts({ ...get(), pinnedSessions });
    },
    setWorkspaceSort: (workspaceSort) => {
      set({ workspaceSort, hydrated: true });
      persistConcepts({ ...get(), workspaceSort });
    },
  }));
}

export const useWorkspaceConcepts = createWorkspaceConceptsStore();

export function useHydratedWorkspaceConcepts() {
  const hydrate = useWorkspaceConcepts((state) => state.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);
  return useWorkspaceConcepts();
}

const AGENT_SHORT_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  agy: "Antigravity",
  opencode: "OpenCode",
  pi: "Pi",
  deepseek: "DeepSeek",
  grok: "Grok",
  trae: "Trae",
  shell: "Terminal",
};

/**
 * Mirrors Desktop `sidebarSessionLabel` (`apps/desktop/src/renderer/src/workspace/session-presentation.tsx`):
 * strips redundant workspace folder names and `agent ·` prefixes inside workspace trees.
 */
export function desktopSidebarSessionLabel(session: SessionInfo): string {
  const workspaceName = session.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const raw = (session.title || session.preview || "").trim();
  const fallbackAgent = AGENT_SHORT_LABELS[session.agent.toLowerCase()] ?? session.agent;
  if (!raw) return fallbackAgent;
  if (workspaceName) {
    const escapedWorkspace = workspaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stripped = raw
      .replace(new RegExp(`^${escapedWorkspace}$`, "i"), "")
      .replace(new RegExp(`\\s*[·:—-]\\s*${escapedWorkspace}(\\s+副本|\\s+Copy)?$`, "i"), "$1")
      .trim();
    if (!stripped) return fallbackAgent;
    const copyMatch = stripped.match(/^([a-z0-9_-]+)(\s+副本|\s+Copy)?$/i);
    if (copyMatch && copyMatch[1]?.toLowerCase() === session.agent.toLowerCase()) {
      return `${fallbackAgent}${copyMatch[2] ?? ""}`;
    }
    const escapedAgent = session.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutAgentPrefix = stripped
      .replace(new RegExp(`^${escapedAgent}(?:\\s+Code)?\\s*[·:—-]\\s*`, "i"), "")
      .trim();
    return withoutAgentPrefix || stripped;
  }
  return raw;
}

function formatSessionStamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()) || timestamp <= 0) return "";
  const now = new Date();
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return hhmm;
  return `${String(date.getMonth() + 1)}/${String(date.getDate())} ${hhmm}`;
}

function formatCompactSidebarStamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime()) || timestamp <= 0) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${String(date.getMonth() + 1)}/${String(date.getDate())}`;
}

/**
 * Produces single-line IDE sidebar row text: when a session uses the generic
 * agent default title (`Codex`, `Terminal`, etc.), appends the model or short
 * id inline so sibling rows stay compact yet immediately distinguishable.
 */
export function sidebarSessionRowDisplay(
  session: SessionInfo,
  options?: { folderLabel?: string },
): { title: string; meta: string } {
  const label = desktopSidebarSessionLabel(session);
  const fallbackAgent = AGENT_SHORT_LABELS[session.agent.toLowerCase()] ?? session.agent;
  const escapedAgent = session.agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedFallback = fallbackAgent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isGenericDefault = new RegExp(
    `^(?:${escapedFallback}|${escapedAgent})(?:\\s+副本|\\s+Copy)?$`,
    "i",
  ).test(label);
  const modelRaw = (session.agentControls?.currentModel || session.model || "").trim();
  const modelShort = modelRaw ? (modelRaw.split("/").at(-1) ?? modelRaw) : "";
  const preview = session.preview?.trim().replace(/\s+/g, " ") || "";
  const disambiguator = isGenericDefault ? (modelShort || preview || `#${session.id.slice(0, 4)}`) : "";
  const title = disambiguator ? `${label} · ${disambiguator}` : label;
  const stamp = formatCompactSidebarStamp(session.createdAt);
  const meta = [options?.folderLabel?.trim() || null, stamp || null]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  return { title, meta };
}

/**
 * Builds a compact, disambiguating metadata line for workbench and sidebar rows
 * so multiple sessions in the same workspace (e.g. several Codex TUI tabs) are
 * distinguishable at a glance.
 */
export function sessionWorkbenchSubtitle(
  session: SessionInfo,
  options?: { showWorkspace?: string },
): string {
  const modeLabel = session.kind === "pty" ? "TUI" : "对话";
  const modelRaw = (session.agentControls?.currentModel || session.model || "").trim();
  const modelShort = modelRaw ? (modelRaw.split("/").at(-1) ?? modelRaw) : "";
  const account = session.accountName?.trim() || "";
  const preview = session.preview?.trim().replace(/\s+/g, " ") || "";
  const stamp = formatSessionStamp(session.createdAt);
  const label = desktopSidebarSessionLabel(session);
  const fallbackAgent = AGENT_SHORT_LABELS[session.agent.toLowerCase()] ?? session.agent;
  const isGenericDefault = label.toLowerCase() === fallbackAgent.toLowerCase();
  const shortId = isGenericDefault && !preview && !modelShort ? `#${session.id.slice(0, 4)}` : "";

  return [
    options?.showWorkspace?.trim() || null,
    session.archived ? "已归档" : null,
    modeLabel,
    modelShort || null,
    account || null,
    shortId || null,
    preview || null,
    stamp || null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

/**
 * Mirrors Desktop `Inbox` / `OverviewAttention`: collects both pending approvals
 * (`需要授权`) and pending questions (`需要输入`).
 */
export function homeInboxSessions(
  sessions: Record<string, SessionInfo> | undefined,
): SessionInfo[] {
  return Object.values(sessions ?? {})
    .filter((session) => session.archived !== true)
    .filter(
      (session) =>
        session.status === "waiting_approval" ||
        session.status === "waiting_input" ||
        (session.pendingPermissions ?? 0) > 0 ||
        (session.pendingQuestions ?? 0) > 0,
    )
    .sort((left, right) => {
      const leftPending = (left.pendingPermissions ?? 0) + (left.pendingQuestions ?? 0);
      const rightPending = (right.pendingPermissions ?? 0) + (right.pendingQuestions ?? 0);
      return (
        rightPending - leftPending ||
        right.createdAt - left.createdAt ||
        right.id.localeCompare(left.id)
      );
    });
}

export function inboxReasonLabel(session: SessionInfo): string {
  const perms = session.pendingPermissions ?? 0;
  const questions = session.pendingQuestions ?? 0;
  if (perms > 0) return `${String(perms)} 项需要授权`;
  if (session.status === "waiting_approval") return "需要授权";
  if (questions > 0) return `${String(questions)} 项需要输入`;
  if (session.status === "waiting_input") return "需要输入";
  return "等待处理";
}

/** Mirrors Desktop `sessionSearchText` + `filterSessionsByQuery`. */
export function filterMobileSessionsByQuery(
  sessions: Record<string, SessionInfo> | undefined,
  query: string,
): SessionInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return Object.values(sessions ?? {})
    .filter((session) =>
      [session.title, session.preview, session.agent, session.status, session.cwd]
        .filter((part): part is string => typeof part === "string")
        .join(" ")
        .toLowerCase()
        .includes(q),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Mirrors Desktop `sortSidebarSessions` priority: attention > running > pinned > recent. */
export function sortWorkspaceSessions(
  sessions: readonly SessionInfo[],
  pinnedIds: ReadonlySet<string>,
): SessionInfo[] {
  const priority = (s: SessionInfo): number => {
    if (
      (s.pendingPermissions ?? 0) + (s.pendingQuestions ?? 0) > 0 ||
      s.status === "waiting_approval" ||
      s.status === "waiting_input"
    ) {
      return 4;
    }
    if (s.status === "running" || s.status === "starting") return 2;
    if (pinnedIds.has(s.id)) return 1;
    return 0;
  };
  return [...sessions].sort(
    (a, b) => priority(b) - priority(a) || b.createdAt - a.createdAt,
  );
}

export interface AlignedWorkspaceTree {
  workspaces: SessionProject[];
  childTaskWorkspacesByKey: Map<string, SessionProject[]>;
  orphanTaskWorkspaces: SessionProject[];
}

/**
 * Mirrors Desktop `groupManagedWorkspaces` + saved/pinned projects:
 * - Includes saved empty workspaces (`savedPaths`) so added workspaces persist with 0 sessions.
 * - Attaches orchestration worktree workspaces (`worktreeAssets`) under their parent `repo` workspace.
 * - Sorts pinned workspaces first, then by `"recent"` or `"name"`.
 */
export function buildAlignedWorkspaceTree({
  projects,
  savedPaths = [],
  pinnedPaths = [],
  worktreeAssets = [],
  managedPaths = [],
  sortMode = "recent",
  displayNameFor,
}: {
  projects: readonly SessionProject[];
  savedPaths?: readonly string[];
  pinnedPaths?: readonly string[];
  worktreeAssets?: readonly Pick<OrchestrationWorktreeAsset, "path" | "repo" | "kind">[];
  managedPaths?: readonly string[];
  sortMode?: WorkspaceSortMode;
  displayNameFor: (path: string, fallback: string) => string;
}): AlignedWorkspaceTree {
  const assetRepoByKey = new Map<string, string>();
  for (const asset of worktreeAssets) {
    if (!asset.path || !asset.repo) continue;
    if (asset.kind !== undefined && asset.kind !== "run" && asset.kind !== "worker") continue;
    assetRepoByKey.set(workspacePathKey(asset.path), asset.repo);
  }
  const fallbackManagedSet = new Set(managedPaths.map(workspacePathKey).filter(Boolean));

  const ordinaryMap = new Map<string, SessionProject>();
  const taskProjects: { project: SessionProject; repoKey: string | null }[] = [];

  for (const project of projects) {
    const key = workspacePathKey(project.path);
    const repo = assetRepoByKey.get(key);
    if (repo && workspacePathKey(repo) !== key) {
      taskProjects.push({ project, repoKey: workspacePathKey(repo) });
    } else if (fallbackManagedSet.has(key)) {
      taskProjects.push({ project, repoKey: null });
    } else {
      ordinaryMap.set(key, project);
    }
  }

  for (const saved of savedPaths) {
    const normalized = normalizeWorkspacePath(saved);
    const key = workspacePathKey(normalized);
    if (!key || ordinaryMap.has(key) || assetRepoByKey.has(key) || fallbackManagedSet.has(key)) {
      continue;
    }
    ordinaryMap.set(key, {
      path: normalized,
      name: projectName(normalized),
      sessions: [],
      runningCount: 0,
      pendingCount: 0,
    });
  }

  const childTaskWorkspacesByKey = new Map<string, SessionProject[]>();
  const orphanTaskWorkspaces: SessionProject[] = [];
  for (const entry of taskProjects) {
    if (!entry.repoKey) {
      orphanTaskWorkspaces.push(entry.project);
      continue;
    }
    // Walk transitive worktree chains up to 4 hops just like Desktop `groupManagedWorkspaces`.
    let targetRepoKey = entry.repoKey;
    let hops = 0;
    while (assetRepoByKey.has(targetRepoKey) && hops < 4) {
      const next = workspacePathKey(assetRepoByKey.get(targetRepoKey)!);
      if (next === targetRepoKey) break;
      targetRepoKey = next;
      hops += 1;
    }
    if (ordinaryMap.has(targetRepoKey)) {
      const list = childTaskWorkspacesByKey.get(targetRepoKey) ?? [];
      list.push(entry.project);
      childTaskWorkspacesByKey.set(targetRepoKey, list);
    } else {
      orphanTaskWorkspaces.push(entry.project);
    }
  }

  const pinnedSet = new Set(pinnedPaths.map(workspacePathKey));
  const list = [...ordinaryMap.values()];
  const latestActivity = (project: SessionProject): number => {
    const ownLatest = project.sessions.reduce((max, s) => Math.max(max, s.createdAt), 0);
    const childLatest = (childTaskWorkspacesByKey.get(workspacePathKey(project.path)) ?? []).reduce(
      (max, child) => Math.max(max, child.sessions.reduce((m, s) => Math.max(m, s.createdAt), 0)),
      0,
    );
    return Math.max(ownLatest, childLatest);
  };

  list.sort((left, right) => {
    const leftPinned = pinnedSet.has(workspacePathKey(left.path)) ? 1 : 0;
    const rightPinned = pinnedSet.has(workspacePathKey(right.path)) ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    if (sortMode === "name") {
      return displayNameFor(left.path, left.name).localeCompare(
        displayNameFor(right.path, right.name),
        "zh-Hans-CN",
      );
    }
    const leftActive = left.pendingCount > 0 ? 2 : left.runningCount > 0 ? 1 : 0;
    const rightActive = right.pendingCount > 0 ? 2 : right.runningCount > 0 ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;
    return latestActivity(right) - latestActivity(left);
  });

  return {
    workspaces: list,
    childTaskWorkspacesByKey,
    orphanTaskWorkspaces,
  };
}
