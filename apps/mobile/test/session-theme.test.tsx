import { createElement, memo, useEffect, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEventBody } from "@prospero/protocol";
import { MobileThemeContext, paletteForScheme, resolveThemeScheme, type ThemeMode, type ThemeScheme } from "../src/lib/theme";
import { ChatView } from "../src/components/ChatView";
import { QuickReplies } from "../src/components/QuickReplies";
import { CodeBlock } from "../src/components/CodeBlock";
import { MathFormula } from "../src/components/MathView";
import { Sheet, Row } from "../src/components/Sheet";

const stream = vi.hoisted(() => ({
  receive: null as ((events: AgentEventBody[]) => void) | null,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("react-native", async () => {
  const { createElement: el, memo } = await import("react");
  return {
    View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable",
    ScrollView: "ScrollView", Image: "Image", ActivityIndicator: "ActivityIndicator",
    Modal: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? el("Modal", {}, children) : null,
    // Like the native list, unchanged props skip renderItem. A theme switch must invalidate its closures.
    FlatList: memo(({ data, renderItem, ListEmptyComponent, ListHeaderComponent, ...props }: {
      data: { key: string }[]; renderItem: (item: { item: { key: string } }) => ReactNode;
      ListEmptyComponent: ReactNode; ListHeaderComponent: ReactNode;
    }) => el("FlatList", props, ListHeaderComponent, data.length
      ? data.map((item) => el("Cell", { key: item.key }, renderItem({ item })))
      : ListEmptyComponent)),
    StyleSheet: {
      create: (styles: unknown) => styles,
      flatten: (style: unknown): object => Array.isArray(style)
        ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : style ?? {},
      hairlineWidth: 1,
    },
    Platform: { OS: "android", select: (options: Record<string, unknown>) => options.android ?? options.default },
    // Deliberately leave native appearance DARK, even when the application selects LIGHT.
    Appearance: { getColorScheme: () => "dark", setColorScheme: vi.fn() },
    useColorScheme: () => "dark",
    PlatformColor: (name: string) => `native:${name}`,
    DynamicColorIOS: () => "native:ios",
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 1, fontScale: 1 }),
    InteractionManager: { runAfterInteractions: (callback: () => void) => callback() },
  };
});
vi.mock("react-native-webview", () => ({ WebView: "WebView" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 20, left: 0, right: 0 }) }));
vi.mock("react-native-svg", () => ({ default: "Svg", Path: "Path" }));
vi.mock("@expo/vector-icons/MaterialIcons", () => ({ default: "MaterialIcons" }));
vi.mock("expo-symbols", () => ({ SymbolView: "SymbolView" }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));
vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(), impactAsync: vi.fn(),
  NotificationFeedbackType: { Success: "success", Warning: "warning" },
  ImpactFeedbackStyle: { Light: "light", Medium: "medium" },
}));
vi.mock("@/components/Toast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/use-focused-session-effect", () => ({ useFocusedSessionEffect: (effect: () => () => void) => useEffect(effect, [effect]) }));
vi.mock("@/lib/focused-session-stream", () => ({
  subscribeFocusedChat: ({ events }: { events: typeof stream.receive }) => {
    stream.subscribe();
    stream.receive = events;
    return stream.unsubscribe;
  },
  pollFocusedSubagent: () => () => undefined,
}));
vi.mock("@/lib/theme", () => import("../src/lib/theme"));
vi.mock("@/lib/conversation-font-size", () => import("../src/lib/conversation-font-size"));
vi.mock("@/lib/chat-model", () => import("../src/lib/chat-model"));
vi.mock("@/lib/chat-scroll-follow", () => import("../src/lib/chat-scroll-follow"));
vi.mock("@/lib/file-references", () => import("../src/lib/file-references"));
vi.mock("@/lib/result-files", () => import("../src/lib/result-files"));
vi.mock("@/lib/text-selection", () => import("../src/lib/text-selection"));
vi.mock("@/lib/user-attachment-loader", () => import("../src/lib/user-attachment-loader"));
vi.mock("@/lib/quick-replies", () => import("../src/lib/quick-replies"));
vi.mock("@/lib/markdown", () => import("../src/lib/markdown"));
vi.mock("@/lib/math", () => import("../src/lib/math"));
vi.mock("@/lib/code-highlight", () => import("../src/lib/code-highlight"));
vi.mock("@/lib/diff-lines", () => import("../src/lib/diff-lines"));
vi.mock("@/components/AgentIcon", () => import("../src/components/AgentIcon"));
vi.mock("@/components/agent-logos", () => import("../src/components/agent-logos"));
vi.mock("@/components/DiffView", () => import("../src/components/DiffView"));
vi.mock("@/components/Icon", () => import("../src/components/Icon"));
vi.mock("@/components/Markdown", () => import("../src/components/Markdown"));
vi.mock("@/components/Sheet", () => import("../src/components/Sheet"));
vi.mock("@/components/CodeBlock", () => import("../src/components/CodeBlock"));
vi.mock("@/components/MathView", () => import("../src/components/MathView"));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  stream.receive = null;
  stream.subscribe.mockClear();
  stream.unsubscribe.mockClear();
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
});
function themed(child: ReactElement, mode: ThemeMode, system: ThemeScheme = "dark") {
  const scheme = resolveThemeScheme(mode, system);
  return createElement(MobileThemeContext.Provider, { value: { scheme, palette: paletteForScheme(scheme) } }, child);
}
async function render(child: ReactElement, mode: ThemeMode, system?: ThemeScheme) {
  await act(() => {
    if (renderer) renderer.update(themed(child, mode, system));
    else renderer = create(themed(child, mode, system));
  });
  return renderer!.root;
}
function native(root: ReactTestInstance, type: string) {
  return root.findAll((node) => typeof node.type === "string" && node.type === type);
}
function style(node: ReactTestInstance, pressed = false): Record<string, unknown> {
  const value = typeof node.props.style === "function" ? node.props.style({ pressed }) : node.props.style;
  return Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
}
function text(root: ReactTestInstance, value: string) {
  return native(root, "Text").find((node) => node.children.join("") === value)!;
}
function textColor(node: ReactTestInstance): unknown {
  for (let current: ReactTestInstance | null = node; current; current = current.parent) {
    if ((current.type as string) === "Text" && style(current).color) return style(current).color;
  }
  return undefined;
}
function assertExplicitColors(root: ReactTestInstance) {
  for (const node of root.findAll((item) => typeof item.type === "string")) {
    expect(JSON.stringify([style(node), style(node, true), node.props.color, node.props.placeholderTextColor]))
      .not.toContain("native:");
  }
}
const conn = { host: { id: "mac" } } as ComponentProps<typeof ChatView>["conn"];

