import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HostScreen from "../src/app/host/[hostId]/index";

const fixture = vi.hoisted(() => {
  const accounts = [{ id: "claude-main", agent: "claude", name: "本机 Claude", managed: false, isDefault: true, status: "signed_in", createdAt: 1, updatedAt: 1, activeSessions: 0,
    capabilities: { sessionKinds: ["pty", "structured"], plan: true, resume: false, modelSelection: false, reasoningEffort: false } },
    { id: "codex-api", agent: "codex", engine: "codex", name: "电脑 API", managed: true, isDefault: true, status: "signed_in", createdAt: 1, updatedAt: 1, activeSessions: 0,
      apiProfile: { provider: "openai_compatible", protocol: "openai_responses", baseUrl: "http://127.0.0.1:8317/v1", model: "test-model" },
      capabilities: { sessionKinds: ["pty", "structured"], plan: true, resume: false, modelSelection: false, reasoningEffort: false } }];
  return {
    snapshot: vi.fn(() => null),
    params: { hostId: "host", quickCreate: "conversation", cwd: undefined as string | undefined },
    runtime: { status: "connected", sessions: {}, hostInfo: { platform: "darwin", capabilities: ["terminal.remote.v1", "agent.accounts.v1"] }, rttMs: 1, sessionsLoaded: true },
    connection: { supportsAgentAccounts: true, supportsModelSources: false, supportsCapability: () => true, supportsSessionCreateModel: true,
      agentAccounts: vi.fn(async () => accounts), launchModels: vi.fn(async () => ({ models: [] })), events: { on: () => () => {} },
      modelSourceAction: vi.fn(),
      createSessionTracked: vi.fn(() => ({ delivery: { accepted: true, disposition: "sent" }, completion: new Promise(() => {}), cancel: vi.fn() })),
    },
  };
});
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const native = (tag: string) => (props: { children?: ReactNode }) => el(tag, props, props.children);
  return { View: native("div"), Text: native("span"), Pressable: native("button"), TextInput: native("input"), ScrollView: native("main"), FlatList: native("ul"), KeyboardAvoidingView: native("article"), RefreshControl: () => null, ActivityIndicator: () => null,
    Platform: { OS: "android" }, useWindowDimensions: () => ({ width: 390, height: 844 }), StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 }, AppState: { addEventListener: () => ({ remove() {} }) } };
});
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return { Stack: { Screen: () => null }, router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() }, useLocalSearchParams: () => fixture.params, useIsFocused: () => true, useFocusEffect: (effect: () => (() => void) | undefined) => useEffect(effect, [effect]) };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0, top: 0 }) }));
vi.mock("@/lib/use-host-connection", () => ({ useHostConnection: () => ({ host: { id: "host", name: "电脑" }, conn: fixture.connection, runtime: fixture.runtime }) }));
vi.mock("@/lib/use-orchestration-snapshot", () => ({ useOrchestrationSnapshot: fixture.snapshot }));
vi.mock("@/lib/adaptive-layout", () => ({ useAdaptiveLayout: () => ({ width: 390, height: 844, verticalPanes: null }) }));
vi.mock("@/lib/session-preferences", () => ({ getSessionPreferences: async () => ({ archivedSessionIds: [], hiddenSessionIds: [], collapsedProjects: [] }), setProjectCollapsed: vi.fn(), setSessionHidden: vi.fn() }));
vi.mock("@/lib/workspace-order-preferences", () => ({ useOrderedWorkspaces: (_id: string, projects: unknown[]) => projects }));
vi.mock("@/lib/store", () => ({ sortSessions: (sessions: object) => Object.values(sessions) }));
vi.mock("@/lib/connection", () => ({ SessionCreateError: class extends Error {} }));
vi.mock("@/lib/theme", () => ({ color: {}, statusColor: {}, font: {}, radius: {}, space: {}, useMobileTheme: () => ({ palette: {} }) }));
vi.mock("@/components/AgentIcon", () => ({ AgentIcon: () => null }));
vi.mock("@/components/Icon", () => ({ Icon: () => null }));
vi.mock("@/components/HostSummary", () => ({ HostSummary: () => null }));
vi.mock("@/components/SessionCreateProgress", () => ({ SessionCreateProgress: () => null }));
vi.mock("@/components/SessionLifecycleSheet", () => ({ SessionLifecycleSheet: () => null }));
vi.mock("@/components/SwipeRow", () => ({ SwipeRow: () => null }));
vi.mock("@/components/WorkspaceDisclosure", () => ({ WorkspaceFolderIcon: () => null }));
vi.mock("@/components/WorkspacePicker", () => ({ WorkspacePicker: ({ visible }: { visible: boolean }) => visible ? createElement("dialog") : null }));
vi.mock("@/components/Sheet", () => ({ Sheet: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? createElement("aside", {}, children) : null, SheetAction: () => null }));
vi.mock("@/lib/session-launch-selection", () => import("../src/lib/session-launch-selection"));
vi.mock("@/lib/host-screen-flow", () => import("../src/lib/host-screen-flow"));
vi.mock("@/lib/terminal-session", () => import("../src/lib/terminal-session"));
vi.mock("@/lib/session-projects", () => import("../src/lib/session-projects"));
vi.mock("@/lib/host-session-list", () => import("../src/lib/host-session-list"));
vi.mock("@/lib/orchestration-overview", () => import("../src/lib/orchestration-overview"));
vi.mock("@/components/SessionAccountSelect", () => import("../src/components/SessionAccountSelect"));
vi.mock("@/components/SessionModelSourceSelect", () => import("../src/components/SessionModelSourceSelect"));
vi.mock("@/lib/session-model-sources", () => import("../src/lib/session-model-sources"));
vi.mock("../src/components/Icon", () => ({ Icon: () => null }));
vi.mock("../src/components/Sheet", () => ({ Sheet: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? createElement("aside", {}, children) : null }));
let tree: ReactTestRenderer | undefined;
beforeEach(() => { vi.useFakeTimers(); fixture.params.quickCreate = "conversation"; fixture.params.cwd = undefined; fixture.connection.supportsModelSources = false; fixture.connection.modelSourceAction.mockReset(); fixture.connection.createSessionTracked.mockClear(); fixture.connection.launchModels.mockClear(); fixture.snapshot.mockClear(); });
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; vi.useRealTimers(); });
async function open() {
  await act(async () => { tree = create(createElement(HostScreen)); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  return tree!;
}
const findButton = (root: ReactTestRenderer, label: string) => root.root.findAllByType("button").find(node => node.props.accessibilityLabel === label)!;

describe("new conversation entry", () => {
  it("shows account and terminal controls immediately without a directory modal covering them", async () => {
    const view = await open();
    expect(fixture.snapshot.mock.calls.every(args => (args as unknown[])[0] === null)).toBe(true);
    expect(view.root.findAllByType("dialog")).toHaveLength(0);
    expect(findButton(view, "选择账号或 API")).toBeDefined();
    expect(findButton(view, "创建终端会话")).toBeDefined();
  });

  it("waits for the computer account selection before requesting a model catalog", async () => {
    fixture.connection.agentAccounts.mockImplementationOnce(() => new Promise<never>(() => {}));
    await open();
    expect(fixture.connection.launchModels).not.toHaveBeenCalled();
  });

  it("still opens directory browsing for an explicit new-directory action", async () => {
    fixture.params.quickCreate = "directory";
    const view = await open();
    expect(view.root.findAllByType("dialog")).toHaveLength(1);
  });

  it("defaults Codex terminal launches to bypass while allowing a stricter policy", async () => {
    fixture.params.cwd = "/work";
    const view = await open();
    await act(async () => findButton(view, "创建终端会话").props.onPress());
    await act(async () => findButton(view, "选择账号或 API").props.onPress());
    const account = view.root.findAllByType("button").find(node => node.props.accessibilityRole === "radio" && node.props.accessibilityLabel.startsWith("电脑 API"))!;
    await act(async () => account.props.onPress());
    expect(findButton(view, "审批策略：YOLO").props.accessibilityState.checked).toBe(true);
    await act(async () => findButton(view, "审批策略：逐条").props.onPress());
    const label = view.root.findAllByType("span").find(node => node.children.includes("新建会话"))!;
    let submit = label.parent;
    while (submit && submit.type !== "button") submit = submit.parent;
    await act(async () => submit!.props.onPress());
    expect(fixture.connection.createSessionTracked).toHaveBeenCalledWith("codex", "/work", undefined, "pty", 80, 24, { accountId: "codex-api", approvalPolicy: "strict" });
  });

  it.each(["claude", "codex"])("launches a %s terminal with bypass by default", async (agent) => {
    fixture.params.cwd = "/work";
    const view = await open();
    await act(async () => findButton(view, "创建终端会话").props.onPress());
    if (agent === "codex") {
      await act(async () => findButton(view, "选择账号或 API").props.onPress());
      const account = view.root.findAllByType("button").find(node => node.props.accessibilityRole === "radio" && node.props.accessibilityLabel.startsWith("电脑 API"))!;
      await act(async () => account.props.onPress());
    }
    expect(findButton(view, "审批策略：YOLO").props.accessibilityState.checked).toBe(true);
    const label = view.root.findAllByType("span").find(node => node.children.includes("新建会话"))!;
    let submit = label.parent;
    while (submit && submit.type !== "button") submit = submit.parent;
    await act(async () => submit!.props.onPress());
    expect(fixture.connection.createSessionTracked).toHaveBeenCalledWith(agent, "/work", undefined, "pty", 80, 24, { accountId: agent === "claude" ? "claude-main" : "codex-api", approvalPolicy: "yolo" });
  });

  it("keeps the structured Claude default separate from the terminal default", async () => {
    fixture.params.cwd = "/work";
    const view = await open();
    expect(findButton(view, "审批策略：逐条").props.accessibilityState.checked).toBe(true);
    await act(async () => findButton(view, "创建终端会话").props.onPress());
    expect(findButton(view, "审批策略：YOLO").props.accessibilityState.checked).toBe(true);
    await act(async () => findButton(view, "创建对话会话").props.onPress());
    expect(findButton(view, "审批策略：逐条").props.accessibilityState.checked).toBe(true);
  });

  it("selects a model beyond the first eight source routes and launches its bound terminal account", async () => {
    fixture.params.cwd = "/work";
    fixture.connection.supportsModelSources = true;
    const source = { id: "source-1", name: "TRAE Queue", revision: 4, enabled: true,
      endpoints: [{ protocol: "openai_responses", baseUrl: "http://127.0.0.1:8321/v1" }],
      credentials: [{ id: "credential-1", name: "Default", revision: 1 }],
      routes: Array.from({ length: 35 }, (_, index) => ({ id: `route-${index}`, name: `Model ${index}`, model: `model-${index}`, protocol: "openai_responses", credentialId: "credential-1", enabled: true })), createdAt: 1, updatedAt: 1 };
    const bound = { id: "source-account", agent: "codex", engine: "codex", name: "TRAE Queue / Model 34", managed: true, isDefault: false, status: "signed_in", createdAt: 1, updatedAt: 1, activeSessions: 0,
      apiProfile: { provider: "openai_compatible", protocol: "openai_responses", baseUrl: "http://127.0.0.1:8321/v1", model: "model-34" },
      capabilities: { sessionKinds: ["pty", "structured"], plan: true, resume: true, modelSelection: false, reasoningEffort: false } };
    fixture.connection.modelSourceAction.mockImplementation(async (action: { kind: string }) => action.kind === "list"
      ? { ok: true, sources: [source] }
      : { ok: true, accountId: bound.id, accounts: [bound], sources: [source] });
    const view = await open();
    await act(async () => findButton(view, "创建终端会话").props.onPress());
    await act(async () => findButton(view, "从模型源选择模型").props.onPress());
    await act(async () => findButton(view, "模型源 TRAE Queue，35 个已启用模型").props.onPress());
    const search = view.root.findAllByType("input").find(node => node.props.accessibilityLabel === "搜索模型源中的模型")!;
    await act(async () => search.props.onChangeText("model-34"));
    await act(async () => findButton(view, "选择模型 Model 34，model-34").props.onPress());
    expect(fixture.connection.modelSourceAction).toHaveBeenCalledWith({ kind: "bind", sourceId: "source-1", revision: 4, routeId: "route-34", agent: "codex" });
    const label = view.root.findAllByType("span").find(node => node.children.includes("新建会话"))!;
    let submit = label.parent;
    while (submit && submit.type !== "button") submit = submit.parent;
    await act(async () => submit!.props.onPress());
    expect(fixture.connection.createSessionTracked).toHaveBeenCalledWith("codex", "/work", undefined, "pty", 80, 24, { accountId: "source-account", approvalPolicy: "yolo" });
  });

  it("enables a new catalog model and binds the new source revision before creating a terminal", async () => {
    fixture.params.cwd = "/work";
    fixture.connection.supportsModelSources = true;
    const existingRoute = { id: "route-old", name: "Old", model: "old", protocol: "openai_responses", credentialId: "key", enabled: true };
    const source = { id: "source-1", name: "TRAE Queue", revision: 4, enabled: true,
      endpoints: [{ protocol: "openai_responses", baseUrl: "http://127.0.0.1:8321/v1" }], credentials: [{ id: "key", name: "Default", revision: 1 }],
      routes: [existingRoute], createdAt: 1, updatedAt: 1 };
    const newRoute = { id: "route-new", name: "New model", model: "new-model", protocol: "openai_responses", credentialId: "key", enabled: true };
    const updated = { ...source, revision: 5, routes: [existingRoute, newRoute] };
    const bound = { id: "new-account", agent: "codex", engine: "codex", name: "TRAE Queue / New model", managed: true, isDefault: false, status: "signed_in", createdAt: 1, updatedAt: 1, activeSessions: 0,
      apiProfile: { provider: "openai_compatible", protocol: "openai_responses", baseUrl: "http://127.0.0.1:8321/v1", model: "new-model" },
      capabilities: { sessionKinds: ["pty", "structured"], plan: true, resume: true, modelSelection: false, reasoningEffort: false } };
    fixture.connection.modelSourceAction.mockImplementation(async (action: { kind: string }) => {
      if (action.kind === "list") return { ok: true, sources: [source] };
      if (action.kind === "models") return { ok: true, models: [{ id: "new-model", label: "New model" }] };
      if (action.kind === "routes.set") return { ok: true, sources: [updated] };
      return { ok: true, accountId: bound.id, accounts: [bound], sources: [updated] };
    });
    const view = await open();
    await act(async () => findButton(view, "创建终端会话").props.onPress());
    await act(async () => findButton(view, "从模型源选择模型").props.onPress());
    await act(async () => findButton(view, "模型源 TRAE Queue，1 个已启用模型").props.onPress());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => findButton(view, "选择并启用模型 New model，new-model").props.onPress());
    expect(fixture.connection.modelSourceAction).toHaveBeenCalledWith({ kind: "routes.set", sourceId: "source-1", revision: 4,
      routes: [{ name: "New model", model: "new-model", protocol: "openai_responses", credentialId: "key", enabled: true }] });
    expect(fixture.connection.modelSourceAction).toHaveBeenCalledWith({ kind: "bind", sourceId: "source-1", revision: 5, routeId: "route-new", agent: "codex" });
    const label = view.root.findAllByType("span").find(node => node.children.includes("新建会话"))!;
    let submit = label.parent;
    while (submit && submit.type !== "button") submit = submit.parent;
    await act(async () => submit!.props.onPress());
    expect(fixture.connection.createSessionTracked).toHaveBeenCalledWith("codex", "/work", undefined, "pty", 80, 24, { accountId: "new-account", approvalPolicy: "yolo" });
  });
});
