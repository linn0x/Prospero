import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";
import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { AccountBinding } from "../src/agent-accounts.js";
import { probeApiProfileEngine, type ApiProfileEngineProbeOptions } from "../src/api-profile-engine-probe.js";

type Json = Record<string, any>;
const SECRET = "synthetic-upstream-secret-never-a-real-key";
const TOOL = "prospero_connection_probe";
const binding: AccountBinding = {
  id: "isolated-unit-profile", agent: "codex", name: "Unit fixture", managed: true,
  apiProfile: { provider: "openai_compatible", protocol: "openai_responses", baseUrl: "https://never-contact-upstream.invalid/v1", model: "unit-model", modelCapabilities: { maxOutputTokens: 512 } },
  environment: { OPENAI_API_KEY: SECRET, PROSPERO_TEST_UNTRUSTED_ENV: "must-not-reach-child" },
};
const sse = (output: Json[], padding = ""): string => `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output }, padding })}\n\n`;

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly pid = undefined;
  killed = false;
  finish(): void { this.exitCode = 0; this.emit("close", 0); }
  kill(): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true; this.signalCode = "SIGKILL";
    queueMicrotask(() => this.emit("close", null, "SIGKILL"));
    return true;
  }
  message(value: Json): void { this.stdout.write(JSON.stringify(value) + "\n"); }
}

interface Scenario {
  mutate?: (request: { url: string; headers: Record<string, string>; body: Json }, turn: number) => void;
  upstream?: (body: Json, turn: number, signal: AbortSignal) => Promise<Response> | Response;
  extraRequest?: boolean;
  runtimeTool?: string;
  excessiveRuntimeOutput?: boolean;
}

