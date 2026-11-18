import { describe, expect, it } from "vitest";
import type { AgentAccount, ModelSource, SessionInfo } from "@prospero/protocol";
import {
  buildAlignedWorkspaceTree,
  createWorkspaceConceptsStore,
  desktopSidebarSessionLabel,
  filterMobileSessionsByQuery,
  homeInboxSessions,
  inboxReasonLabel,
  sessionWorkbenchSubtitle,
  sidebarSessionRowDisplay,
  sortWorkspaceSessions,
} from "../src/lib/workspace-concepts";
import {
  defaultModelSourceRoute,
  resolveBoundModelSource,
  sourceRouteLabel,
} from "../src/lib/session-model-sources";

function makeSession(
  id: string,
  cwd: string,
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    id,
    agent: "codex",
    kind: "structured",
    title: id,
    cwd,
    status: "idle",
    createdAt: 10,
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

describe("Desktop workspace & auth concept alignment", () => {
  it("strips redundant workspace names and agent prefixes in sidebar session labels", () => {
    expect(
      desktopSidebarSessionLabel(
        makeSession("s1", "/Users/dev/Prospero", { title: "codex · Prospero" }),
      ),
    ).toBe("Codex");
    expect(
      desktopSidebarSessionLabel(
        makeSession("s2", "/Users/dev/Prospero", { title: "修复侧栏拖拽 · Prospero" }),
      ),
    ).toBe("修复侧栏拖拽");
    expect(
      desktopSidebarSessionLabel(
        makeSession("s3", "/Users/dev/Prospero", { agent: "claude", title: "Claude Code · 对齐工作区概念" }),
      ),
    ).toBe("对齐工作区概念");
    expect(
      sidebarSessionRowDisplay(
        makeSession("abcd1234", "/Users/dev/Prospero", { title: "codex · Prospero", model: "openai/gpt-6.2-sol", createdAt: 0 }),
      ),
    ).toEqual({ title: "Codex · gpt-6.2-sol", meta: "" });
    expect(
      sidebarSessionRowDisplay(
        makeSession("85a51111", "/Users/dev/Prospero", { agent: "shell", kind: "pty", title: "shell", createdAt: 0 }),
        { folderLabel: "Prospero" },
      ),
    ).toEqual({ title: "Terminal · #85a5", meta: "Prospero" });
  });

  it("collects both approval and question sessions into Inbox just like Desktop", () => {
    const approval = makeSession("a", "/work/app", {
      status: "waiting_approval",
      pendingPermissions: 2,
      createdAt: 5,
    });
    const question = makeSession("q", "/work/app", {
      status: "waiting_input",
      pendingQuestions: 1,
      createdAt: 9,
    });
    const running = makeSession("r", "/work/app", { status: "running" });

    const inbox = homeInboxSessions({ a: approval, q: question, r: running });
    expect(inbox.map((s) => s.id)).toEqual(["a", "q"]);
    expect(inboxReasonLabel(approval)).toBe("2 项需要授权");
    expect(inboxReasonLabel(question)).toBe("1 项需要输入");
  });

  it("persists empty added workspaces, nests task worktrees under parent repos, and sorts pinned first", () => {
    const parentProject = {
      path: "/work/prospero",
      name: "prospero",
      sessions: [makeSession("main", "/work/prospero", { createdAt: 10 })],
      runningCount: 0,
      pendingCount: 0,
    };
    const worktreeProject = {
      path: "/work/.worktrees/prospero-task-1",
      name: "prospero-task-1",
      sessions: [makeSession("worker", "/work/.worktrees/prospero-task-1", { status: "running", createdAt: 20 })],
      runningCount: 1,
      pendingCount: 0,
    };
    const orphanWorktree = {
      path: "/work/.worktrees/external-run",
      name: "external-run",
      sessions: [makeSession("ext", "/work/.worktrees/external-run")],
      runningCount: 0,
      pendingCount: 0,
    };

    const tree = buildAlignedWorkspaceTree({
      projects: [parentProject, worktreeProject, orphanWorktree],
      savedPaths: ["/work/empty-alpha"],
      pinnedPaths: ["/work/empty-alpha"],
      worktreeAssets: [
        { path: "/work/.worktrees/prospero-task-1", repo: "/work/prospero", kind: "worker" },
        { path: "/work/.worktrees/external-run", repo: "/work/unlisted", kind: "run" },
      ],
      sortMode: "recent",
      displayNameFor: (_path, fallback) => fallback,
    });

    expect(tree.workspaces.map((w) => w.path)).toEqual([
      "/work/empty-alpha",
      "/work/prospero",
    ]);
    expect(tree.workspaces[0]?.sessions).toHaveLength(0);
    expect(tree.childTaskWorkspacesByKey.get("/work/prospero")?.map((w) => w.path)).toEqual([
      "/work/.worktrees/prospero-task-1",
    ]);
    expect(tree.orphanTaskWorkspaces.map((w) => w.path)).toEqual([
      "/work/.worktrees/external-run",
    ]);
  });

  it("persists saved/pinned workspaces, pinned sessions, and sort order in store", async () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: async (k: string) => memory.get(k) ?? null,
      setItem: async (k: string, v: string) => {
        memory.set(k, v);
      },
    };
    const store = createWorkspaceConceptsStore(storage);
    store.getState().addWorkspace("mac", "/Users/me/repo/");
    store.getState().togglePinWorkspace("mac", "/Users/me/repo");
    store.getState().togglePinSession("mac", "sid-1");
    store.getState().setWorkspaceSort("name");

    expect(store.getState().savedWorkspaces.mac).toEqual(["/Users/me/repo"]);
    expect(store.getState().pinnedWorkspaces.mac).toEqual(["/Users/me/repo"]);
    expect(store.getState().pinnedSessions.mac).toEqual(["sid-1"]);
    expect(store.getState().workspaceSort).toBe("name");

    const sorted = sortWorkspaceSessions(
      [
        makeSession("recent", "/r", { createdAt: 100 }),
        makeSession("sid-1", "/r", { createdAt: 1 }),
        makeSession("running", "/r", { status: "running", createdAt: 2 }),
      ],
      new Set(["sid-1"]),
    );
    expect(sorted.map((s) => s.id)).toEqual(["running", "sid-1", "recent"]);
    expect(filterMobileSessionsByQuery({ s: makeSession("s", "/Users/me/repo", { preview: "refactor auth" }) }, "auth")).toHaveLength(1);
  });

  it("resolves default and bound API model source routes and detects stale revisions", () => {
    const source: ModelSource = {
      id: "src-1",
      name: "Gateway",
      revision: 3,
      enabled: true,
      endpoints: [{ protocol: "openai_responses", baseUrl: "https://gw.example/v1" }],
      credentials: [{ id: "cred-1", name: "Main", revision: 1 }],
      routes: [
        { id: "r1", name: "GPT-5", model: "gpt-5", protocol: "openai_responses", credentialId: "cred-1", enabled: true },
        { id: "r2", name: "GPT-5 Pro", model: "gpt-5-pro", protocol: "openai_responses", credentialId: "cred-1", enabled: true },
      ],
      defaultRouteId: "r2",
      createdAt: 1,
      updatedAt: 2,
    };

    expect(sourceRouteLabel(source.routes[0]!)).toBe("GPT-5 · Codex");
    expect(defaultModelSourceRoute([source], "codex")?.route.id).toBe("r2");

    const boundAccount: AgentAccount = {
      id: "acc-bound",
      agent: "codex",
      engine: "codex",
      name: "Gateway / GPT-5",
      managed: true,
      isDefault: false,
      status: "signed_in",
      createdAt: 1,
      updatedAt: 1,
      activeSessions: 0,
      modelSource: {
        sourceId: "src-1",
        sourceName: "Gateway",
        routeId: "r1",
        routeName: "GPT-5",
        revision: 2,
        current: false,
        legacy: false,
      },
    };
    const resolved = resolveBoundModelSource([source], boundAccount, "codex");
    expect(resolved?.route.id).toBe("r1");
    expect(resolved?.staleRevision).toBe(true);
  });

  it("disambiguates identical default terminal titles in workbench subtitles", () => {
    const first = makeSession("a1b2c3d4", "/work/app", {
      agent: "codex",
      kind: "pty",
      title: "Codex",
      createdAt: new Date(2026, 10, 17, 18, 53).getTime(),
    });
    const withModel = makeSession("e5f6g7h8", "/work/app", {
      agent: "codex",
      kind: "pty",
      title: "Codex",
      model: "openai/gpt-6-astra",
      preview: "fix split pane",
      createdAt: new Date(2026, 10, 17, 19, 12).getTime(),
    });
    expect(sessionWorkbenchSubtitle(first)).toContain("TUI · #a1b2");
    expect(sessionWorkbenchSubtitle(withModel, { showWorkspace: "app" })).toContain("app · TUI · gpt-6-astra · fix split pane");
  });
});
