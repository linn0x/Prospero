import { describe, expect, it } from "vitest";
import {
  AgentModelCapabilitiesSchema,
  CAPABILITY_AGENT_API_VALIDATION,
  getAgentAccountCapabilities,
  getAgentAccountEngine,
  parseC2S,
  parseS2C,
} from "../src/index.js";

describe("API Profile capabilities and validation protocol", () => {
  it("derives legacy engine restrictions when metadata is absent", () => {
    expect(getAgentAccountCapabilities({ agent: "codex" })).toEqual({
      sessionKinds: ["pty", "structured"], plan: true, resume: true, modelSelection: true, reasoningEffort: true,
    });
    const account = { agent: "codex" as const, apiProfile: {
      protocol: "openai_chat_completions" as const, provider: "openai_compatible" as const,
      baseUrl: "https://gateway.example/v1", model: "coder",
    } };
    expect(getAgentAccountEngine(account)).toBe("opencode");
    expect(getAgentAccountCapabilities(account)).toEqual({
      sessionKinds: ["structured"], plan: false, resume: false, modelSelection: false, reasoningEffort: false,
    });
    const capabilities = { sessionKinds: ["structured" as const], plan: false, resume: false, modelSelection: false, reasoningEffort: false };
    expect(getAgentAccountCapabilities({ agent: "claude", capabilities })).toEqual(capabilities);
    expect(getAgentAccountCapabilities({ ...account, apiProfileError: "invalid", capabilities }).sessionKinds).toEqual([]);
    expect(getAgentAccountCapabilities({ ...account, apiProfile: { ...account.apiProfile, modelCapabilities: { tools: false } } }).sessionKinds).toEqual([]);
  });

  it("round trips model metadata and permits clearing only on configure", () => {
    const create = { type: "agent.account.api.create", requestId: "r1", agent: "codex", name: "Profile",
      baseUrl: "https://gateway.example/v1", model: "coder", apiKey: "private-key",
      modelCapabilities: { contextWindow: 128_000, maxOutputTokens: 8192, tools: false },
    };
    expect(parseC2S(create)).toMatchObject({ modelCapabilities: create.modelCapabilities });
    expect(AgentModelCapabilitiesSchema.parse({})).toEqual({});
    expect(AgentModelCapabilitiesSchema.safeParse({ contextWindow: 0 }).success).toBe(false);
    expect(AgentModelCapabilitiesSchema.safeParse({ contextWindow: 1.5 }).success).toBe(false);
    expect(AgentModelCapabilitiesSchema.safeParse({ contextWindow: 100_000_001 }).success).toBe(false);
    expect(AgentModelCapabilitiesSchema.safeParse({ contextWindow: 1, maxOutputTokens: 2 }).success).toBe(false);
    expect(() => parseC2S({ ...create, modelCapabilities: null })).toThrow();
    expect(parseC2S({ type: "agent.account.api.configure", requestId: "r2", accountId: "a", modelCapabilities: null }))
      .toMatchObject({ modelCapabilities: null });
  });

  it("round trips explicit validation with per-stage evidence and rejects false success", () => {
    expect(CAPABILITY_AGENT_API_VALIDATION).toBe("agent.api-validation.v1");
    expect(parseC2S({ type: "agent.account.api.test", requestId: "r1", accountId: "a" }))
      .toMatchObject({ type: "agent.account.api.test" });
    const validation = { status: "passed", checkedAt: 1, engine: "opencode",
      checks: { runtime: "passed", streaming: "passed", tools: "passed" }, detail: "Passed", latencyMs: 15 };
    const result = { type: "agent.accounts.result", requestId: "r1", action: "api_test", ok: true, accounts: [], accountId: "a", validation };
    expect(parseS2C(result)).toMatchObject({ validation });
    expect(() => parseS2C({ ...result, validation: { ...validation, checks: { ...validation.checks, tools: "not_tested" } } })).toThrow();
    expect(parseS2C({ ...result, ok: false, validation: { ...validation, status: "failed", checks: { runtime: "passed", streaming: "failed", tools: "not_tested" } } })).toMatchObject({ ok: false });
  });
});