describe("mounted conversation theme", () => {
  it("updates quick actions and pressed states from the app preference while native appearance stays dark", async () => {
    const onPick = vi.fn();
    const child = createElement(memo(QuickReplies), { busy: false, onPick });
    for (const mode of ["dark", "light", "dark"] as const) {
      const root = await render(child, mode);
      const palette = paletteForScheme(mode);
      expect(style(native(root, "ScrollView")[0]!)).toMatchObject({ backgroundColor: palette.surface });
      const button = native(root, "Pressable")[0]!;
      expect(style(button)).toMatchObject({ backgroundColor: palette.surfaceRaised });
      expect(style(button, true)).toMatchObject({ backgroundColor: palette.pressed });
      expect(style(native(root, "Text")[0]!)).toMatchObject({ color: palette.textDim });
      assertExplicitColors(root);
    }
    await act(() => native(renderer!.root, "Pressable")[0]!.props.onPress());
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("updates empty and queued-message cells without resubscribing to the conversation", async () => {
    const child = createElement(ChatView, { conn, sid: "session", pendingOutgoing: { token: "draft", text: "尚未发送的内容" } });
    for (const scheme of ["dark", "light", "dark"] as const) {
      const root = await render(child, scheme);
      const palette = paletteForScheme(scheme);
      expect(style(native(root, "FlatList")[0]!)).toMatchObject({ backgroundColor: palette.bg });
      expect(style(text(root, "准备好了"))).toMatchObject({ color: palette.text });
      expect(style(text(root, "尚未发送的内容"))).toMatchObject({ color: palette.text });
      expect(style(text(root, "发送中…"))).toMatchObject({ color: palette.textDim });
      assertExplicitColors(root);
    }
    expect(stream.subscribe).toHaveBeenCalledTimes(1);
    expect(stream.unsubscribe).not.toHaveBeenCalled();
  });

  it("recolors existing messages and folded execution rows while preserving their expanded state", async () => {
    const child = createElement(ChatView, { conn, sid: "session", agent: "codex" });
    await render(child, "dark");
    await act(() => stream.receive!([
      { kind: "user.message", msgId: "user", text: "检查这个项目" },
      { kind: "tool.start", msgId: "answer", callId: "tool", tool: "read", summary: "README.md" },
      { kind: "tool.end", callId: "tool", state: "success", summary: "文件内容" },
      { kind: "text.delta", msgId: "answer", textId: "text", delta: "检查完成" },
      { kind: "turn.end", msgId: "answer", finish: "stop" },
    ]));
    const disclosure = () => native(renderer!.root, "Pressable").find((node) => node.props.testID?.startsWith("codex-"))!;
    expect(disclosure().props.accessibilityState.expanded).toBe(false);
    await act(() => disclosure().props.onPress());
    for (const scheme of ["light", "dark"] as const) {
      const root = await render(child, scheme);
      const palette = paletteForScheme(scheme);
      expect(disclosure().props.accessibilityState.expanded).toBe(true);
      expect(style(disclosure())).toMatchObject({ backgroundColor: palette.surfaceRaised });
      expect(textColor(text(root, "检查这个项目"))).toBe(palette.onAccent);
      expect(textColor(text(root, "检查完成"))).toBe(palette.text);
      assertExplicitColors(root);
    }
    expect(stream.subscribe).toHaveBeenCalledTimes(1);
  });

  it("recolors memoized code blocks without resetting their local copy state", async () => {
    const child = createElement(CodeBlock, { code: "const n = (1 + 2);", lang: "typescript" });
    const root = await render(child, "dark");
    await act(() => native(root, "Pressable")[0]!.props.onPress());
    expect(text(root, "已复制")).toBeDefined();
    await render(child, "light");
    expect(style(native(root, "View")[0]!)).toMatchObject({ backgroundColor: paletteForScheme("light").surfaceRaised });
    expect(style(text(root, "已复制"))).toMatchObject({ color: paletteForScheme("light").success });
    assertExplicitColors(root);
  });

  it("updates memoized math HTML in explicit and system modes without discarding measured height", async () => {
    const child = createElement(MathFormula, { expression: "x^2" });
    const root = await render(child, "dark");
    await act(() => native(root, "WebView")[0]!.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "size", height: 96 }) } }));
    for (const [mode, system, expected] of [
      ["light", "dark", "light"], ["dark", "light", "dark"],
      ["system", "light", "light"], ["system", "dark", "dark"],
    ] as const) {
      await render(child, mode, system);
      const webview = native(root, "WebView")[0]!;
      expect(webview.props.source.html).toContain(`color-scheme: ${expected}`);
      expect(webview.props.source.html).toContain(`color: ${paletteForScheme(expected).text}`);
      expect(style(native(root, "View")[0]!)).toMatchObject({ height: 96 });
    }
  });

  it("keeps an open sheet title, rows and background on the same application palette", async () => {
    const child = <Sheet visible title="会话信息" onClose={vi.fn()}>
      <Row label="模型" value="当前模型" />
    </Sheet>;
    for (const scheme of ["dark", "light", "dark"] as const) {
      const root = await render(child, scheme);
      const palette = paletteForScheme(scheme);
      expect(style(text(root, "会话信息"))).toMatchObject({ color: palette.text });
      expect(style(text(root, "模型"))).toMatchObject({ color: palette.textDim });
      expect(style(text(root, "当前模型"))).toMatchObject({ color: palette.text });
      expect(native(root, "View").some((node) => style(node).backgroundColor === palette.surface)).toBe(true);
      assertExplicitColors(root);
    }
  });
});
