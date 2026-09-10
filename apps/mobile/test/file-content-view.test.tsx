import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileContentView } from "../src/components/FileContentView";

const ui = vi.hoisted(() => ({
  state: [] as unknown[], cursor: 0,
  buttons: new Map<string, { onPress: () => void; disabled?: boolean; accessibilityState?: { selected?: boolean; checked?: boolean } }>(),
  input: null as { value: string; onChangeText?: (text: string) => void; editable: boolean } | null,
  dismiss: vi.fn(),
}));
vi.mock("react", async () => ({
  ...await vi.importActual<typeof import("react")>("react"),
  useState: (initial: unknown) => {
    const index = ui.cursor++;
    if (!(index in ui.state)) ui.state[index] = initial;
    return [ui.state[index], (next: unknown) => { ui.state[index] = typeof next === "function" ? next(ui.state[index]) : next; }];
  },
}));
vi.mock("react-native", async () => {
  const { createElement: el } = await import("react");
  const View = ({ children, testID }: { children?: ReactNode; testID?: string }) => el("div", { "data-testid": testID }, children);
  return {
    View, Text: View, ScrollView: View, StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Keyboard: { dismiss: ui.dismiss },
    Pressable: (props: { accessibilityLabel: string; onPress: () => void; children?: ReactNode; disabled?: boolean }) => {
      ui.buttons.set(props.accessibilityLabel, props);
      return el("button", { disabled: props.disabled }, props.children);
    },
    TextInput: (props: { value: string; editable: boolean }) => { ui.input = props; return el("textarea", { value: props.value, readOnly: true }); },
  };
});
vi.mock("@/lib/theme", () => ({ MONOSPACE_FONT: "monospace", useMobileTheme: () => ({ palette: {} }) }));
vi.mock("@/lib/code-highlight", () => import("../src/lib/code-highlight"));
vi.mock("../src/components/CodeHighlight", async () => {
  const { createElement: el } = await import("react");
  return { CodeHighlight: ({ code }: { code: string }) => el("span", { "data-highlighted": true }, code) };
});
vi.mock("../src/components/MarkdownFile", async () => {
  const { createElement: el } = await import("react");
  return { MarkdownFile: ({ source }: { source: string }) => el("article", {}, source) };
});
vi.mock("../src/components/DismissKey", () => ({ DismissKey: () => null }));

const props = (filePath: string): ComponentProps<typeof FileContentView> => ({ filePath, text: "# draft", conn: null, hostId: "pc", sid: "session" });
const render = (value: ComponentProps<typeof FileContentView>) => {
  ui.cursor = 0; ui.buttons.clear(); ui.input = null;
  return renderToStaticMarkup(createElement(FileContentView, value));
};
beforeEach(() => { ui.state = []; ui.dismiss.mockClear(); });

describe("file preview modes", () => {
  it("opens Markdown in preview and switches to read-only source", () => {
    const value = props("README.md");
    expect(render(value)).toContain('data-testid="markdown-file-preview"');
    ui.buttons.get("源码")!.onPress();
    render(value);
    expect(ui.input).toMatchObject({ value: value.text, editable: false });
    expect(ui.buttons.has("编辑")).toBe(false);
  });
  it("previews the current unsaved draft and preserves it when returning to editing", () => {
    const value = props("docs/README.md");
    value.onChangeText = vi.fn((text: string) => { value.text = text; });
    render(value);
    ui.buttons.get("编辑")!.onPress();
    render(value);
    expect(ui.input?.editable).toBe(true);
    ui.input!.onChangeText!("# updated draft");
    ui.buttons.get("预览")!.onPress();
    expect(render(value)).toContain("# updated draft");
    ui.buttons.get("编辑")!.onPress();
    render(value);
    expect(ui.input?.value).toBe("# updated draft");
    expect(value.onChangeText).toHaveBeenCalledTimes(1);
    expect(ui.dismiss).toHaveBeenCalledTimes(3);
  });
  it("opens code with rainbow highlighting and allows plain-text viewing", () => {
    const value = { ...props("main.py"), text: "print('hello')" };
    expect(render(value)).toContain('data-highlighted="true"');
    ui.buttons.get("彩虹色代码高亮")!.onPress();
    expect(render(value)).not.toContain("data-highlighted");
    expect(ui.input).toMatchObject({ value: value.text, editable: false });
  });
  it("keeps truncated files read-only and disables expensive previews for large files", () => {
    const value = { ...props("README.md"), text: "x".repeat(80_001), editable: false, onChangeText: vi.fn() };
    render(value);
    expect(ui.buttons.get("预览")?.disabled).toBe(true);
    expect(ui.buttons.has("编辑")).toBe(false);
    expect(ui.input).toMatchObject({ value: value.text, editable: false });
  });
});
