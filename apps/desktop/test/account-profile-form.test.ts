import { describe, expect, it } from "vitest";
import {
  accountApiStatus,
  accountApiEngineStatus,
  accountApiTestAction,
  supportsAccountApiEngineValidation,
  modelCapabilitySupportRows,
  modelCapabilityDraft,
  parseModelCapabilities,
  supportsAccountApiValidation,
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

describe("API validation and optional model metadata", () => {
  it("does not present a configured key as a validated connection", () => {
    expect(accountApiStatus({ status: "signed_in" }, true)).toBe("Configured · unverified");
    expect(accountApiStatus({ status: "signed_in", apiValidation: { status: "failed" } }, true)).toBe("API checks failed");
    expect(accountApiStatus({ status: "signed_in", apiValidation: { status: "passed" } }, true)).toBe("API checks passed");
    expect(accountApiStatus({ status: "unavailable", apiProfileError: "bad" }, true)).toBe("Profile needs repair");
    expect(supportsAccountApiValidation(["agent.api-protocols.v1"])).toBe(false);
    expect(supportsAccountApiValidation(["agent.api-validation.v1"])).toBe(true);
  });

  it("retains false and unknown fields while changing token limits", () => {
    const initial = { contextWindow: 1000, tools: false, extraFromNewDaemon: "preserve" };
    const draft = modelCapabilityDraft(initial);
    expect(draft.vision).toBe("unknown");
    expect(parseModelCapabilities({ ...draft, contextWindow: "2000", maxOutputTokens: "500" }, initial))
      .toEqual({ contextWindow: 2000, maxOutputTokens: 500, tools: false, extraFromNewDaemon: "preserve" });
    expect(parseModelCapabilities(modelCapabilityDraft())).toBeNull();
  });

  it("rejects invalid limits instead of silently saving them", () => {
    for (const contextWindow of ["-1", "0", "1.5", "2e3", "100000001", "9007199254740992"]) {
      expect(() => parseModelCapabilities({ ...modelCapabilityDraft(), contextWindow })).toThrow();
    }
    expect(() => parseModelCapabilities({ ...modelCapabilityDraft(), contextWindow: "100", maxOutputTokens: "101" })).toThrow("Output limit");
    expect(() => parseModelCapabilities({ ...modelCapabilityDraft(), contextWindow: "100" }, {}, "openai_chat_completions")).toThrow("both token limits");
    expect(parseModelCapabilities({ ...modelCapabilityDraft(), contextWindow: "100" }, {}, "openai_responses")).toEqual({ contextWindow: 100 });
  });

  it("normalizes explicit supported efforts separately from boolean reasoning", () => {
    const draft = { ...modelCapabilityDraft(), supportedEfforts: "LOW, high，low medium" };
    expect(parseModelCapabilities(draft)).toEqual({ supportedEfforts: ["low", "high", "medium"] });
    expect(() => parseModelCapabilities({ ...draft, reasoning: "false" })).toThrow("non-reasoning");
    expect(() => parseModelCapabilities({ ...draft, supportedEfforts: "unknown" })).toThrow("Unsupported");
    expect(() => parseModelCapabilities({ ...draft, supportedEfforts: "none" }, {}, "anthropic")).toThrow("Unsupported");
    const initial = { reasoning: true, supportedEfforts: ["low", "high"], futureCapability: "preserve" };
    expect(modelCapabilityDraft(initial).supportedEfforts).toBe("low, high");
    expect(parseModelCapabilities({ ...modelCapabilityDraft(initial), supportedEfforts: "" }, initial)).toEqual({ reasoning: true, futureCapability: "preserve" });
    expect(() => parseModelCapabilities({ ...modelCapabilityDraft(initial), reasoning: "false" }, initial)).toThrow("Clear effort");
    expect(parseModelCapabilities(modelCapabilityDraft({ supportedEfforts: ["future-effort"] }), { supportedEfforts: ["future-effort"] })).toEqual({ supportedEfforts: ["future-effort"] });
  });
});


describe("independent Agent execution validation", () => {
  it("preserves protocol compatibility and opts into engine requests explicitly", () => {
    expect(accountApiTestAction("profile", "protocol")).toEqual({ type: "agent.account.api.test", accountId: "profile" });
    expect(accountApiTestAction("profile", "engine")).toEqual({ type: "agent.account.api.test", accountId: "profile", scope: "engine" });
    expect(supportsAccountApiEngineValidation(["agent.api-validation.v1"])).toBe(false);
    expect(supportsAccountApiEngineValidation(["agent.api-engine-validation.v1"])).toBe(true);
  });

  it("does not confuse a passing protocol check with a passing engine check", () => {
    const account = { status: "signed_in", apiValidation: { status: "passed" }, apiEngineValidation: { status: "failed" } };
    expect(accountApiStatus(account, true)).toBe("API checks passed");
    expect(accountApiEngineStatus(account, true)).toBe("Agent execution failed");
    expect(accountApiEngineStatus({ apiValidation: { status: "passed" } }, true)).toBe("Agent execution unverified");
  });

  it("reports only declared model fields and leaves missing support unknown", () => {
    expect(modelCapabilitySupportRows({ modelCapabilities: { contextWindow: 1000, tools: false, vision: false } }, { contextWindow: "unsupported", tools: "enforced", reasoning: "enforced" })).toEqual([
      { key: "contextWindow", status: "unsupported" }, { key: "tools", status: "enforced" }, { key: "vision", status: "unknown" },
    ]);
  });
});
