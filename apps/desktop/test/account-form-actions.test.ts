import { describe, expect, it } from "vitest";
import type { JsonObject } from "../src/shared/types";
import { modelCapabilityDraft } from "../src/renderer/src/account-profile-form";
import { accountCreateApiInput, accountEditActions, accountModelCatalogRequest, type AccountEditDraft } from "../src/renderer/src/accounts/account-form-actions";

const account: JsonObject = { id: "account", name: "Work", agent: "codex", activeSessions: 0, apiProfile: { protocol: "openai_responses", baseUrl: "https://provider.example/v1", model: "model" } };
const draft: AccountEditDraft = { name: "Work", protocol: "openai_responses", baseUrl: "https://provider.example/v1", model: "model", apiKey: "", modelCapabilities: modelCapabilityDraft() };

describe("account form requests", () => {
  it("uses saved credentials only for an unchanged saved connection", () => {
    expect(accountModelCatalogRequest(draft, account)).toEqual({ accountId: "account" });
    expect(accountModelCatalogRequest({ ...draft, baseUrl: "https://new.example/v1" }, account)).toBeUndefined();
    expect(accountModelCatalogRequest({ ...draft, protocol: "openai_chat_completions" }, account)).toBeUndefined();
    expect(accountModelCatalogRequest(draft)).toBeUndefined();
    expect(accountModelCatalogRequest({ ...draft, apiKey: " draft-secret ", baseUrl: "https://new.example/v1" }, account)).toEqual({ protocol: "openai_responses", baseUrl: "https://new.example/v1", apiKey: "draft-secret" });
    expect(accountModelCatalogRequest(draft, { ...account, apiProfileError: "repair" })).toBeUndefined();
  });

  it("preserves the key on modern edits and returns no action when unchanged", () => {
    expect(accountEditActions(account, draft, true, true)).toEqual([]);
    const action = accountEditActions(account, { ...draft, model: "next" }, true, true)[0]!;
    expect(action).toMatchObject({ type: "agent.account.api.configure", accountId: "account", model: "next", protocol: "openai_responses" });
    expect(action).not.toHaveProperty("apiKey");
    expect(accountEditActions(account, { ...draft, apiKey: "replacement" }, true, true)[0]).toHaveProperty("apiKey", "replacement");
  });

  it("restricts active account edits to the display name regardless of draft changes", () => {
    const active = { ...account, activeSessions: 1 };
    const changed = { ...draft, name: "Renamed", baseUrl: "https://new.example", apiKey: "never-send" };
    expect(accountEditActions(active, changed, true, true)).toEqual([{ type: "agent.account.api.configure", accountId: "account", name: "Renamed" }]);
    expect(accountEditActions(active, changed, false, false)).toEqual([{ type: "agent.account.rename", accountId: "account", name: "Renamed" }]);
    expect(accountEditActions(active, { ...changed, name: "Work" }, true, true)).toEqual([]);
  });

  it("preserves legacy rename and credential re-entry requirements", () => {
    expect(accountEditActions(account, { ...draft, name: "Renamed" }, false, false)).toEqual([{ type: "agent.account.rename", accountId: "account", name: "Renamed" }]);
    expect(() => accountEditActions(account, { ...draft, model: "next" }, false, false)).toThrow("older daemon");
    const actions = accountEditActions(account, { ...draft, name: "Renamed", model: "next", apiKey: "replacement" }, false, false);
    expect(actions).toEqual([{ type: "agent.account.api.configure", accountId: "account", baseUrl: draft.baseUrl, model: "next", apiKey: "replacement" }, { type: "agent.account.rename", accountId: "account", name: "Renamed" }]);
    expect(accountEditActions({ id: "cli", agent: "claude", name: "Personal" }, { ...draft, name: "Renamed" }, true, true)).toEqual([{ type: "agent.account.rename", accountId: "cli", name: "Renamed" }]);
  });

  it("includes capability edits only when supported and preserves explicit clears", () => {
    const withCaps = { ...account, apiProfile: { ...(account["apiProfile"] as JsonObject), modelCapabilities: { tools: true } } };
    expect(accountEditActions(withCaps, draft, true, true)[0]).toHaveProperty("modelCapabilities", null);
    expect(accountEditActions(withCaps, draft, true, false)).toEqual([]);
    const configured = accountEditActions(account, { ...draft, modelCapabilities: { ...draft.modelCapabilities, supportedEfforts: "low, high" } }, true, true)[0];
    expect(configured).toHaveProperty("modelCapabilities", { supportedEfforts: ["low", "high"] });
  });

  it("creates valid protocol-specific payloads and strips unsupported fields for legacy daemons", () => {
    const input = { ...draft, apiKey: "new-secret", modelCapabilities: { ...draft.modelCapabilities, supportedEfforts: "low" } };
    expect(accountCreateApiInput(input, true, true)).toMatchObject({ agent: "codex", protocol: "openai_responses", provider: "openai_compatible", modelCapabilities: { supportedEfforts: ["low"] } });
    const legacy = accountCreateApiInput(input, false, false);
    expect(legacy).not.toHaveProperty("protocol");
    expect(legacy).not.toHaveProperty("provider");
    expect(legacy).not.toHaveProperty("modelCapabilities");
    expect(legacy).not.toHaveProperty("type");
    expect(legacy).not.toHaveProperty("requestId");
    expect(accountCreateApiInput({ ...input, protocol: "anthropic" }, true, true)).toMatchObject({ agent: "claude", protocol: "anthropic", provider: "anthropic_compatible" });
    expect(() => accountCreateApiInput({ ...input, protocol: "openai_chat_completions" }, false, false)).toThrow("Upgrade");
    expect(() => accountCreateApiInput(draft, true, true)).toThrow("Complete");
  });
});
