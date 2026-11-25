import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JsonObject, SessionInfo } from "../src/shared/types";
import { compatibleEnginesForProtocol } from "../src/renderer/src/workspace/ApiModelSourceSwitcher";
import { ModelSwitcher } from "../src/renderer/src/workspace/ModelSwitcher";
import { SessionToolbar } from "../src/renderer/src/workspace/SessionToolbar";
import { isApiProfileAccount, modelSourceSwitchSupported } from "../src/renderer/src/workspace/model-catalog";

vi.mock("../src/renderer/src/locale", () => ({
  useLocale: () => ({
    language: "zh" as const,
    t: (zh: string) => zh,
    status: (s: string) => s,
  }),
}));

const apiSourceAccount: JsonObject = {
  id: "acct-src-1",
  agent: "claude",
  engine: "claude",
  apiProfile: { protocol: "anthropic", baseUrl: "https://api.example.com", model: "claude-route-1" },
  modelSource: {
    sourceId: "src-1",
    routeId: "route-1",
    revision: 3,
    sourceName: "Gateway A",
    routeName: "Claude Route 1",
    legacy: false,
    current: true,
  },
};

const apiSession: SessionInfo = {
  id: "sess-api-1",
  cwd: "/repo",
  agent: "claude",
  kind: "structured",
  title: "API Source Session",
  status: "idle",
  accountId: "acct-src-1",
  model: "claude-route-1",
  effort: "high",
  agentControls: {
    compact: true,
    model: false,
    mode: false,
    currentModel: "claude-route-1",
    currentEffort: "high",
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API model source switcher", () => {
  it("detects API profile / model source accounts and gating accurately", () => {
    expect(isApiProfileAccount(undefined)).toBe(false);
    expect(isApiProfileAccount({ id: "native-claude", agent: "claude" })).toBe(false);
    expect(isApiProfileAccount({ id: "acct-1", apiProfile: { model: "m" } })).toBe(true);
    expect(isApiProfileAccount(apiSourceAccount)).toBe(true);

    expect(modelSourceSwitchSupported(apiSession, apiSourceAccount)).toBe(false);

    vi.stubGlobal("window", { prospero: { switchAgentModelSource: vi.fn() } });
    expect(modelSourceSwitchSupported(apiSession, apiSourceAccount)).toBe(true);
    expect(modelSourceSwitchSupported({ ...apiSession, kind: "pty" }, apiSourceAccount)).toBe(true);
    expect(modelSourceSwitchSupported({ ...apiSession, kind: "pty", agent: "shell" }, apiSourceAccount)).toBe(false);
    expect(modelSourceSwitchSupported({ ...apiSession, kind: "pty" }, { id: "native-claude", agent: "claude" })).toBe(false);
    expect(modelSourceSwitchSupported(apiSession, { id: "native-claude", agent: "claude" })).toBe(false);
  });

  it("maps compatible execution engines per route protocol", () => {
    expect(compatibleEnginesForProtocol("anthropic")).toEqual(["claude", "pi"]);
    expect(compatibleEnginesForProtocol("openai_responses")).toEqual(["codex", "pi"]);
    expect(compatibleEnginesForProtocol("openai_chat_completions")).toEqual(["opencode", "pi", "agy"]);
    expect(compatibleEnginesForProtocol("openai_chat_completions", true)).toEqual(["pi", "agy"]);
  });

  it("renders API model source chip when supported and disables it only on terminal/starting states", () => {
    vi.stubGlobal("window", { prospero: { switchAgentModelSource: vi.fn() } });

    const idleHtml = renderToStaticMarkup(
      <ModelSwitcher session={apiSession} account={apiSourceAccount} />,
    );
    expect(idleHtml).toContain("session-model-chip");
    expect(idleHtml).toContain('aria-label="切换模型源或模型"');
    expect(idleHtml).toContain("Gateway A / Claude Route 1 · claude-route-1 · Claude Code");
    expect(idleHtml).toContain("claude-route-1");
    expect(idleHtml).not.toMatch(/<button[^>]*\sdisabled(?:=""|(?=\s|>))/);

    const runningHtml = renderToStaticMarkup(
      <ModelSwitcher session={{ ...apiSession, status: "running" }} account={apiSourceAccount} />,
    );
    expect(runningHtml).not.toMatch(/<button[^>]*\sdisabled(?:=""|(?=\s|>))/);

    const exitedHtml = renderToStaticMarkup(
      <ModelSwitcher session={{ ...apiSession, status: "exited" }} account={apiSourceAccount} />,
    );
    expect(exitedHtml).toMatch(/<button[^>]*\sdisabled(?:=""|(?=\s|>))/);

    const startingHtml = renderToStaticMarkup(
      <ModelSwitcher session={{ ...apiSession, status: "starting" }} account={apiSourceAccount} />,
    );
    expect(startingHtml).toMatch(/<button[^>]*\sdisabled(?:=""|(?=\s|>))/);

    const multiCredAccount: JsonObject = {
      ...apiSourceAccount,
      modelSource: {
        ...(apiSourceAccount["modelSource"] as JsonObject),
        credentialId: "cred-b",
        credentialName: "Account B",
        multiCredential: true,
      },
    };
    const multiCredHtml = renderToStaticMarkup(
      <ModelSwitcher session={apiSession} account={multiCredAccount} />,
    );
    expect(multiCredHtml).toContain("claude-route-1 · Account B");
    expect(multiCredHtml).toContain("Gateway A / Claude Route 1 · Account B · claude-route-1 · Claude Code");
  });

  it("falls back to native ModelSwitcher for non-API sessions", () => {
    vi.stubGlobal("window", { prospero: { switchAgentModelSource: vi.fn() } });
    const nativeSession: SessionInfo = {
      ...apiSession,
      id: "sess-native-1",
      agent: "codex",
      model: "gpt-6-astra",
      agentControls: {
        compact: true,
        model: true,
        mode: false,
        currentModel: "gpt-6-astra",
      },
    };
    const html = renderToStaticMarkup(
      <ModelSwitcher session={nativeSession} account={{ id: "native-codex", agent: "codex" }} />,
    );
    expect(html).toContain('aria-label="切换模型"');
    expect(html).toContain("gpt-6-astra");
  });

  it("renders API model source switcher in SessionToolbar for API TUI (pty) sessions", () => {
    vi.stubGlobal("window", { prospero: { platform: "darwin", switchAgentModelSource: vi.fn() } });
    const ptySession: SessionInfo = {
      ...apiSession,
      id: "sess-pty-1",
      kind: "pty",
      status: "running",
    };

    const paneHtml = renderToStaticMarkup(
      <SessionToolbar
        session={ptySession}
        account={apiSourceAccount}
        contextVisible={false}
        onToggleContext={() => {}}
        onToggleFocus={() => {}}
        localSelection
        onLocalSelectionChange={() => {}}
      />,
    );
    expect(paneHtml).toContain("session-model-chip");
    expect(paneHtml).toContain('aria-label="切换模型源或模型"');
    expect(paneHtml).not.toContain("session-toolbar-model");

    const topbarHtml = renderToStaticMarkup(
      <SessionToolbar
        variant="topbar"
        session={ptySession}
        account={apiSourceAccount}
        contextVisible={false}
        onToggleContext={() => {}}
        onToggleFocus={() => {}}
        localSelection
        onLocalSelectionChange={() => {}}
      />,
    );
    expect(topbarHtml).toContain("session-model-chip");

    const nativePtyHtml = renderToStaticMarkup(
      <SessionToolbar
        session={ptySession}
        account={{ id: "native-claude", agent: "claude" }}
        contextVisible={false}
        onToggleContext={() => {}}
        onToggleFocus={() => {}}
        localSelection
        onLocalSelectionChange={() => {}}
      />,
    );
    expect(nativePtyHtml).not.toContain("session-model-chip");
  });
});
