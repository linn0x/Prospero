import { describe, expect, it, vi } from "vitest";
import { apiModelsUrl, fetchApiModels } from "../src/agent-api-models.js";
import type { AgentApiProtocol } from "@prospero/protocol";

const input = { protocol: "openai_responses" as const, baseUrl: "https://models.example/v1", apiKey: "fixture-private-key" };
const response = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("API profile model catalogs", () => {
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