/** A fake app-server speaks the public JSON-RPC boundary; only the probe's loopback gateway opens a socket. */
function harness(scenario: Scenario = {}) {
  const children: FakeChild[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const requests: Json[] = [];
  let toolResults = 0;
  let deliveredStreams = 0;
  const upstream = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Json;
    requests.push(body);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(String(_input)).toBe("https://never-contact-upstream.invalid/v1/responses");
    if (scenario.upstream) return scenario.upstream(body, requests.length, init?.signal as AbortSignal);
    const output = requests.length === 1
      ? [{ type: "function_call", name: TOOL, arguments: JSON.stringify({ nonce: body.tools[0].parameters.properties.nonce.enum[0] }) }]
      : [{ type: "message", content: [{ type: "output_text", text: body.input.at(-1).output }] }];
    return new Response(sse(output), { headers: { "content-type": "text/event-stream" } });
  });
  const spawnFake = vi.fn((_file: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const child = new FakeChild(); children.push(child); environments.push({ ...options.env });
    if (children.length === 1) {
      queueMicrotask(() => { child.stdout.write("codex 1.2.3\n"); child.finish(); });
      return child as unknown as ChildProcess;
    }
    // Windows passes CLI arguments inside an encoded PowerShell launcher.
    let command = args.join("\n");
    if (args.includes("-EncodedCommand")) {
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
      const payload = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
      if (!payload) throw new Error("fixture did not receive encoded arguments");
      command = (JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as string[]).join("\n");
    }
    const baseUrl = command.match(/base_url="([^"]+)"/)?.[1];
    if (!baseUrl) throw new Error("fixture did not receive a configured gateway");
    let thread: Json;
    let receiveTool!: (receipt: string) => void;
    const receipt = new Promise<string>((resolve) => { receiveTool = resolve; });
    const post = async (body: Json, turn: number): Promise<string> => {
      const request = { url: `${baseUrl}/responses`, headers: { "content-type": "application/json", authorization: `Bearer ${options.env.OPENAI_API_KEY}` }, body };
      scenario.mutate?.(request, turn);
      expect(new URL(request.url).hostname).toBe("127.0.0.1");
      expect(new URL(request.url).protocol).toBe("http:");
      const response = await globalThis.fetch(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
      const raw = await response.text();
      if (!response.ok) throw new Error("gateway rejected fake runtime request");
      deliveredStreams += 1;
      return raw;
    };
    const run = async (input: Json[]): Promise<void> => {
      if (scenario.excessiveRuntimeOutput) { child.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
      if (scenario.runtimeTool) { child.message({ id: 999, method: "item/tool/call", params: { tool: scenario.runtimeTool, arguments: {} } }); return; }
      const tool = thread.dynamicTools[0];
      const body = { model: thread.model, stream: true, max_output_tokens: 999999, tools: [{ type: "function", name: tool.name, parameters: tool.inputSchema }], input };
      const raw = await post(body, 1);
      const event = JSON.parse(raw.slice(6).trim()) as Json;
      const call = event.response.output[0];
      child.message({ id: 999, method: "item/tool/call", params: { tool: call.name, arguments: JSON.parse(call.arguments) } });
      const result = await receipt;
      const second = { ...body, input: [...input, { type: "function_call_output", output: result }] };
      await post(second, 2);
      if (scenario.extraRequest) await post(second, 3);
      child.message({ method: "item/agentMessage/delta", params: { delta: result } });
      child.message({ method: "turn/completed", params: { turn: { status: "completed" } } });
    };
    child.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").trim().split("\n")) {
        const message = JSON.parse(line) as Json;
        if (message.id === 999) { toolResults += 1; receiveTool(message.result?.contentItems?.[0]?.text ?? ""); }
        else if (message.method === "initialize") child.message({ id: message.id, result: { codexHome: options.env.CODEX_HOME } });
        else if (message.method === "thread/start") { thread = message.params; child.message({ id: message.id, result: { model: thread.model, thread: { id: "fake-thread" } } }); }
        else if (message.method === "turn/start") {
          child.message({ id: message.id, result: {} });
          void run(message.params.input).catch(() => child.message({ method: "error", params: {} }));
        }
      }
    });
    return child as unknown as ChildProcess;
  });
  return {
    options: { spawn: spawnFake as unknown as typeof spawn, fetch: upstream as typeof globalThis.fetch, executable: "codex", timeoutMs: 3000 },
    children, environments, upstream, requests,
    get toolResults() { return toolResults; }, get deliveredStreams() { return deliveredStreams; },
  };
}

function pendingResponse(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted synthetic upstream"));
    else signal.addEventListener("abort", () => reject(new Error("aborted synthetic upstream")), { once: true });
  });
}

