import { describe, expect, it } from "vitest";
import { AgentModelCapabilitiesSchema, C2SAgentAccountConfigSetSchema, parseC2S, parseS2C } from "../src/index.js";

describe("account tool protocol", () => {
  it("keeps catalogs and configuration results independent from legacy account result actions", () => {
    expect(parseC2S({ type: "agent.account.api.models.get", requestId: "draft", protocol: "anthropic", baseUrl: "https://api.example", apiKey: "draft-key" }).type).toBe("agent.account.api.models.get");
    expect(parseC2S({ type: "agent.account.api.models.get", requestId: "saved", accountId: "account" }).type).toBe("agent.account.api.models.get");
    expect(parseS2C({ type: "agent.account.api.models.result", requestId: "models", ok: true, models: [{ id: "model" }] }).type).toBe("agent.account.api.models.result");
    expect(parseS2C({ type: "agent.account.config.result", requestId: "config", ok: false, error: { code: "unsupported", message: "Upgrade required" } }).type).toBe("agent.account.config.result");
    expect(parseS2C({ type: "agent.accounts.result", requestId: "legacy", action: "api_configure", ok: true, accounts: [] }).type).toBe("agent.accounts.result");
  });

  it("validates bounded documents and effort independently of boolean reasoning support", () => {
    const base = { type: "agent.account.config.set", requestId: "save", accountId: "account", documentId: "codex-overrides", revision: "a".repeat(64) };
    expect(C2SAgentAccountConfigSetSchema.safeParse({ ...base, defaultEffort: null }).success).toBe(true);
    expect(C2SAgentAccountConfigSetSchema.safeParse({ ...base, defaultEffort: true }).success).toBe(false);
    expect(C2SAgentAccountConfigSetSchema.safeParse({ ...base, documentId: "../../auth.json", content: "" }).success).toBe(false);
    expect(C2SAgentAccountConfigSetSchema.safeParse({ ...base, path: "/tmp/config.toml", content: "" }).success).toBe(false);
    expect(C2SAgentAccountConfigSetSchema.safeParse({ ...base, content: "x".repeat(16_385) }).success).toBe(false);
    expect(AgentModelCapabilitiesSchema.parse({ reasoning: true, supportedEfforts: ["low", "high"] })).toMatchObject({ reasoning: true, supportedEfforts: ["low", "high"] });
    expect(AgentModelCapabilitiesSchema.safeParse({ supportedEfforts: ["unknown"] }).success).toBe(false);
  });
});
