import { describe, expect, it } from "vitest";
import { accountModelsRequest, accountConfigRequest, accountModelsResult, accountConfigResult } from "../src/shared/account-features";

describe("desktop account feature IPC contracts", () => {
  it("separates saved credentials from draft destinations", () => {
    expect(accountModelsRequest({ accountId: "profile" }, "request")).toEqual({ type: "agent.account.api.models.get", requestId: "request", accountId: "profile" });
    expect(accountModelsRequest({ protocol: "anthropic", baseUrl: "https://provider.example", apiKey: "temporary-key" }, "draft")).toMatchObject({ protocol: "anthropic", apiKey: "temporary-key" });
    expect(() => accountModelsRequest({ accountId: "profile", baseUrl: "https://other.example" }, "request")).toThrow("保存");
    expect(() => accountModelsRequest({ baseUrl: "https://provider.example" }, "request")).toThrow();
  });

  it("rejects arbitrary configuration paths and non-versioned writes", () => {
    expect(accountConfigRequest({ accountId: "profile" }, "read", false)).toMatchObject({ type: "agent.account.config.get" });
    expect(() => accountConfigRequest({ accountId: "profile", path: "/etc/config.toml" }, "read", false)).toThrow();
    expect(() => accountConfigRequest({ accountId: "profile", documentId: "../auth", revision: "a".repeat(64) }, "write", true)).toThrow();
    expect(() => accountConfigRequest({ accountId: "profile", documentId: "codex-overrides", content: "" }, "write", true)).toThrow();
    expect(accountConfigRequest({ accountId: "profile", documentId: "codex-overrides", revision: "a".repeat(64), defaultEffort: null }, "write", true)).toMatchObject({ defaultEffort: null });
  });

  it("validates correlation and excludes unexpected fields from public results", () => {
    const raw = { type: "agent.account.api.models.result", requestId: "same", ok: true, models: [{ id: "model-a", apiKey: "not-public" }], credential: "not-public" };
    expect(JSON.stringify(accountModelsResult(raw, "same"))).not.toContain("not-public");
    expect(() => accountModelsResult(raw, "different")).toThrow();
    expect(() => accountModelsResult({ ...raw, models: [{ description: "no id" }] }, "same")).toThrow();
    const failure = { type: "agent.account.config.result", requestId: "same", ok: false, error: { code: "conflict", message: "Reload", line: 3 } };
    expect(accountConfigResult(failure, "same", "profile").error).toMatchObject({ code: "conflict", line: 3 });
    expect(() => accountConfigResult(failure, "different")).toThrow();
    expect(() => accountConfigResult({ ...failure, ok: true, error: undefined, config: { accountId: "another", documents: [], supportedEfforts: [], appliesTo: "new_sessions", activeSessions: 0 } }, "same", "profile")).toThrow();
  });
});
