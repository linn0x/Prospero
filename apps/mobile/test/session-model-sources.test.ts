import { describe, expect, it } from "vitest";
import type { ModelSource, ModelSourceRoute } from "@prospero/protocol";
import { agentForSourceRoute, availableSourceRoutes, modelSourcePresentation, sourceCatalogTarget, sourceRouteMatchesAgent } from "../src/lib/session-model-sources";

const route = (id: string, model: string, protocol: ModelSourceRoute["protocol"] = "openai_responses"): ModelSourceRoute => ({ id, name: id, model, protocol, credentialId: "key", enabled: true });
const source = (routes: ModelSourceRoute[], defaultRouteId?: string): ModelSource => ({
  id: "source", name: "Source", revision: 1, enabled: true,
  endpoints: [
    { protocol: "openai_responses", baseUrl: "https://example.test/v1" },
    { protocol: "openai_chat_completions", baseUrl: "https://example.test/v1" },
    { protocol: "anthropic", baseUrl: "https://example.test/v1" },
  ],
  credentials: [{ id: "key", name: "Key", revision: 1 }], routes, defaultRouteId, createdAt: 1, updatedAt: 1,
});

describe("model source selection", () => {
  it("uses a side panel for a wide landscape foldable and a bottom sheet for portrait", () => {
    expect(modelSourcePresentation(932, 704)).toBe("side");
    expect(modelSourcePresentation(704, 932)).toBe("bottom");
    expect(modelSourcePresentation(667, 375)).toBe("bottom");
  });
  it("deduplicates by exact model ID, retains distinct context variants, and prefers the default route", () => {
    const models = source([route("first", "model"), route("variant", "model[1m]"), route("default", "model")], "default");
    expect(availableSourceRoutes(models, "codex").map((item) => item.id)).toEqual(["default", "variant"]);
  });
  it("omits disabled and tool-less routes and chooses compatible agents", () => {
    const anthropic = route("claude", "m1", "anthropic");
    const responses = route("responses", "m2");
    const chat = route("chat", "m3", "openai_chat_completions");
    const disabled = { ...route("disabled", "m4"), enabled: false };
    const noTools = { ...route("no-tools", "m5"), modelCapabilities: { tools: false } };
    expect(availableSourceRoutes(source([anthropic, responses, chat, disabled, noTools]), "claude")).toEqual([anthropic]);
    expect(availableSourceRoutes(source([anthropic, responses, chat, disabled, noTools]), "codex")).toEqual([responses, chat]);
    expect(availableSourceRoutes(source([anthropic, responses, chat, disabled, noTools]), "opencode")).toEqual([chat]);
    expect(agentForSourceRoute(anthropic, "codex")).toBe("claude");
    expect(agentForSourceRoute(responses, "claude")).toBe("codex");
    expect(agentForSourceRoute(chat, "opencode")).toBe("opencode");
    expect(agentForSourceRoute(chat, "claude")).toBe("codex");
    expect(sourceRouteMatchesAgent(anthropic, "claude")).toBe(true);
    expect(sourceRouteMatchesAgent(responses, "claude")).toBe(false);
  });
  it("loads catalogs only through the selected agent protocol", () => {
    const openAiOnly = { ...source([route("responses", "m1")]), endpoints: [{ protocol: "openai_responses" as const, baseUrl: "https://example.test/v1" }] };
    expect(sourceCatalogTarget(openAiOnly, "claude")).toBeNull();
    expect(sourceCatalogTarget(source([route("responses", "m1")]), "claude")).toEqual({ protocol: "anthropic", credentialId: "key" });
    expect(sourceCatalogTarget(source([route("claude", "m1", "anthropic")], "claude"), "claude")).toEqual({ protocol: "anthropic", credentialId: "key" });
    expect(sourceCatalogTarget(source([route("chat", "m1", "openai_chat_completions")], "chat"), "opencode")).toEqual({ protocol: "openai_chat_completions", credentialId: "key" });
    expect(sourceCatalogTarget(source([route("responses", "m1")]), "codex")).toEqual({ protocol: "openai_responses", credentialId: "key" });
  });
});
