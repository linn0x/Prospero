import { createElement, forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@prospero/protocol";
import { KeyBar } from "../src/components/KeyBar";
import { Terminal, type TerminalHandle } from "../src/components/Terminal";
import TerminalsScreen from "../src/app/host/[hostId]/terminals";
import { Emitter } from "../src/lib/emitter";
import type { ConnEvents, HostConnection } from "../src/lib/connection";

const nav = vi.hoisted(() => {
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return {
    push: vi.fn(),
    params: { hostId: "mac" } as { hostId: string; cwd?: string },
  };
});
const bridge = vi.hoisted(() => ({ post: vi.fn() }));
const mockHostConn = vi.hoisted(() => ({
  host: { id: "mac", name: "MacBook Pro" },
  conn: null as Record<string, unknown> | null,
  runtime: {
    status: "connected" as const,
    sessionsLoaded: true,
    lastError: null as string | null,
    hostInfo: { hostname: "mac", platform: "darwin", arch: "arm64", capabilities: [] as string[] },
    sessions: {} as Record<string, SessionInfo>,
  },
}));

vi.mock("expo-crypto", () => ({ randomUUID: () => "uuid-1" }));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  isAvailableAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const component = (name: string) => (props: { children?: ReactNode }) => el(name, props, props.children);
  return {
    View: component("div"),
    Text: component("span"),
    TextInput: forwardRef((props: { children?: ReactNode }, _ref) => el("input", props, props.children)),
    Pressable: component("button"),
    ScrollView: component("main"),
    ActivityIndicator: component("spinner"),
    FlatList: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
    }: {
      data: SessionInfo[];
      renderItem: (info: { item: SessionInfo }) => ReactNode;
      ListHeaderComponent?: ReactNode;
      ListEmptyComponent?: ReactNode;
    }) =>
      el(
        "section",
        {},
        ListHeaderComponent,
        data.length > 0
          ? data.map((item) => el("article", { key: item.id }, renderItem({ item })))
          : ListEmptyComponent,
      ),
    Platform: { OS: "android", select: (opts: Record<string, unknown>) => opts.android ?? opts.default },
    PlatformColor: (name: string) => name,
    DynamicColorIOS: () => "ios",
    Appearance: { getColorScheme: () => "dark", setColorScheme: vi.fn() },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFill: {} },
  };
});

