import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopIcon } from "../src/renderer/src/design-system/icons";

const root = resolve(import.meta.dirname, "../src/renderer/src");
const tokens = readFileSync(resolve(root, "design-system/tokens.css"), "utf8").replaceAll("\r\n", "\n");
const styles = readFileSync(resolve(root, "styles.css"), "utf8").replaceAll("\r\n", "\n");
const declarations = (source: string) => Object.fromEntries([...source.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
const light = declarations(tokens.slice(0, tokens.indexOf(":root.dark")));
const dark = { ...light, ...declarations(tokens.slice(tokens.indexOf(":root.dark"))) };
function value(theme: Record<string, string>, key: string): string {
  let result = theme[key]!;
  for (let step = 0; step < 20 && result.includes("var("); step += 1) result = result.replace(/var\((--[a-z0-9-]+)\)/g, (_match, property: string) => theme[property]!);
  return result;
}

describe("desktop design tokens", () => {
  it.each([
    ["light", light, { "--bg": "#f3f6fb", "--surface": "#fbfdff", "--surface-raised": "#ffffff", "--surface-sunken": "#edf2f8", "--text": "#182033", "--border": "#dce3ee", "--primary": "#4c7dff", "--muted": "#66728a", "--success": "#318f73", "--warning": "#a96919", "--danger": "#c7484f" }],
    ["dark", dark, { "--bg": "#0f1624", "--surface": "#151e2e", "--surface-raised": "#1b2740", "--surface-sunken": "#0d1421", "--text": "#edf2fb", "--border": "#283650", "--primary": "#6d92ff", "--muted": "#9aa8bd", "--success": "#58b99a", "--warning": "#f0b45a", "--danger": "#e16767" }],
  ] as const)("preserves the established %s desktop palette", (_name, theme, expected) => {
    for (const [key, expectedValue] of Object.entries(expected)) expect(value(theme, key)).toBe(expectedValue);
    expect(value(theme, "--foreground")).toBe(value(theme, "--text"));
    expect(value(theme, "--sidebar-foreground")).toBe(value(theme, "--text"));
    expect(value(theme, "--sidebar-border")).toBe(value(theme, "--border"));
    expect(value(theme, "--overview-card-fill")).toContain("92%, transparent");
  });

  it("shares theme values with shadcn and supports the resolved system theme class", () => {
    expect(styles).toContain('@import "./design-system/tokens.css"');
    expect(styles).not.toMatch(/--bg:\s*#/);
    expect(tokens).toContain(':root.dark,\n:root[data-theme="dark"]');
    expect(value(dark, "--card")).toBe("#151e2e");
    expect(value(light, "--card")).toBe("#fbfdff");
    expect(value(dark, "--overlay-glass")).toContain("86%, transparent");
    expect(value(light, "--overlay-glass")).toContain("84%, transparent");
  });

  it("restores opaque surfaces and stops decorations for native and media accessibility preferences", () => {
    expect(styles).toContain('(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)');
    expect(styles).toContain(':root:is([data-reduced-transparency="true"], [data-high-contrast="true"]) :is(body, .prospero-shell, .prospero-main) { background: var(--bg); }');
    expect(styles).toContain(':root[data-native-glass] :is(body, .prospero-shell, .prospero-main) { background: var(--bg); }');
    expect(styles.match(/--overview-card-fill: var\(--card\)/g)).toHaveLength(2);
    expect(styles.match(/--glass-filter: none/g)).toHaveLength(2);
  });

  it("anchors each glass panel's decorative border to the panel instead of the whole workspace", () => {
    expect(styles).toMatch(/\[data-slot="card"\]\[data-liquid-glass="panel"\]\s*\{\s*position:\s*relative;/);
    expect(styles).toMatch(/\[data-liquid-glass\]::before,\s*\[data-liquid-glass\]::after\s*\{[^}]*pointer-events:\s*none;/);
  });

  it("does not override the fixed positioning of glass dialogs and sheets", () => {
    const relativeRules = [...styles.matchAll(/([^{}]+)\{[^{}]*position:\s*relative;[^{}]*\}/g)].map(match => match[1]!);
    for (const selector of relativeRules) {
      if (!selector.includes('[data-liquid-glass="panel"]')) continue;
      expect(selector).toContain('[data-slot="card"][data-liquid-glass="panel"]');
      expect(selector).not.toMatch(/:is\([^)]*\[data-liquid-glass="panel"\]/);
    }
  });
});

describe("desktop semantic icons", () => {
  it("uses consistent inline and navigation dimensions", () => {
    const inline = renderToStaticMarkup(<DesktopIcon name="terminal" />);
    const navigation = renderToStaticMarkup(<DesktopIcon name="settings" navigation />);
    expect(inline).toContain('width="16" height="16"');
    expect(navigation).toContain('width="18" height="18"');
    expect(inline).toContain('stroke-width="2"');
    expect(inline).toContain('aria-hidden="true"');
  });

  it("exposes labelled icons without adding duplicate labels to decorative icons", () => {
    const html = renderToStaticMarkup(<DesktopIcon name="refresh" aria-label="Refresh status" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Refresh status"');
    expect(html).not.toContain('aria-hidden="true"');
  });
});
