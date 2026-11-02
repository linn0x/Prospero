import { createElement, forwardRef, useEffect, useImperativeHandle, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyBar } from "../src/components/KeyBar";
import { Terminal } from "../src/components/Terminal";
import { Emitter } from "../src/lib/emitter";
import type { ConnEvents, HostConnection } from "../src/lib/connection";

const bridge = vi.hoisted(() => ({ post: vi.fn() }));
vi.stubGlobal("__DEV__", false);
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const component = (name: string) => (props: { children?: ReactNode }) => el(name, props, props.children);
  return { View: component("div"), Text: component("span"), Pressable: component("button"), ScrollView: component("main"), StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1, absoluteFill: {} } };
});
vi.mock("react-native-webview", () => ({ WebView: forwardRef((_props: unknown, ref) => {
  useImperativeHandle(ref, () => ({ postMessage: bridge.post }));
  return createElement("webview", _props as object);
}) }));
vi.mock("expo-clipboard", () => ({ getStringAsync: vi.fn(async () => "pasted"), setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => {}), impactAsync: vi.fn(async () => {}), ImpactFeedbackStyle: { Light: "light" } }));
vi.mock("@/components/Toast", () => ({ toast: vi.fn() }));
vi.mock("@/lib/outbound-queue", () => import("../src/lib/outbound-queue"));
vi.mock("@/lib/terminal-font-size", () => import("../src/lib/terminal-font-size"));
vi.mock("@/lib/focused-session-stream", () => import("../src/lib/focused-session-stream"));
vi.mock("../src/components/terminal-html", () => ({ TERMINAL_HTML: "<html></html>", TERMINAL_FONT_FAMILY: "Mono" }));
vi.mock("@/lib/use-focused-session-effect", () => ({ useFocusedSessionEffect: (effect: () => () => void) => useEffect(effect, [effect]) }));

let tree: ReactTestRenderer | undefined;
afterEach(async () => { if (tree) await act(async () => tree!.unmount()); tree = undefined; bridge.post.mockClear(); vi.useRealTimers(); });

describe("mobile terminal controls", () => {
  it("keeps the core keys and agent newline visible, and reveals secondary tools on demand", async () => {
    const shortcut = vi.fn(() => ({ accepted: true as const, disposition: "sent" as const }));
    await act(async () => { tree = create(createElement(KeyBar, { onKey: shortcut, onShortcut: shortcut, onPaste: async () => shortcut(), modifiers: { ctrl: false, option: false }, onToggleModifier: vi.fn(), onCopyAll: vi.fn(), newlineSequence: "\x1b\r" })); });
    const button = (label: string) => tree!.root.findAllByType("button").find(node => node.props.accessibilityLabel === label);
    expect(button("在 Agent 中换行")).toBeDefined();
    expect(button("复制终端全部内容")).toBeUndefined();
    await act(async () => button("在 Agent 中换行")!.props.onPress());
    expect(shortcut).toHaveBeenCalledWith("\x1b\r");
    await act(async () => button("展开终端工具")!.props.onPress());
    expect(button("复制终端全部内容")).toBeDefined();
    expect(button("收起终端工具")).toBeDefined();
  });

  it("attaches an ended terminal for read-only history without resizing or sending input", async () => {
    vi.useFakeTimers();
    const events = new Emitter<ConnEvents>();
    const conn = { host: { id: "host" }, events, isConnected: true, attach: vi.fn(), resize: vi.fn(), detach: vi.fn(), ack: vi.fn(), inputB64: vi.fn() };
    await act(async () => { tree = create(createElement(Terminal, { conn: conn as unknown as HostConnection, sid: "ended", fontSize: 12, inputEnabled: false, sessionEnded: true })); });
    const onMessage = tree!.root.findByType("webview").props.onMessage;
    await act(async () => {
      onMessage({ nativeEvent: { data: JSON.stringify({ kind: "ready" }) } });
      onMessage({ nativeEvent: { data: JSON.stringify({ kind: "resized", cols: 60, rows: 20 }) } });
      events.emit("snapshot", { type: "term.snapshot", sid: "ended", seq: 1, ansi: "completed output", cols: 80, rows: 24 });
      onMessage({ nativeEvent: { data: JSON.stringify({ kind: "input", data: "YQ==" }) } });
      await vi.runAllTimersAsync();
    });
    expect(conn.attach).toHaveBeenCalledWith("ended", undefined);
    expect(conn.resize).not.toHaveBeenCalled();
    expect(conn.inputB64).not.toHaveBeenCalled();
    expect(bridge.post.mock.calls.some(([payload]) => String(payload).includes("completed output"))).toBe(true);
  });
});
