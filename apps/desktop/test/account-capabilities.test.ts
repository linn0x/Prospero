import { describe, expect, it } from "vitest";
import { accountCapabilities, accountEngine } from "../src/shared/account-capabilities";
import { sessionLaunchAccounts, sessionLaunchRequiresStructured } from "../src/shared/session-launch-options";

describe("account launch metadata", () => {
  it("uses daemon engine and capability metadata before legacy protocol inference", () => {
    const account = {
      id: "profile", agent: "codex", engine: "claude", apiProfile: { protocol: "openai_chat_completions" },
      capabilities: { sessionKinds: ["pty"], plan: true, resume: false, modelSelection: true, reasoningEffort: false },
    };
    expect(accountEngine(account)).toBe("claude");
    expect(accountCapabilities(account)).toEqual(account.capabilities);
    expect(sessionLaunchRequiresStructured(sessionLaunchAccounts([account], "codex")[0])).toBe(false);
  });

  it("preserves older daemon restrictions without treating an omitted tool flag as unsupported", () => {
    const account = { agent: "codex", apiProfile: { protocol: "openai_chat_completions" } };
    expect(accountEngine(account)).toBe("opencode");
    expect(accountCapabilities(account)).toEqual({ sessionKinds: ["structured"], plan: false, resume: false, modelSelection: false, reasoningEffort: false });
    expect(accountCapabilities({ agent: "codex" }).modelSelection).toBe(true);
  });

  it("blocks corrupt profiles and models explicitly lacking tools", () => {
    expect(accountCapabilities({ apiProfileError: "Invalid profile" }).sessionKinds).toEqual([]);
    expect(accountCapabilities({ apiProfile: { modelCapabilities: { tools: false } } }).sessionKinds).toEqual([]);
    expect(accountCapabilities({ capabilities: { sessionKinds: [] } }).sessionKinds).toEqual([]);
  });
});
