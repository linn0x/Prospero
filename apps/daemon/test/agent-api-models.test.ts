import { describe, expect, it, vi } from "vitest";
import { apiModelsUrl, fetchApiModels } from "../src/agent-api-models.js";
import type { AgentApiProtocol } from "@prospero/protocol";

const input = { protocol: "openai_responses" as const, baseUrl: "https://models.example/v1", apiKey: "fixture-private-key" };
const response = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("API profile model catalogs", () => {
  it.each(["openai_responses", "openai_chat_completions", "anthropic"] as const)("sends custom headers for %s catalog requests", async protocol => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: "example-model" }] }));
    await fetchApiModels({ ...input, protocol, headers: { "x-client-name": "example-client" } }, { fetch: fetcher });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-client-name": "example-client" });
  });

  it.each([{ "x-client-name": "bad\r\nInjected: value" }, { Authorization: "override" }, { Host: "elsewhere.invalid" }])("rejects invalid custom headers before sending a request", async headers => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(fetchApiModels({ ...input, headers }, { fetch: fetcher })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ["https://models.example", "openai_responses", "https://models.example/v1/models"],
    ["https://models.example/proxy/v1/responses", "openai_responses", "https://models.example/proxy/v1/models"],
    ["https://models.example/api/chat/completions", "openai_chat_completions", "https://models.example/api/models"],
    ["https://models.example/proxy/v1/messages/", "anthropic", "https://models.example/proxy/v1/models"],
    ["http://127.0.0.1:1234", "anthropic", "http://127.0.0.1:1234/v1/models"],
  ])("joins the configured endpoint without losing proxy paths: %s", (url, protocol, expected) => {
    expect(apiModelsUrl(url, protocol as AgentApiProtocol).href).toBe(expected);
  });

  it.each(["http://untrusted.example", "https://user:secret@models.example", "file:///tmp/models", "https://models.example?api_key=secret", "https://models.example/#secret"])("rejects unsafe endpoint %s", (url) => {
    expect(() => apiModelsUrl(url, "openai_responses")).toThrow();
  });

  it("normalizes, deduplicates and sorts OpenAI entries without arbitrary provider fields", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [
      { id: "zeta", owned_by: "vendor", name: "Zeta", description: "A model", api_key: input.apiKey },
      { id: "alpha", name: input.apiKey }, { id: "zeta" },
    ] }));
    const models = await fetchApiModels(input, { fetch: fetcher });
    expect(models).toEqual([{ id: "alpha" }, { id: "zeta", label: "Zeta", owner: "vendor", description: "A model" }]);
    expect(JSON.stringify(models)).not.toContain(input.apiKey);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${input.apiKey}` });
  });

  it("aggregates bounded Anthropic pages and uses the native cursor and authentication headers", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [{ id: "b", display_name: "B" }], has_more: true, last_id: "b" }))
      .mockResolvedValueOnce(response({ data: [{ id: "a" }, { id: "b" }], has_more: false, last_id: "a" }));
    expect(await fetchApiModels({ ...input, protocol: "anthropic" }, { fetch: fetcher })).toEqual([{ id: "a" }, { id: "b", label: "B" }]);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://models.example/v1/models?limit=100&after_id=b");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" });
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("imports explicitly reported gateway limits and capabilities without inferring them from model names", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [
      { id: "gpt-unknown-thinking-vision" },
      { id: "gateway", context_window: 128000, max_output_tokens: 16000, capabilities: { tools: true, vision: false, reasoning: true }, supported_reasoning_efforts: ["low", "high", "high"] },
      { id: "extension", model_capabilities: { contextWindow: 64000, tools: false, api_key: input.apiKey } },
    ] }));
    const models = await fetchApiModels(input, { fetch: fetcher });
    expect(models.find(model => model.id.startsWith("gpt-"))).toEqual({ id: "gpt-unknown-thinking-vision" });
    expect(models.find(model => model.id === "gateway")?.modelCapabilities).toEqual({ contextWindow: 128000, maxOutputTokens: 16000, tools: true, vision: false, reasoning: true, supportedEfforts: ["low", "high"] });
    expect(models.find(model => model.id === "extension")?.modelCapabilities).toEqual({ contextWindow: 64000, tools: false });
    expect(JSON.stringify(models)).not.toContain(input.apiKey);
  });

  it("reads Anthropic model limits and explicit capability flags without treating code execution as tool support", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: "claude-example", max_input_tokens: 200000, max_tokens: 64000,
      capabilities: { code_execution: { supported: true }, image_input: { supported: true }, thinking: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: false }, high: { supported: true }, max: { supported: true } } },
    }] }));
    const [model] = await fetchApiModels({ ...input, protocol: "anthropic" }, { fetch: fetcher });
    expect(model?.modelCapabilities).toEqual({ contextWindow: 200000, maxOutputTokens: 64000, vision: true, reasoning: true, supportedEfforts: ["low", "high", "max"] });
    expect(model?.modelCapabilities).not.toHaveProperty("tools");
  });

  it("keeps invalid and contradictory provider parameters unknown while retaining valid flags", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ data: [
      { id: "invalid", context_window: "128000", max_output_tokens: -1, capabilities: { tools: "true", vision: true }, supported_reasoning_efforts: [input.apiKey] },
      { id: "conflict", context_window: 100, max_output_tokens: 200, capabilities: { reasoning: false }, supported_reasoning_efforts: ["high"] },
    ] }));
    expect(await fetchApiModels(input, { fetch: fetcher })).toEqual([{ id: "conflict", modelCapabilities: { reasoning: false } }, { id: "invalid", modelCapabilities: { vision: true } }]);
  });

  it.each([[401, "authentication"], [403, "authentication"], [404, "unsupported"], [405, "unsupported"], [503, "network"]])("returns a safe typed error for status %s", async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(input.apiKey, { status: status as number }));
    const error = await fetchApiModels(input, { fetch: fetcher }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect(JSON.stringify(error)).not.toContain(input.apiKey);
  });

  it.each([
    [{ data: [] }, "empty_catalog"],
    [{ models: [] }, "invalid_format"],
    [{ data: [{ id: input.apiKey }] }, "invalid_format"],
    [{ data: [{ name: "missing ID" }] }, "invalid_format"],
    [{ data: [{ id: "a" }], has_more: true }, "invalid_format"],
    [{ data: [{ id: "a" }], has_more: "true" }, "invalid_format"],
  ])("distinguishes empty and malformed responses", async (payload, code) => {
    await expect(fetchApiModels(input, { fetch: vi.fn<typeof fetch>().mockResolvedValue(response(payload)) })).rejects.toMatchObject({ code });
  });

  it("follows only bounded same-origin redirects and never sends credentials to a redirect target on another origin", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/catalog" } }))
      .mockResolvedValueOnce(response({ data: [{ id: "a" }] }));
    expect(await fetchApiModels(input, { fetch: fetcher })).toEqual([{ id: "a" }]);
    expect(String(fetcher.mock.calls[1]?.[0])).toBe("https://models.example/catalog");
    const foreign = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://foreign.example/models" } }));
    await expect(fetchApiModels(input, { fetch: foreign })).rejects.toMatchObject({ code: "unsupported" });
    expect(foreign).toHaveBeenCalledTimes(1);
    const loop = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/catalog" } }));
    await expect(fetchApiModels(input, { fetch: loop })).rejects.toMatchObject({ code: "unsupported" });
    expect(loop).toHaveBeenCalledTimes(4);
  });

  it("enforces aggregate byte, model, and page limits including responses without content-length", async () => {
    await expect(fetchApiModels(input, { maxBytes: 10, fetch: vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: "large" }] })) })).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(fetchApiModels(input, { maxModels: 1, fetch: vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: "a" }, { id: "b" }] })) })).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(fetchApiModels(input, { maxPages: 1, fetch: vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ id: "a" }], has_more: true, last_id: "a" })) })).rejects.toMatchObject({ code: "limit_exceeded" });
  });

  it("rejects repeated pagination cursors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: [{ id: "a" }], has_more: true, last_id: "a" }));
    await expect(fetchApiModels(input, { fetch: fetcher })).rejects.toMatchObject({ code: "invalid_format" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("bounds request time and sanitizes arbitrary network exceptions", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error(input.apiKey)));
    }));
    const error = await fetchApiModels(input, { timeoutMs: 5, fetch: fetcher }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "timeout" });
    expect(JSON.stringify(error)).not.toContain(input.apiKey);
    await expect(fetchApiModels(input, { fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error(input.apiKey)) })).rejects.toMatchObject({ code: "network" });
  });
});
