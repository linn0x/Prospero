import { createElement, useState, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAccount, SessionKind } from "@prospero/protocol";
import { SessionAccountSelect } from "../src/components/SessionAccountSelect";
import { selectLaunchAccount } from "../src/lib/session-launch-selection";

vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const native = (name: string) => (props: { children?: ReactNode }) => element(name, props, props.children);
  return { View: native("div"), Text: native("span"), Pressable: native("button"), TextInput: native("input"), ActivityIndicator: native("progress"), StyleSheet: { create: (styles: unknown) => styles } };
});
vi.mock("@/lib/theme", () => ({ useMobileTheme: () => ({ palette: {} }) }));
vi.mock("../src/components/Icon", () => ({ Icon: () => null }));
vi.mock("../src/components/Sheet", () => ({ Sheet: ({ visible, children }: { visible: boolean; children: ReactNode }) => visible ? createElement("aside", {}, children) : null }));

const accounts: AgentAccount[] = Array.from({ length: 48 }, (_, index) => ({
  id: `account-${index}`, name: index === 47 ? "My API account" : `Account ${index}`,
  agent: index % 2 === 0 ? "claude" : "codex", managed: index > 1, isDefault: index < 2,
  status: "signed_in", createdAt: 1, updatedAt: 1, activeSessions: 0,
  ...(index > 1 ? { apiProfile: { provider: "openai_compatible" as const, protocol: "openai_responses" as const, baseUrl: "https://api.example.com/v1", model: `model-${index}` } } : {}),
}));
const trees: ReactTestRenderer[] = [];
afterEach(async () => { for (const tree of trees.splice(0)) await act(async () => tree.unmount()); });
async function mount(element: ReturnType<typeof createElement>) {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(element); });
  trees.push(tree); return tree;
}
const base = { accounts, selected: accounts[0], loading: false, error: null, supported: true, disabled: false, onSelect: vi.fn(), onRetry: vi.fn(), onManage: vi.fn() };
const button = (tree: ReactTestRenderer, label: string) => tree.root.findAllByType("button").find(node => node.props.accessibilityLabel === label)!;

function Launcher() {
  const [selected, setSelected] = useState(accounts[0]);
  const [kind, setKind] = useState<SessionKind>("pty");
  return createElement("section", { agent: selectLaunchAccount(selected, kind).agent, kind },
    createElement(SessionAccountSelect, { ...base, selected, onSelect: account => { setSelected(account); setKind(selectLaunchAccount(account, kind).kind); } }));
}

describe("mobile account and API selection", () => {
  it("keeps 48 accounts behind one visible selector and selects a searched API across agents without losing terminal mode", async () => {
    const tree = await mount(createElement(Launcher));
    expect(tree.root.findAllByProps({ accessibilityRole: "radio" })).toHaveLength(0);
    await act(async () => button(tree, "选择账号或 API").props.onPress());
    expect(tree.root.findAllByType("button").filter(node => node.props.accessibilityRole === "radio")).toHaveLength(48);
    await act(async () => tree.root.findByType("input").props.onChangeText("model-47"));
    const results = tree.root.findAllByType("button").filter(node => node.props.accessibilityRole === "radio");
    expect(results).toHaveLength(1);
    await act(async () => results[0].props.onPress());
    expect(tree.root.findByType("section").props).toMatchObject({ agent: "codex", kind: "pty" });
    expect(tree.root.findAllByType("aside")).toHaveLength(0);
    expect(JSON.stringify(tree.toJSON())).toContain("My API account");
  });

  it("keeps the selector visible when capabilities are unavailable and provides retry after a failed account load", async () => {
    const retry = vi.fn();
    const tree = await mount(createElement(SessionAccountSelect, { ...base, accounts: [], selected: undefined, error: "读取失败", onRetry: retry }));
    expect(button(tree, "选择账号或 API")).toBeDefined();
    await act(async () => button(tree, "重新读取电脑账号").props.onPress());
    expect(retry).toHaveBeenCalledOnce();
    await act(async () => tree.update(createElement(SessionAccountSelect, { ...base, supported: false })));
    expect(button(tree, "选择账号或 API").props.disabled).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain("连接支持账号管理的电脑");
  });

  it("uses structured mode only when the selected profile requires it", () => {
    const openCode: AgentAccount = { ...accounts[47], apiProfile: { ...accounts[47].apiProfile!, protocol: "openai_chat_completions" } };
    expect(selectLaunchAccount(openCode, "pty")).toEqual({ agent: "opencode", kind: "structured" });
    expect(selectLaunchAccount(accounts[1], "pty")).toEqual({ agent: "codex", kind: "pty" });
  });
});
