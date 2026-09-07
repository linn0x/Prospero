import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSnapshot } from "../src/shared/types";
import { SettingsPane } from "../src/renderer/src/settings/SettingsPane";
import { SettingRow } from "../src/renderer/src/settings/SettingRow";

vi.mock("../src/renderer/src/locale", () => ({ useLocale: () => ({ language: "en", setLanguage: vi.fn(), t: (_zh: string, en: string) => en, status: (value: string) => value }) }));

afterEach(() => vi.unstubAllGlobals());

const snapshot = {
  daemon: { state: "idle", running: false, managed: false, starting: false, port: 7424, relay: {} },
  accounts: [{ id: "account" }],
  settings: { startDaemonOnLaunch: true, minimizeToTray: true, launchAtLogin: false, fullAccessPermission: false, theme: "system", terminalFontFamily: "monospace", terminalFontSize: 13, daemonBind: "127.0.0.1", workspaceSort: "recent" },
} as DesktopSnapshot;

describe("settings pane", () => {
  it("retains all desktop controls across six accessible categories", () => {
    vi.stubGlobal("window", { prospero: { platform: "darwin" } });
    const html = renderToStaticMarkup(<SettingsPane snapshot={snapshot} onOpenAccounts={() => {}} />);
    for (const id of ["start-daemon-on-launch", "minimize-to-tray", "launch-at-login", "interface-language", "desktop-theme", "open-accounts", "terminal-font-family", "terminal-font-size", "daemon-bind", "relay-url"]) expect(html).toContain(`id="${id}"`);
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(6);
    expect(html.match(/hidden=""/g)).toHaveLength(5);
    expect(html).toContain("1 accounts configured.");
    expect(html).toContain('value="127.0.0.1" selected=""');
    expect(html).not.toContain('id="full-access-permission"');
    expect(html).not.toContain("settings-grid");
    expect(html).toContain("zsh % codex");
  });

  it("keeps Windows permissions and platform terminal preview", () => {
    vi.stubGlobal("window", { prospero: { platform: "win32" } });
    const html = renderToStaticMarkup(<SettingsPane snapshot={snapshot} onOpenAccounts={() => {}} />);
    expect(html).toContain('id="full-access-permission"');
    expect(html).toContain("Windows UAC");
    expect(html).toContain("PS C:\\Prospero&gt; codex");
  });

  it("places a focusable error and retry next to the failed control", () => {
    const html = renderToStaticMarkup(<SettingRow id="font" title="Font" feedback={{ state: "error", message: "Save failed" }} onRetry={() => {}}><input id="font" /></SettingRow>);
    expect(html).toContain('id="font-feedback"');
    expect(html).toContain('role="alert" tabindex="0"');
    expect(html).toContain("Save failed");
    expect(html).toContain(">Retry</button>");
  });
});
