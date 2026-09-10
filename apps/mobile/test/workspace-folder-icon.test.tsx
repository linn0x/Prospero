import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceFolderIcon } from "../src/components/WorkspaceDisclosure";

vi.mock("react-native", () => ({
  View: ({ children, style }: { children: ReactNode; style: unknown }) => createElement("div", { "data-style": JSON.stringify(style) }, children),
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock("react-native-svg", () => ({ default: "svg", Path: "path" }));
vi.mock("../src/components/Icon", () => ({ Icon: () => null }));

describe("workspace folder glyph", () => {
  it("switches to an open folder and back without translucent overlapping glyphs", () => {
    const render = (expanded: boolean) => renderToStaticMarkup(createElement(WorkspaceFolderIcon, { expanded, size: 18, color: "#315EA8" }));
    const closed = render(false);
    const open = render(true);
    expect(open).not.toBe(closed);
    for (const html of [closed, open, render(false), render(true)]) {
      expect(html.match(/<path /g)).toHaveLength(1);
      expect(html).not.toContain("opacity");
      expect(html).not.toContain("rotate");
    }
    expect(render(false)).toBe(closed);
  });
});
