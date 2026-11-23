import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { overlayCovers } from "../src/renderer/src/NativeTerminalPane";

const root = resolve(import.meta.dirname, "../src/renderer/src");
const read = (file: string) => readFileSync(resolve(root, file), "utf8").replaceAll("\r\n", "\n");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop motion system", () => {
  it("defines shared motion duration and easing tokens", () => {
    const tokens = read("design-system/tokens.css");
    for (const token of [
      "--motion-fast:",
      "--motion-base:",
      "--motion-panel:",
      "--motion-exit:",
      "--ease-out:",
      "--ease-in:",
    ]) {
      expect(tokens).toContain(token);
    }
  });

  it("uses cohesive eased sidebar collapse and collapsible height transitions", () => {
    const sidebar = read("components/ui/sidebar.tsx");
    expect(sidebar).not.toContain("ease-linear");
    expect(sidebar).toContain("duration-(--motion-panel)");
    expect(sidebar).toContain("ease-(--ease-out)");

    const collapsible = read("components/ui/collapsible.tsx");
    expect(collapsible).toContain("h-(--collapsible-panel-height)");
    expect(collapsible).toContain("data-starting-style:h-0");
    expect(collapsible).toContain("data-ending-style:h-0");
  });

  it("uses interruptible Base UI transitions for overlays and explicit properties on controls", () => {
    for (const file of [
      "components/ui/dialog.tsx",
      "components/ui/sheet.tsx",
      "components/ui/dropdown-menu.tsx",
      "components/ui/context-menu.tsx",
      "components/ui/tooltip.tsx",
      "components/ui/hover-card.tsx",
    ]) {
      const content = read(file);
      expect(content, file).not.toContain("animate-in");
      expect(content, file).not.toContain("animate-out");
    }

    for (const file of [
      "components/ui/button.tsx",
      "components/ui/tabs.tsx",
      "components/ui/badge.tsx",
      "components/ui/switch.tsx",
      "components/ui/toggle.tsx",
      "components/ui/progress.tsx",
    ]) {
      expect(read(file), file).not.toContain("transition-all");
    }
  });

  it("holds native terminal occlusion while an overlay exit transition is actively playing", () => {
    type FakeElement = {
      isConnected: boolean;
      rect: { left: number; right: number; top: number; bottom: number; width: number; height: number };
      closing: boolean;
      hidden: boolean;
      style: {
        display: string;
        visibility: string;
        opacity: string;
        pointerEvents: string;
        transitionDuration: string;
        animationName: string;
        animationDuration: string;
      };
      matches: (selector: string) => boolean;
      closest: (selector: string) => FakeElement | null;
      getBoundingClientRect: () => FakeElement["rect"];
    };

    const overlay: FakeElement = {
      isConnected: true,
      rect: { left: 100, top: 100, right: 400, bottom: 400, width: 300, height: 300 },
      closing: true,
      hidden: false,
      style: {
        display: "grid",
        visibility: "visible",
        opacity: "0.65",
        pointerEvents: "none",
        transitionDuration: "0.11s",
        animationName: "none",
        animationDuration: "0s",
      },
      matches: (selector) =>
        (overlay.closing && selector.includes("[data-ending-style]"))
        || (overlay.hidden && selector.includes("[hidden]")),
      closest: () => null,
      getBoundingClientRect: () => overlay.rect,
    };

    vi.stubGlobal("document", {
      querySelectorAll: () => [overlay],
    });
    vi.stubGlobal("getComputedStyle", () => overlay.style);

    const terminalRect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } as DOMRect;
    expect(overlayCovers(terminalRect)).toBe(true);

    // Under prefers-reduced-motion (0.01ms) or once faded out, occlusion clears immediately.
    overlay.style.transitionDuration = "0.00001s";
    expect(overlayCovers(terminalRect)).toBe(false);

    overlay.style.transitionDuration = "0.11s";
    overlay.style.opacity = "0";
    expect(overlayCovers(terminalRect)).toBe(false);
  });
});