describe("isolated engine probe safety boundaries with fake runtime and upstream", () => {
  it("completes one synthetic tool roundtrip with bounded output and isolates credentials, environment and files", async () => {
    const fixture = harness();
    const result = await probeApiProfileEngine(binding, fixture.options);
    expect(result).toMatchObject({ status: "passed", cliVersion: "1.2.3", checks: { runtime: "passed", configuration: "passed", streaming: "passed", tools: "passed" } });
    expect(fixture.upstream).toHaveBeenCalledTimes(2);
    expect(fixture.requests.every((body) => body.max_output_tokens === 512)).toBe(true);
    expect(fixture.toolResults).toBe(1);
    expect(fixture.children[1]?.killed).toBe(true);
    for (const env of fixture.environments) {
      expect(JSON.stringify(env)).not.toContain(SECRET);
      expect(env.PROSPERO_TEST_UNTRUSTED_ENV).toBeUndefined();
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(existsSync(env.HOME!)).toBe(false);
    }
  });

  it.each(["credential", "model", "stream", "endpoint"])("rejects an engine %s mismatch before upstream forwarding", async (kind) => {
    const fixture = harness({ mutate: (request) => {
      if (kind === "credential") request.headers.authorization = "Bearer unrelated-local-token";
      if (kind === "model") request.body.model = "wrong-model";
      if (kind === "stream") request.body.stream = false;
      if (kind === "endpoint") request.url += "/unexpected";
    } });
    expect(await probeApiProfileEngine(binding, fixture.options)).toMatchObject({ status: "failed", code: "configuration_mismatch", checks: { configuration: "failed" } });
    expect(fixture.upstream).not.toHaveBeenCalled();
    expect(fixture.toolResults).toBe(0);
  });

  it.each([
    { type: "function_call", name: "exec", arguments: "{}" },
    { type: "custom_tool_call", name: "exec", input: "side effect" },
    { type: "web_search_call", action: { type: "search", query: "outside probe" } },
  ])("withholds an unsafe completed SSE output $type from the runtime", async (output) => {
    const fixture = harness({ upstream: () => new Response(sse([output]), { headers: { "content-type": "text/event-stream" } }) });
    expect(await probeApiProfileEngine(binding, fixture.options)).toMatchObject({ status: "failed", code: "unexpected_tool_call" });
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
    expect(fixture.deliveredStreams).toBe(0);
    expect(fixture.toolResults).toBe(0);
  });

  it("refuses a runtime's direct request to execute an unregistered tool", async () => {
    const fixture = harness({ runtimeTool: "exec" });
    expect(await probeApiProfileEngine(binding, fixture.options)).toMatchObject({ status: "failed", code: "tool_call_invalid" });
    expect(fixture.upstream).not.toHaveBeenCalled();
    expect(fixture.children[1]?.killed).toBe(true);
  });

  it("rejects an oversized runtime request before forwarding", async () => {
    const fixture = harness({ mutate: (request) => { request.body.padding = "x".repeat(512 * 1024); } });
    expect(await probeApiProfileEngine(binding, fixture.options)).toMatchObject({ status: "failed", code: "request_too_large" });
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it("rejects an oversized upstream response before exposing it to the runtime", async () => {
    const fixture = harness({ upstream: () => new Response("x".repeat(512 * 1024 + 1), { headers: { "content-type": "text/event-stream" } }) });
    expect(await probeApiProfileEngine(binding, fixture.options)).toMatchObject({ status: "failed", code: "response_too_large" });
    expect(fixture.deliveredStreams).toBe(0);
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
  });

  it("enforces the response byte budget across both model turns", async () => {
    const fixture = harness({ upstream: (body, turn) => {
      const output = turn === 1 ? [{ type: "function_call", name: TOOL, arguments: JSON.stringify({ nonce: body.tools[0].parameters.properties.nonce.enum[0] }) }]
        : [{ type: "message", content: [{ type: "output_text", text: body.input.at(-1).output }] }];
      return new Response(sse(output, "x".repeat(270 * 1024)), { headers: { "content-type": "text/event-stream" } });
    } });
    expect(await probeApiProfileEngine(binding, fixture.options)).toMatchObject({ status: "failed", code: "response_too_large" });
    expect(fixture.upstream).toHaveBeenCalledTimes(2);
    expect(fixture.deliveredStreams).toBe(1);
  });

  it("prevents a third model request even after a successful tool roundtrip", async () => {
    const fixture = harness({ extraRequest: true });
    expect(await probeApiProfileEngine(binding, fixture.options)).toMatchObject({ status: "failed", code: "request_limit" });
    expect(fixture.upstream).toHaveBeenCalledTimes(2);
    expect(fixture.toolResults).toBe(1);
  });

  it("aborts the upstream and stops the runtime when cancelled during a request", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fixture = harness({ upstream: (_body, _turn, signal) => {
      observedSignal = signal; queueMicrotask(() => controller.abort()); return pendingResponse(signal);
    } });
    expect(await probeApiProfileEngine(binding, { ...fixture.options, signal: controller.signal })).toMatchObject({ status: "failed", code: "cancelled" });
    expect(observedSignal?.aborted).toBe(true);
    expect(fixture.children[1]?.killed).toBe(true);
    expect(existsSync(fixture.environments[1]!.HOME!)).toBe(false);
  });

  it("enforces the total timeout on a stalled upstream and cleans up the runtime", async () => {
    const fixture = harness({ upstream: (_body, _turn, signal) => pendingResponse(signal) });
    expect(await probeApiProfileEngine(binding, { ...fixture.options, timeoutMs: 250 })).toMatchObject({ status: "failed", code: "timeout" });
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
    expect(fixture.children[1]?.killed).toBe(true);
  });

  it("does not start any runtime for an already-cancelled probe", async () => {
    const fixture = harness(); const controller = new AbortController(); controller.abort();
    expect(await probeApiProfileEngine(binding, { ...fixture.options, signal: controller.signal })).toMatchObject({ status: "failed", code: "cancelled" });
    expect(fixture.children).toHaveLength(0);
    expect(fixture.upstream).not.toHaveBeenCalled();
  });

  it("does not retry upstream errors or expose upstream error payloads", async () => {
    const fixture = harness({ upstream: () => new Response(JSON.stringify({ message: SECRET }), { status: 429 }) });
    const result = await probeApiProfileEngine(binding, fixture.options);
    expect(result).toMatchObject({ status: "failed", code: "rate_limited" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(fixture.upstream).toHaveBeenCalledTimes(1);
  });

  it("stops excessive process output without contacting upstream", async () => {
    const fixture = harness({ excessiveRuntimeOutput: true });
    expect(await probeApiProfileEngine(binding, fixture.options)).toMatchObject({ status: "failed", code: "runtime_output_limit" });
    expect(fixture.upstream).not.toHaveBeenCalled();
    expect(fixture.children[1]?.killed).toBe(true);
  });

  it.each(["wrong_credential", "unknown_tool", "server_tool"])("rejects Anthropic %s through the SDK gateway and closes the SDK query", async (kind) => {
    const fixture = harness();
    const close = vi.fn();
    const upstream = vi.fn(async () => new Response([
      { type: "content_block_start", index: 0, content_block: kind === "server_tool" ? { type: "server_tool_use", name: "web_search" } : { type: "tool_use", name: "Bash", input: {} } },
      { type: "message_stop" },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    const fakeQuery = vi.fn(({ options }: { options: Json }) => Object.assign((async function* () {
      expect(options.env.ANTHROPIC_API_KEY).not.toBe(SECRET);
      expect(options.env.PROSPERO_TEST_UNTRUSTED_ENV).toBeUndefined();
      expect(new URL(options.env.ANTHROPIC_BASE_URL).hostname).toBe("127.0.0.1");
      expect(new URL(options.env.ANTHROPIC_BASE_URL).protocol).toBe("http:");
      const response = await globalThis.fetch(`${options.env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": kind === "wrong_credential" ? "unrelated-local-token" : options.env.ANTHROPIC_API_KEY },
        body: JSON.stringify({ model: "unit-model", stream: true, tools: [{ name: `mcp__prospero_probe__${TOOL}` }], messages: [] }),
      });
      await response.text();
      yield { type: "result", subtype: "success", is_error: false };
    })(), { close }));
    const anthropic: AccountBinding = { ...binding, agent: "claude", apiProfile: { ...binding.apiProfile!, provider: "anthropic_compatible", protocol: "anthropic" }, environment: { ANTHROPIC_API_KEY: SECRET, PROSPERO_TEST_UNTRUSTED_ENV: "must-not-reach-child" } };
    const result = await probeApiProfileEngine(anthropic, { ...fixture.options, fetch: upstream, claudeQuery: fakeQuery as unknown as NonNullable<ApiProfileEngineProbeOptions["claudeQuery"]> });
    expect(result).toMatchObject({ status: "failed", engine: "claude", code: kind === "wrong_credential" ? "configuration_mismatch" : "unexpected_tool_call" });
    expect(upstream).toHaveBeenCalledTimes(kind === "wrong_credential" ? 0 : 1);
    expect(close).toHaveBeenCalledOnce();
  });
});
