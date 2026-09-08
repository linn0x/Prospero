import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ModelSource } from "../src/shared/types";
import { modelSourceRequest, modelSourceResult } from "../src/shared/model-sources";
import { catalogRouteDraft, catalogRouteUpdates, defaultSourceSelection, hasPartialCatalogLimits, retainSourceRouteDrafts, selectedSourceRoute, sourceDraftRoutes, sourceRouteAgent } from "../src/renderer/src/model-sources/source-state";
import { SourceSelector } from "../src/renderer/src/model-sources/SourceSelector";
import { SourceOnboardingModels } from "../src/renderer/src/model-sources/SourceOnboardingModels";
import { accountApiConnectionLocked } from "../src/renderer/src/account-profile-form";

vi.mock("../src/renderer/src/locale", () => ({ useLocale: () => ({ t: (_zh: string, en: string) => en }) }));
const source: ModelSource = { id: "source", name: "Shared models", revision: 2, enabled: true, endpoints: [{ protocol: "openai_responses", baseUrl: "https://models.invalid/v1" }], credentials: [{ id: "credential", name: "Shared key", revision: 1 }], routes: [{ id: "route-a", name: "Model A", model: "model-a", protocol: "openai_responses", credentialId: "credential", enabled: true }, { id: "route-b", name: "Model B", model: "model-b", protocol: "openai_responses", credentialId: "credential", enabled: true }], defaultRouteId: "route-b", createdAt: 1, updatedAt: 1 };

