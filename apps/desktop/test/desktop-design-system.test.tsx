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
  it.each([["light", light], ["dark", dark]] as const)("keeps %s text and primary controls readable", (_name, theme) => {
    const luminance = (color: string): number => {
      const channels = color.slice(1).match(/../g)!.map(channel => parseInt(channel, 16) / 255)
        .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
      return channels.reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index]!, 0);
    };
    for (const [foreground, background] of [["--foreground", "--background"], ["--muted-foreground", "--background"], ["--secondary-foreground", "--secondary"], ["--primary-foreground", "--primary"], ["--primary-foreground", "--primary-hover"], ["--diff-added", "--diff-added-bg"], ["--diff-removed", "--diff-removed-bg"]]) {
      const a = luminance(value(theme, foreground!)), b = luminance(value(theme, background!));
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it.each([
    ["light", light, { "--bg": "#ffffff", "--surface": "#fafafa", "--surface-raised": "#ffffff", "--surface-sunken": "#f0f0f2", "--text": "#242528", "--border": "#e0e1e5", "--primary": "#315bd6", "--muted": "#62656c", "--success": "#318f73", "--warning": "#a96919", "--danger": "#c7484f" }],
    ["dark", dark, { "--bg": "#191a1d", "--surface": "#202125", "--surface-raised": "#292b30", "--surface-sunken": "#151619", "--text": "#ececef", "--border": "#35373e", "--primary": "#8ba9ff", "--muted": "#acafb8", "--success": "#58b99a", "--warning": "#f0b45a", "--danger": "#e16767" }],
  ] as const)("shares the neutral %s desktop palette", (_name, theme, expected) => {
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
    expect(value(dark, "--card")).toBe("#202125");
    expect(value(light, "--card")).toBe("#fafafa");
    expect(value(dark, "--overlay-glass")).toContain("86%, transparent");
    expect(value(light, "--overlay-glass")).toContain("84%, transparent");
  });

  it("restores opaque surfaces and stops decorations for native and media accessibility preferences", () => {
    expect(styles).toContain('(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)');
    expect(styles).toContain(':root:is([data-reduced-transparency="true"], [data-high-contrast="true"]) :is(body, .prospero-shell, .prospero-main) { background: var(--bg); }');
    expect(styles).toContain(':root[data-native-glass] :is(body, .prospero-shell, .prospero-main) { background: var(--bg); }');
    expect(styles.match(/--overview-card-fill: var\(--card\)/g)).toHaveLength(2);
    expect(styles.match(/--glass-filter: none/g)).toHaveLength(3);
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
