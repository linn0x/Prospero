import { describe, expect, it } from "vitest";
import {
  accountApiConnectionLocked,
  accountApiProfileNameAction,
  accountApiProtocolDefaults,
  accountApiEngineLabel,
  accountApiProvider,
  accountApiProtocolFromProfile,
  accountApiProtocolsForAgent,
  provisionalAccountLoginSession,
  selectCreatedAccount,
  supportsAccountApiProtocols,
} from "../src/renderer/src/account-profile-form";

describe("desktop API profile form", () => {
  it("uses protocol-specific agents and defaults", () => {
    expect(accountApiProtocolDefaults("openai_responses")).toEqual({
      agent: "codex",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5",
    });
    expect(accountApiProtocolDefaults("openai_chat_completions")).toEqual({
      agent: "codex",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1",
    });
    expect(accountApiProtocolDefaults("anthropic")).toEqual({
      agent: "claude",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
    });
    expect(accountApiProvider("anthropic")).toBe("anthropic_compatible");
    expect(accountApiProvider("openai_responses")).toBe("openai_compatible");
  });

  it("limits protocols to the selected agent", () => {
    expect(accountApiProtocolsForAgent("codex")).toEqual(["openai_responses", "openai_chat_completions"]);
    expect(accountApiProtocolsForAgent("opencode")).toEqual(["openai_chat_completions"]);
    expect(accountApiProtocolsForAgent("claude")).toEqual(["anthropic"]);
    expect(accountApiEngineLabel("openai_chat_completions")).toBe("OpenCode");
  });

  it("reads new and legacy public profile metadata", () => {
    expect(accountApiProtocolFromProfile({ protocol: "openai_chat_completions" }, "codex")).toBe("openai_chat_completions");
    expect(accountApiProtocolFromProfile({ provider: "anthropic_compatible" }, "claude")).toBe("anthropic");
    expect(accountApiProtocolFromProfile({ provider: "openai_compatible" }, "codex")).toBe("openai_responses");
  });

  it("creates an immediate placeholder for a new login terminal", () => {
    expect(provisionalAccountLoginSession({ id: "account-1", agent: "codex", name: "Work" }, "login-1", 42)).toEqual({
      id: "login-1",
      agent: "codex",
      kind: "pty",
      title: "Work",
      cwd: "",
      status: "starting",
      createdAt: 42,
      accountId: "account-1",
      accountName: "Work",
    });
  });

  it("fails closed when an older daemon does not advertise protocol selection", () => {
    expect(supportsAccountApiProtocols()).toBe(false);
    expect(supportsAccountApiProtocols([])).toBe(false);
    expect(supportsAccountApiProtocols(["agent.api-protocols.v1"])).toBe(true);
  });

  it("keeps active profile updates name-only", () => {
    expect(accountApiConnectionLocked({ activeSessions: 1 })).toBe(true);
    expect(accountApiConnectionLocked({ activeSessions: 0 })).toBe(false);
    expect(accountApiProfileNameAction("profile-1", "Renamed", true)).toEqual({
      type: "agent.account.api.configure",
      accountId: "profile-1",
      name: "Renamed",
    });
    expect(accountApiProfileNameAction("profile-1", "Renamed", false)).toEqual({
      type: "agent.account.rename",
      accountId: "profile-1",
      name: "Renamed",
    });
  });

  it("uses the authoritative created account without a same-name fallback", () => {
    const accounts = [
      { id: "older", agent: "codex", name: "Work" },
      { id: "created", agent: "codex", name: "Work" },
    ];
    expect(selectCreatedAccount(accounts, "created", "Work", "codex", new Set())).toEqual(accounts[1]);
    expect(selectCreatedAccount(accounts, "missing", "Work", "codex", new Set())).toBeUndefined();
    expect(selectCreatedAccount(accounts, "", "Work", "codex", new Set(["older"]))).toEqual(accounts[1]);
  });
});