describe("model source selection and IPC", () => {
  it.each([{ contextWindow: 128000 }, { maxOutputTokens: 16000 }])("omits an incomplete Chat Completions limit pair without blocking the batch or inventing values: %j", limits => {
    const models = [{ id: "partial", modelCapabilities: { ...limits, tools: true } }, { id: "complete", modelCapabilities: { contextWindow: 128000, maxOutputTokens: 16000 } }];
    const updates = catalogRouteUpdates(source, "openai_chat_completions", "credential", models, new Set(models.map(model => model.id)));
    expect(updates).toHaveLength(2);
    expect(updates[0]?.modelCapabilities).toEqual({ tools: true });
    expect(updates[1]?.modelCapabilities).toEqual(models[1]!.modelCapabilities);
    expect(models[0]!.modelCapabilities).toMatchObject(limits);
    const draft = catalogRouteDraft(models[0]!, "openai_chat_completions");
    expect(draft.partialTokenLimits).toMatchObject(limits);
    expect(sourceDraftRoutes([draft])[0]?.modelCapabilities).toEqual({ tools: true });
    expect(hasPartialCatalogLimits(models[0]!, "openai_responses")).toBe(false);
    expect(sourceDraftRoutes([catalogRouteDraft(models[0]!, "openai_responses")])[0]?.modelCapabilities).toMatchObject(limits);
    expect(() => sourceDraftRoutes([{ ...draft, capabilities: { ...draft.capabilities, contextWindow: "128000" } }])).toThrow("两个 Token 上限");
  });

  it("preserves unmodified protocols, parameter edits and default order when endpoints are added, removed or changed", () => {
    const responses = { protocol: "openai_responses" as const, baseUrl: "https://responses.invalid/v1" };
    const anthropic = { protocol: "anthropic" as const, baseUrl: "https://anthropic.invalid" };
    const first = { ...catalogRouteDraft({ id: "a", modelCapabilities: { contextWindow: 64000, supportedEfforts: ["high"] } }, "openai_responses"), name: "Edited default", effort: "high" };
    const second = catalogRouteDraft({ id: "b" }, "anthropic");
    expect(retainSourceRouteDrafts([responses], [responses, anthropic], [first])).toEqual([first]);
    expect(retainSourceRouteDrafts([responses, anthropic], [responses, { ...anthropic, baseUrl: "https://changed.invalid" }], [first, second])).toEqual([first]);
    expect(retainSourceRouteDrafts([responses, anthropic], [anthropic], [first, second])).toEqual([second]);
    const retained = retainSourceRouteDrafts([responses, anthropic], [{ ...responses, baseUrl: responses.baseUrl + "/" }, anthropic], [first, second]);
    expect(retained[0]).toBe(first);
    expect(retained[1]).toBe(second);
    expect(sourceDraftRoutes(retained)[0]).toMatchObject({ name: "Edited default", defaultEffort: "high", modelCapabilities: { contextWindow: 64000 } });
  });

  it("explains partial directory limits in onboarding instead of presenting them as applied", () => {
    const draft = catalogRouteDraft({ id: "partial", modelCapabilities: { contextWindow: 64000 } }, "openai_chat_completions");
    const html = renderToStaticMarkup(<SourceOnboardingModels endpoints={[{ protocol: "openai_chat_completions", baseUrl: "https://models.invalid" }]} apiKey="synthetic-key" value={[draft]} onChange={() => {}} onBusy={() => {}} />);
    expect(html).toContain("The catalog reported only one token limit");
    expect(html).toContain("64000");
    expect(html).toContain("neither is applied yet");
  });
  it("selects enabled default models and never silently upgrades an open selection", () => {
    const selection = defaultSourceSelection([source])!;
    expect(selection).toEqual({ sourceId: "source", routeId: "route-b", revision: 2 });
    expect(selectedSourceRoute([source], selection)?.route.model).toBe("model-b");
    expect(selectedSourceRoute([{ ...source, revision: 3 }], selection)).toBeUndefined();
    expect(defaultSourceSelection([{ ...source, enabled: false }])).toBeUndefined();
    expect(defaultSourceSelection([source], { sourceId: source.id, routeId: "route-a" })?.routeId).toBe("route-a");
  });

  it("does not enable models explicitly lacking tools and derives the correct account family", () => {
    const noTools = { ...source, routes: source.routes.map(route => ({ ...route, modelCapabilities: { tools: false } })) };
    expect(defaultSourceSelection([noTools])).toBeUndefined();
    expect(sourceRouteAgent(source.routes[0]!)).toBe("codex");
    expect(sourceRouteAgent({ ...source.routes[0]!, protocol: "anthropic" })).toBe("claude");
  });

  it("preserves configured model capabilities when enabling an existing catalog model", () => {
    const configured = { ...source, routes: [{ ...source.routes[0]!, enabled: false, modelCapabilities: { tools: true, contextWindow: 64000 } }] };
    const updates = catalogRouteUpdates(configured, "openai_responses", "credential", [{ id: "model-a", label: "New label" }, { id: "new", label: " " }], new Set(["model-a", "new"]));
    expect(updates[0]).toMatchObject({ id: "route-a", name: "Model A", modelCapabilities: { contextWindow: 64000 }, enabled: true });
    expect(updates[1]).toMatchObject({ name: "new", model: "new" });
  });

  it("prepares editable onboarding parameters and preserves the selected default order", () => {
    const discovered = catalogRouteDraft({ id: "a", modelCapabilities: { contextWindow: 128000, maxOutputTokens: 16000, tools: true, supportedEfforts: ["low", "high"] } }, "openai_responses");
    expect(discovered.capabilities.contextWindow).toBe("128000");
    expect(discovered.capabilities.vision).toBe("unknown");
    const manual = catalogRouteDraft({ id: "manual" }, "anthropic");
    const routes = sourceDraftRoutes([manual, { ...discovered, effort: "high" }]);
    expect(routes[0]).toEqual({ name: "manual", model: "manual", protocol: "anthropic", enabled: true });
    expect(routes[1]).toMatchObject({ defaultEffort: "high", modelCapabilities: { contextWindow: 128000, tools: true } });
    expect(() => sourceDraftRoutes([{ ...discovered, effort: "max" }])).toThrow();
    expect(() => sourceDraftRoutes([{ ...discovered, capabilities: { ...discovered.capabilities, maxOutputTokens: "999999" } }])).toThrow();
  });

  it("imports reported parameters only for new catalog routes", () => {
    const updates = catalogRouteUpdates(source, "openai_responses", "credential", [{ id: "model-a", modelCapabilities: { vision: true } }, { id: "new", modelCapabilities: { tools: true, contextWindow: 64000 } }], new Set(["model-a", "new"]));
    expect(updates[0]).not.toHaveProperty("modelCapabilities");
    expect(updates[1]?.modelCapabilities).toEqual({ tools: true, contextWindow: 64000 });
  });

  it("offers model discovery and parameter editing before saving a source", () => {
    const draft = catalogRouteDraft({ id: "discovered", modelCapabilities: { contextWindow: 64000, tools: true } }, "openai_responses");
    const html = renderToStaticMarkup(<SourceOnboardingModels endpoints={source.endpoints} apiKey="synthetic-onboarding-secret" value={[draft]} onChange={() => {}} onBusy={() => {}} />);
    expect(html).toContain("Connect and load models");
    expect(html).toContain('value="64000"');
    expect(html).toContain("Default reasoning effort");
    expect(html).toContain("Unknown");
    expect(html).not.toContain("synthetic-onboarding-secret");
    const css = readFileSync(new URL("../src/renderer/src/model-sources/model-sources.css", import.meta.url), "utf8");
    expect(css).toContain('.model-source-catalog-list input[type="checkbox"]');
    expect(css).toContain("width: 16px; height: 16px;");
  });

  it("displays source and model controls without requiring the user to pick a duplicated account", () => {
    const html = renderToStaticMarkup(<SourceSelector sources={[source]} loading={false} error={undefined} value={defaultSourceSelection([source])} disabled={false} onChange={() => {}} onRefresh={() => {}} />);
    expect(html).toContain('id="session-model-source"');
    expect(html).toContain('id="session-source-route"');
    expect(html).toContain("Shared key");
    expect(html).toContain("stays on this version");
    expect(html).not.toContain('type="password"');
  });

  it("keeps sources and native accounts on the same page, without a new navigation tab", () => {
    const accounts = readFileSync(new URL("../src/renderer/src/accounts/AccountsPane.tsx", import.meta.url), "utf8");
    expect(accounts).toContain("<ModelSourcesPane");
    expect(accounts).toContain("<AccountCreateForm");
    expect(accounts).not.toContain('role="tab"');
    expect(accounts).toContain("showBindings || !account.modelSource");
    expect(accountApiConnectionLocked({ activeSessions: 0, modelSource: { sourceId: "source" } })).toBe(true);
  });

  it("validates action arguments and result correlation, never exposing secret metadata", () => {
    expect(modelSourceRequest({ kind: "list" }, "request").type).toBe("model.source.action");
    expect(() => modelSourceRequest({ kind: "models", sourceId: "source", revision: 2, credentialId: "credential", protocol: "openai_responses", baseUrl: "https://unexpected.invalid" }, "request")).toThrow();
    const result = modelSourceResult({ type: "model.source.result", requestId: "request", ok: true, sources: [{ ...source, credentials: [{ ...source.credentials[0], secret: "synthetic-private" }] }], secret: "synthetic-private" }, "request", "list");
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(() => modelSourceResult(result, "wrong-request")).toThrow();
    expect(() => modelSourceResult({ type: "model.source.result", requestId: "request", ok: true }, "request", "bind")).toThrow();
    expect(() => modelSourceResult({ type: "model.source.result", requestId: "request", ok: false }, "request")).toThrow();
  });
});
