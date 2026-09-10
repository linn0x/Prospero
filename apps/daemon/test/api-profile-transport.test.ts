import { createServer, request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountBinding } from "../src/agent-accounts.js";
import { externalResponses, forwardModelApi } from "../src/api-profile-transport.js";

const servers: Server[] = [];
const binding: AccountBinding = { id: "fixture", agent: "codex", name: "Fixture", managed: true, environment: { OPENAI_API_KEY: "fixture-key" }, apiProfile: { provider: "openai_compatible", protocol: "openai_responses", baseUrl: "https://models.invalid/v1", model: "example-model", headers: { "x-client-name": "example-client" } } };
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

async function fixture() {
  const upstream = vi.fn<typeof fetch>().mockImplementation(async () => new Response('data: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } }));
  const server = createServer((req, res) => { void forwardModelApi(req, res, id => { if (id !== binding.id) throw new Error(); return binding; }, upstream); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { upstream, url: `http://127.0.0.1:${address.port}/_prospero/model-api/fixture` };
}

describe("third-party Responses transport", () => {
  it("preserves upstream errors and retry timing", async () => {
    const { upstream, url } = await fixture();
    upstream.mockResolvedValueOnce(new Response('{"error":"busy"}', { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } }));
    const response = await fetch(`${url}/responses`, { method: "POST", headers: { authorization: "Bearer fixture-key" }, body: "{}" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.json()).toEqual({ error: "busy" });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("cancels the upstream when the caller disconnects", async () => {
    const { upstream, url } = await fixture();
    let signal: AbortSignal | undefined;
    upstream.mockImplementationOnce(async (_, init) => {
      signal = init!.signal!;
      return await new Promise<Response>((_, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const client = request(`${url}/responses`, { method: "POST", headers: { authorization: "Bearer fixture-key" } });
    client.on("error", () => {});
    client.end("{}");
    await vi.waitFor(() => expect(signal).toBeDefined());
    client.destroy();
    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
  });
  it.each(["responses", "responses/compact"])("removes only top-level client metadata from %s and preserves streaming", async endpoint => {
    const { upstream, url } = await fixture();
    const body = { model: "example-model", input: [{ role: "user", content: "Hello" }], client_metadata: { installation: "fixture" }, metadata: { keep: "value" }, tools: [{ type: "function", name: "example", parameters: { properties: { client_metadata: { type: "string" } } } }] };
    const response = await fetch(`${url}/${endpoint}`, { method: "POST", headers: { authorization: "Bearer fixture-key", "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"type":"response.completed"}\n\n');
    const [target, init] = upstream.mock.calls[0]!;
    expect(String(target)).toBe(`https://models.invalid/v1/${endpoint}`);
    const { client_metadata, ...expected } = body;
    expect(JSON.parse(String(init?.body))).toEqual(expected);
    expect(new Headers(init?.headers).get("x-client-name")).toBe("example-client");
    expect(init?.redirect).toBe("error");
  });

  it.each([
    ["responses", "wrong-key", "{}", 401],
    ["responses", "fixture-key", "[]", 400],
    ["responses", "fixture-key", "invalid", 400],
    ["elsewhere", "fixture-key", "{}", 404],
  ])("rejects invalid requests before contacting upstream", async (endpoint, key, body, status) => {
    const { upstream, url } = await fixture();
    const response = await fetch(`${url}/${endpoint}`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body });
    expect(response.status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps official accounts outside the compatibility transport", () => {
    expect(externalResponses(binding)).toBe(true);
    expect(externalResponses({ ...binding, apiProfile: { ...binding.apiProfile!, baseUrl: "https://api.openai.com/v1" } })).toBe(false);
    expect(externalResponses({ id: "native-codex", agent: "codex", name: "Native", managed: false, environment: {} })).toBe(false);
  });
});