vi.mock("react-native-webview", () => ({
  WebView: forwardRef((_props: unknown, ref) => {
    useImperativeHandle(ref, () => ({ postMessage: bridge.post }));
    return createElement("webview", _props as object);
  }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 16, left: 0, right: 0 }),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  router: { push: nav.push },
  useLocalSearchParams: () => nav.params,
  useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
}));
vi.mock("expo-clipboard", () => ({
  getStringAsync: vi.fn(async () => "pasted"),
  setStringAsync: vi.fn(async () => true),
}));
vi.mock("expo-haptics", () => ({
  selectionAsync: vi.fn(async () => {}),
  impactAsync: vi.fn(async () => {}),
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("@/components/Toast", () => ({ toast: vi.fn() }));
vi.mock("../src/components/Icon", () => ({ Icon: () => null }));
vi.mock("../src/components/Sheet", () => ({
  Sheet: ({ visible, children }: { visible: boolean; children?: ReactNode }) =>
    visible ? createElement("dialog", {}, children) : null,
}));
vi.mock("../src/components/WorkspacePicker", () => ({
  WorkspacePicker: ({
    visible,
    onSelect,
  }: {
    visible: boolean;
    onSelect: (sel: { cwd: string }) => void;
  }) =>
    visible
      ? createElement(
          "button",
          {
            accessibilityLabel: "确认选择目录",
            onPress: () => onSelect({ cwd: "/Users/bytedance/SelectedDir" }),
          },
          "pick",
        )
      : null,
}));
vi.mock("../src/lib/use-host-connection", () => ({
  useHostConnection: () => mockHostConn,
}));
vi.mock("../src/lib/workspace-concepts", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/workspace-concepts")>(
    "../src/lib/workspace-concepts",
  );
  return {
    ...actual,
    useHydratedWorkspaceConcepts: () => ({
      savedWorkspaces: { mac: ["/Users/bytedance/Prospero"] },
      pinnedWorkspaces: {},
      pinnedSessions: {},
      workspaceSort: "recent" as const,
    }),
  };
});
vi.mock("@/lib/outbound-queue", () => import("../src/lib/outbound-queue"));
vi.mock("@/lib/terminal-font-size", () => import("../src/lib/terminal-font-size"));
vi.mock("@/lib/focused-session-stream", () => import("../src/lib/focused-session-stream"));
vi.mock("@/lib/theme", () => import("../src/lib/theme"));
vi.mock("../src/components/terminal-html", () => ({
  TERMINAL_HTML: "<html></html>",
  TERMINAL_FONT_FAMILY: "Mono",
}));
vi.mock("@/lib/use-focused-session-effect", () => ({
  useFocusedSessionEffect: (effect: () => () => void) => useEffect(effect, [effect]),
}));

let tree: ReactTestRenderer | undefined;
afterEach(async () => {
  if (tree) await act(async () => tree!.unmount());
  tree = undefined;
  nav.push.mockClear();
  nav.params = { hostId: "mac" };
  bridge.post.mockClear();
  vi.useRealTimers();
});

describe("TerminalsScreen creation and workspace chips", () => {
  it("resolves home directory inline on immediate create without opening WorkspacePicker", async () => {
    let resolveListing!: (val: { type: "workspace.listing"; path: string; cwd: string; entries: [] }) => void;
    const workspaceList = vi.fn(
      () =>
        new Promise<{ type: "workspace.listing"; path: string; cwd: string; entries: [] }>((res) => {
          resolveListing = res;
        }),
    );
    const createdShell: SessionInfo = {
      id: "shell-new",
      agent: "shell",
      kind: "pty",
      cwd: "/Users/bytedance",
      title: "zsh",
      cols: 80,
      rows: 24,
      status: "running",
      createdAt: 100,
    };
    const createSessionTracked = vi.fn(() => ({
      requestId: "req-1",
      delivery: { accepted: true as const, disposition: "sent" as const },
      completion: Promise.resolve(createdShell),
      cancel: vi.fn(),
    }));
    mockHostConn.conn = {
      host: { id: "mac" },
      workspaceList,
      createSessionTracked,
      restartTerminal: vi.fn(),
      deleteTerminal: vi.fn(),
    };

    await act(async () => {
      tree = create(createElement(TerminalsScreen));
    });

    const createBtn = tree!.root
      .findAllByType("button")
      .find((node) => node.props.accessibilityLabel === "新建终端")!;
    expect(createBtn).toBeDefined();

    // Tap "新建终端" BEFORE initial homeCwd focus query finishes
    await act(async () => {
      createBtn.props.onPress();
    });

    // Picker must NOT have popped open prematurely
    expect(
      tree!.root.findAllByType("button").find((n) => n.props.accessibilityLabel === "确认选择目录"),
    ).toBeUndefined();

    await act(async () => {
      resolveListing({ type: "workspace.listing", path: "", cwd: "/Users/bytedance", entries: [] });
    });

    expect(createSessionTracked).toHaveBeenCalledWith("shell", "/Users/bytedance", undefined, "pty");
    expect(nav.push).toHaveBeenCalledWith("/host/mac/session/shell-new");
  });

  it("allows selecting a saved workspace chip and creating a terminal in that workspace", async () => {
    const createdShell: SessionInfo = {
      id: "shell-ws",
      agent: "shell",
      kind: "pty",
      cwd: "/Users/bytedance/Prospero",
      title: "Prospero",
      cols: 80,
      rows: 24,
      status: "running",
      createdAt: 101,
    };
    const createSessionTracked = vi.fn(() => ({
      requestId: "req-2",
      delivery: { accepted: true as const, disposition: "sent" as const },
      completion: Promise.resolve(createdShell),
      cancel: vi.fn(),
    }));
    mockHostConn.conn = {
      host: { id: "mac" },
      workspaceList: vi.fn().mockResolvedValue({
        type: "workspace.listing",
        path: "",
        cwd: "/Users/bytedance",
        entries: [],
      }),
      createSessionTracked,
      restartTerminal: vi.fn(),
      deleteTerminal: vi.fn(),
    };

    await act(async () => {
      tree = create(createElement(TerminalsScreen));
    });

    const wsChip = tree!.root
      .findAllByType("button")
      .find((node) => node.props.accessibilityLabel === "工作区 Prospero")!;
    expect(wsChip).toBeDefined();

    await act(async () => {
      wsChip.props.onPress();
    });

    const createBtn = tree!.root
      .findAllByType("button")
      .find((node) => node.props.accessibilityLabel === "新建终端")!;
    await act(async () => {
      createBtn.props.onPress();
    });

    expect(createSessionTracked).toHaveBeenCalledWith(
      "shell",
      "/Users/bytedance/Prospero",
      undefined,
      "pty",
    );
    expect(nav.push).toHaveBeenCalledWith("/host/mac/session/shell-ws");
  });
});

describe("Mobile TUI KeyBar & Terminal enhancements", () => {
  it("supports Shift+Tab mode toggle, native IME composer bar, 88-col wide mode, and text extraction", async () => {
    const onKey = vi.fn(() => ({ accepted: true as const, disposition: "sent" as const }));
    const onShortcut = vi.fn(() => ({ accepted: true as const, disposition: "sent" as const }));
    const onSendText = vi.fn(async () => ({ accepted: true as const, disposition: "sent" as const }));
    const onExtractText = vi.fn();
    const onToggleWideCols = vi.fn();

    await act(async () => {
      tree = create(
        createElement(KeyBar, {
          onKey,
          onShortcut,
          onPaste: async () => ({ accepted: true as const, disposition: "sent" as const }),
          onSendText,
          onExtractText,
          onToggleWideCols,
          modifiers: { ctrl: false, option: false },
          onToggleModifier: vi.fn(),
        }),
      );
    });

    const findButton = (label: string) =>
      tree!.root.findAllByType("button").find((node) => node.props.accessibilityLabel === label);

    await act(async () => {
      findButton("Shift Tab 切换模式")!.props.onPress();
    });
    expect(onShortcut).toHaveBeenCalledWith("\x1b[Z");

    await act(async () => {
      findButton("提取终端文字与链接")!.props.onPress();
    });
    expect(onExtractText).toHaveBeenCalledTimes(1);

    // Native IME composer bar is open by default when onSendText is provided!
    expect(findButton("收起命令输入栏")).toBeDefined();
    const input = tree!.root.findByType("input");
    await act(async () => {
      input.props.onChangeText("帮我检查当前分支的测试");
    });
    await act(async () => {
      await findButton("发送到终端并执行")!.props.onPress();
    });
    expect(onSendText).toHaveBeenCalledWith("帮我检查当前分支的测试", true);

    // Esc cancel button right next to composer sends \x1b immediately
    await act(async () => {
      findButton("发送 Esc 中断或取消")!.props.onPress();
    });
    expect(onShortcut).toHaveBeenCalledWith("\x1b");

    // Expand secondary tools and toggle 88-col wide mode
    await act(async () => {
      findButton("展开终端工具")!.props.onPress();
    });
    await act(async () => {
      findButton("开启 88 列宽屏适配")!.props.onPress();
    });
    expect(onToggleWideCols).toHaveBeenCalledTimes(1);
  });

  it("bridges wideCols and extractText over WebGL xterm WebView", async () => {
    vi.useFakeTimers();
    const events = new Emitter<ConnEvents>();
    const conn = {
      host: { id: "mac" },
      events,
      isConnected: true,
      supportsTerminalTailAttach: true,
      attach: vi.fn(),
      resize: vi.fn(),
      detach: vi.fn(),
      ack: vi.fn(),
      inputB64: vi.fn(),
    };
    let handle: TerminalHandle | null = null;
    await act(async () => {
      tree = create(
        createElement(Terminal, {
          ref: (instance) => {
            handle = instance;
          },
          conn: conn as unknown as HostConnection,
          sid: "tui-1",
          fontSize: 11,
          wideCols: 88,
        }),
      );
    });

    const onMessage = tree!.root.findByType("webview").props.onMessage;
    await act(async () => {
      onMessage({ nativeEvent: { data: JSON.stringify({ kind: "ready" }) } });
      onMessage({ nativeEvent: { data: JSON.stringify({ kind: "resized", cols: 88, rows: 30 }) } });
      await vi.runAllTimersAsync();
    });
    // Must always request full snapshot (2 args, no tailEvents) so scrollback history & modes survive
    expect(conn.attach).toHaveBeenCalledWith("tui-1", undefined);
    expect(
      bridge.post.mock.calls.some(([payload]) => String(payload).includes('"wideCols"') && String(payload).includes("88")),
    ).toBe(true);

    let extractedPromise!: Promise<{ viewport: string; full: string; urls: string[] }>;
    await act(async () => {
      extractedPromise = handle!.extractText();
      await vi.advanceTimersByTimeAsync(10);
    });
    const lastBatch = JSON.parse(String(bridge.post.mock.calls.at(-1)?.[0] ?? "[]")) as {
      kind: string;
      requestId?: number;
    }[];
    const extractMsg = lastBatch.find((item) => item.kind === "extractText")!;
    expect(extractMsg).toBeDefined();

    await act(async () => {
      onMessage({
        nativeEvent: {
          data: JSON.stringify({
            kind: "extractedText",
            requestId: extractMsg.requestId,
            viewport: "Open https://example.com/oauth/device?code=1234",
            full: "Open https://example.com/oauth/device?code=1234",
            urls: ["https://example.com/oauth/device?code=1234"],
          }),
        },
      });
    });

    await expect(extractedPromise).resolves.toEqual({
      viewport: "Open https://example.com/oauth/device?code=1234",
      full: "Open https://example.com/oauth/device?code=1234",
      urls: ["https://example.com/oauth/device?code=1234"],
    });
  });
});
