import { describe, expect, it, vi } from "vitest";
import {
  bindTerminalMouseAndLinks,
  findTerminalBufferUrlAtPosition,
  isTerminalLinkOpenModifier,
  preferLocalTerminalSelection,
  type TerminalBufferLike,
  type TerminalBufferLineLike,
  type TerminalMouseTargetLike,
} from "../src/renderer/src/terminal-mouse";

const mouse = (overrides: Partial<MouseEvent> = {}) =>
  ({
    button: 0,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    detail: 2,
    clientX: 12,
    clientY: 34,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  }) as unknown as MouseEvent;

function makeBuffer(
  rows: Array<{ text: string; isWrapped?: boolean; oscLinks?: Record<number, number> }>,
  cols: number,
  viewportY = 0,
): TerminalBufferLike {
  const lines: TerminalBufferLineLike[] = rows.map(row => ({
    isWrapped: Boolean(row.isWrapped),
    length: cols,
    getCell(x: number) {
      if (x < 0 || x >= cols) return undefined;
      const ch = x < row.text.length ? row.text[x]! : " ";
      const urlId = row.oscLinks?.[x];
      return {
        getWidth: () => 1,
        getChars: () => ch,
        ...(urlId ? { extended: { urlId } } : {}),
      };
    },
  }));
  return {
    viewportY,
    length: lines.length,
    getLine: (y: number) => lines[y],
  };
}

function makeFakeHost() {
  const listeners = new Map<string, Set<(event: MouseEvent) => void>>();
  return {
    addEventListener(type: string, fn: (event: MouseEvent) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: string, fn: (event: MouseEvent) => void) {
      listeners.get(type)?.delete(fn);
    },
    contains: () => true,
    dispatch(type: string, event: MouseEvent) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
  };
}

describe("local terminal selection", () => {
  it.each(["x10", "vt200", "drag", "any"])(
    "uses Option for macOS mouse mode %s without changing click count or coordinates",
    mode => {
      const e = mouse();
      preferLocalTerminalSelection(e, true, true, mode);
      expect(e).toMatchObject({ altKey: true, shiftKey: false, detail: 2, clientX: 12, clientY: 34 });
    },
  );
  it("uses Shift on other platforms only when reporting is active", () => {
    const e = mouse();
    preferLocalTerminalSelection(e, false, true, "any");
    expect(e.shiftKey).toBe(true);
    const plain = mouse();
    preferLocalTerminalSelection(plain, false, true, "none");
    expect(plain.shiftKey).toBe(false);
  });
  it("preserves application mode, secondary clicks and link modifiers", () => {
    for (const [event, local] of [
      [mouse(), false],
      [mouse({ button: 2 }), true],
      [mouse({ metaKey: true }), true],
      [mouse({ ctrlKey: true }), true],
    ] as const) {
      preferLocalTerminalSelection(event, true, local, "any");
      expect(event.altKey).toBe(false);
    }
  });
  it("does not force selection while clicking an xterm link", () => {
    const event = {
      ...mouse(),
      composedPath: () => [{ classList: { contains: (value: string) => value === "xterm-cursor-pointer" } }],
    } as unknown as MouseEvent;
    preferLocalTerminalSelection(event, true, true, "any");
    expect(event.altKey).toBe(false);
  });
});

describe("TUI mouse-tracking Cmd/Ctrl+Click link opening", () => {
  it("matches platform link open modifiers strictly", () => {
    expect(isTerminalLinkOpenModifier(mouse({ metaKey: true }), true)).toBe(true);
    expect(isTerminalLinkOpenModifier(mouse({ ctrlKey: true }), true)).toBe(false);
    expect(isTerminalLinkOpenModifier(mouse({ ctrlKey: true }), false)).toBe(true);
    expect(isTerminalLinkOpenModifier(mouse({ metaKey: true }), false)).toBe(false);
    expect(isTerminalLinkOpenModifier(mouse({ metaKey: true, altKey: true }), true)).toBe(false);
  });

  it("extracts plain URLs, wrapped URLs, and OSC-8 hyperlinks from terminal buffer cells", () => {
    const wrapped = makeBuffer(
      [
        { text: "Open https://example" },
        { text: ".com/docs/guide now!", isWrapped: true },
      ],
      20,
    );
    expect(findTerminalBufferUrlAtPosition(wrapped, 20, 8, 0)).toBe("https://example.com/docs/guide");
    expect(findTerminalBufferUrlAtPosition(wrapped, 20, 4, 1)).toBe("https://example.com/docs/guide");
    expect(findTerminalBufferUrlAtPosition(wrapped, 20, 17, 1)).toBeUndefined();

    const osc8 = makeBuffer(
      [{ text: "Click manual here", oscLinks: { 6: 7, 7: 7, 8: 7, 9: 7, 10: 7, 11: 7 } }],
      20,
    );
    expect(
      findTerminalBufferUrlAtPosition(osc8, 20, 8, 0, id =>
        id === 7 ? "https://osc8.example.com/manual" : undefined,
      ),
    ).toBe("https://osc8.example.com/manual");
  });

  it("opens URLs on Cmd+Click (macOS) / Ctrl+Click (non-macOS) in TUI mouse mode and suppresses SGR mouse forwarding", () => {
    const buffer = makeBuffer([{ text: "See https://example.com/docs for details" }], 40);
    const opened: string[] = [];
    const host = makeFakeHost();
    const terminal: TerminalMouseTargetLike = {
      cols: 40,
      rows: 10,
      modes: { mouseTrackingMode: "any" },
      buffer: { active: buffer },
      focus: vi.fn(),
      _core: {
        _mouseService: {
          getCoords: event => [Math.floor(event.clientX / 10) + 1, Math.floor(event.clientY / 20) + 1],
        },
      },
    };

    const dispose = bindTerminalMouseAndLinks(host as unknown as HTMLElement, terminal, {
      isMac: true,
      isLocalSelection: () => false,
      onOpenUrl: (_event, url) => {
        opened.push(url);
        return true;
      },
    });

    const down = mouse({ metaKey: true, clientX: 85, clientY: 5 });
    host.dispatch("mousedown", down);
    expect(down.preventDefault).toHaveBeenCalledTimes(1);
    expect(down.stopPropagation).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([]);

    const up = mouse({ metaKey: true, clientX: 85, clientY: 5 });
    host.dispatch("mouseup", up);
    expect(up.preventDefault).toHaveBeenCalledTimes(1);
    expect(up.stopPropagation).toHaveBeenCalledTimes(1);
    expect(opened).toEqual(["https://example.com/docs"]);

    // Plain click without Command in application mouse mode is NOT swallowed.
    const plainDown = mouse({ metaKey: false, clientX: 85, clientY: 5 });
    host.dispatch("mousedown", plainDown);
    expect(plainDown.stopPropagation).not.toHaveBeenCalled();

    dispose();
  });
});
