import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentApiProtocol } from "@prospero/protocol";
import type { AccountBinding } from "../src/agent-accounts.js";
import { probeApiProfile } from "../src/api-profile-probe.js";

type Json = Record<string, any>;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

async function fixture(protocol: AgentApiProtocol, handler: (body: Json, response: ServerResponse, number: number, request: IncomingMessage) => void) {
  const requests: { body: Json; url: string; headers: IncomingMessage["headers"] }[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw) as Json;
      requests.push({ body, url: request.url ?? "", headers: request.headers });
      handler(body, response, requests.length, request);
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const anthropic = protocol === "anthropic";
  const binding: AccountBinding = {
    id: "synthetic-api-profile", agent: anthropic ? "claude" : "codex", name: "Synthetic local test", managed: true,
    apiProfile: { provider: anthropic ? "anthropic_compatible" : "openai_compatible", protocol, model: "synthetic-model", baseUrl: `http://127.0.0.1:${address.port}${anthropic ? "" : "/v1"}` },
    environment: { [anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]: "synthetic-test-key-never-real" },
    ...(protocol === "openai_chat_completions" ? { adapterAgent: "opencode" as const } : {}),
  };
  return { binding, requests, server };
}

function sse(events: (Json | string)[]): string {
  return events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`).join("");
}

function toolInfo(protocol: AgentApiProtocol, body: Json): { name: string; nonce: string } {
  const tool = protocol === "openai_chat_completions" ? body.tools[0].function : body.tools[0];
  const schema = protocol === "anthropic" ? tool.input_schema : tool.parameters;
  return { name: tool.name, nonce: schema.properties.nonce.enum[0] };
}

function receiptFor(protocol: AgentApiProtocol, body: Json): string {
  if (protocol === "openai_responses") return body.input.at(-1).output;
  if (protocol === "anthropic") return body.messages.at(-1).content[0].content;
  return body.messages.at(-1).content;
}

/** Independent fixtures emit the official streaming shapes rather than reusing parser helpers. */
function eventsFor(protocol: AgentApiProtocol, body: Json, turn: number, options: { duplicate?: boolean; wrongArguments?: boolean; wrongReceipt?: boolean; replay?: boolean } = {}): (Json | string)[] {
  const info = toolInfo(protocol, body);
  const argumentsValue = JSON.stringify({ nonce: options.wrongArguments ? "wrong" : info.nonce });
  const wantsTool = turn === 1 || options.replay;
  const text = wantsTool ? "" : options.wrongReceipt ? "ignored tool result" : receiptFor(protocol, body);
  const count = options.duplicate ? 2 : 1;
  if (protocol === "openai_chat_completions") {
    const chunk = (delta: Json, finish_reason: string | null = null): Json => ({ id: "chatcmpl-synthetic", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    return [
      chunk({ role: "assistant" }),
      ...(wantsTool ? Array.from({ length: count }, (_, index) => [
        chunk({ tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: info.name, arguments: argumentsValue.slice(0, 10) } }] }),
        chunk({ tool_calls: [{ index, function: { arguments: argumentsValue.slice(10) } }] }),
      ]).flat() : [chunk({ content: text.slice(0, 8) }), chunk({ content: text.slice(8) })]),
      chunk({}, wantsTool ? "tool_calls" : "stop"),
      "[DONE]",
    ];
  }
  if (protocol === "openai_responses") {
    const output = wantsTool ? Array.from({ length: count }, (_, index) => ({ type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: info.name, arguments: argumentsValue, status: "completed" })) : [{ type: "message", id: "msg_probe", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
    return [
      { type: "response.created", response: { id: "resp_probe", status: "in_progress", output: [] } },
      ...(wantsTool ? output.flatMap((item, index) => [
        { type: "response.output_item.added", output_index: index, item: { ...item, arguments: "", status: "in_progress" } },
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: argumentsValue.slice(0, 10) },
        { type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: argumentsValue.slice(10) },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index: index, arguments: argumentsValue },
        { type: "response.output_item.done", output_index: index, item },
      ]) : [
        { type: "response.output_item.added", output_index: 0, item: { ...output[0], status: "in_progress", content: [] } },
        { type: "response.output_text.delta", item_id: "msg_probe", output_index: 0, content_index: 0, delta: text.slice(0, 8) },
        { type: "response.output_text.delta", item_id: "msg_probe", output_index: 0, content_index: 0, delta: text.slice(8) },
        { type: "response.output_item.done", output_index: 0, item: output[0] },
      ]),
      { type: "response.completed", response: { id: "resp_probe", status: "completed", output } },
    ];
  }
  return [
    { type: "message_start", message: { id: "msg_probe", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null } },
    ...(wantsTool ? Array.from({ length: count }, (_, index) => [
      { type: "content_block_start", index, content_block: { type: "tool_use", id: `call_${index}`, name: info.name, input: {} } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: argumentsValue.slice(0, 10) } },
      { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: argumentsValue.slice(10) } },
      { type: "content_block_stop", index },
    ]).flat() : [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 8) } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(8) } },
      { type: "content_block_stop", index: 0 },
    ]),
    { type: "message_delta", delta: { stop_reason: wantsTool ? "tool_use" : "end_turn" }, usage: { output_tokens: 8 } },
    { type: "message_stop" },
  ];
}

function stream(response: ServerResponse, events: (Json | string)[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(sse(events));
}

const runtimeCheck = vi.fn(async () => true);

describe.each(["openai_responses", "openai_chat_completions", "anthropic"] as const)("API Profile protocol probe: %s", (protocol) => {
  it("uses the configured endpoint and credentials, completes streaming and one synthetic tool roundtrip", async () => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => stream(response, eventsFor(protocol, body, turn)));
    const check = vi.fn(async (_engine: string, _signal: AbortSignal) => true);
    const result = await probeApiProfile(binding, { runtimeCheck: check });
    expect(result).toMatchObject({ status: "passed", checks: { runtime: "passed", streaming: "passed", tools: "passed" } });
    expect(result.detail).toContain("尚未验证 Agent 引擎的完整执行路径");
    expect(check.mock.calls[0]?.[0]).toBe(protocol === "anthropic" ? "claude" : protocol === "openai_responses" ? "codex" : "opencode");
    expect(requests).toHaveLength(2);
    const first = requests[0]!;
    const last = requests[1]!;
    expect(first.url).toBe(protocol === "anthropic" ? "/v1/messages" : protocol === "openai_responses" ? "/v1/responses" : "/v1/chat/completions");
    expect(first.headers[protocol === "anthropic" ? "x-api-key" : "authorization"]).toBe(`${protocol === "anthropic" ? "" : "Bearer "}synthetic-test-key-never-real`);
    expect(first.body.model).toBe("synthetic-model");
    expect(first.body.stream).toBe(true);
    expect(first.body.tools).toHaveLength(1);
    expect(receiptFor(protocol, last.body)).toMatch(/^prospero-ok-/);
    expect(JSON.stringify(first.body)).not.toContain("prospero-ok-");
    expect(JSON.stringify(last.body)).not.toContain("synthetic-test-key");
    if (protocol === "anthropic") {
      expect(first.headers["anthropic-version"]).toBe("2023-06-01");
      expect(last.body.messages.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_0" });
    } else if (protocol === "openai_responses") {
      expect(last.body.input.at(-1)).toMatchObject({ type: "function_call_output", call_id: "call_0" });
      expect(first.body.store).toBe(false);
    } else {
      expect(last.body.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_0" });
    }
  });

  it.each([[401, "authentication_failed"], [403, "authentication_failed"], [429, "rate_limited"], [404, "endpoint_or_model_not_found"], [500, "upstream_error"]] as const)("sanitizes HTTP %i errors and never retries", async (status, code) => {
    const { binding, requests } = await fixture(protocol, (_body, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "SECRET upstream body synthetic-test-key-never-real" } }));
    });
    const result = await probeApiProfile(binding, { runtimeCheck });
    expect(result).toMatchObject({ status: "failed", code, checks: { runtime: "passed", streaming: "failed", tools: "not_tested" } });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|synthetic-test-key/);
    expect(requests).toHaveLength(1);
  });

  it("sanitizes a streamed model error and never retries", async () => {
    const { binding, requests } = await fixture(protocol, (_body, response) => stream(response, [{ type: "error", error: { code: "model_not_found", message: "SECRET error message" } }]));
    const result = await probeApiProfile(binding, { runtimeCheck });
    expect(result.code).toBe("model_not_found");
    expect(result.detail).not.toContain("SECRET");
    expect(requests).toHaveLength(1);
  });

  it("rejects malformed SSE JSON without exposing its content", async () => {
    const { binding, requests } = await fixture(protocol, (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("data: SECRET invalid json\n\n");
    });
    const result = await probeApiProfile(binding, { runtimeCheck });
    expect(result.code).toBe("invalid_stream");
    expect(result.detail).not.toContain("SECRET");
    expect(requests).toHaveLength(1);
  });

  it("rejects a premature stream end before executing or replaying a tool", async () => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => stream(response, eventsFor(protocol, body, turn).slice(0, -1)));
    const result = await probeApiProfile(binding, { runtimeCheck });
    expect(result.code).toBe("invalid_stream");
    expect(requests).toHaveLength(1);
  });

  it("does not mark ordinary JSON as streaming support", async () => {
    const { binding } = await fixture(protocol, (_body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: "ok" }));
    });
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ code: "streaming_unavailable", checks: { streaming: "failed" } });
  });

  it.each(["duplicate", "wrongArguments"] as const)("rejects %s tool calls before sending any tool result", async (fault) => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => stream(response, eventsFor(protocol, body, turn, { [fault]: true })));
    const result = await probeApiProfile(binding, { runtimeCheck });
    expect(result).toMatchObject({ status: "failed", checks: { tools: "failed" }, code: fault === "duplicate" ? "tool_call_invalid" : "tool_arguments_invalid" });
    expect(requests).toHaveLength(1);
  });

  it("requires the model to consume the tool result", async () => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => stream(response, eventsFor(protocol, body, turn, { wrongReceipt: true })));
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ status: "failed", code: "tool_roundtrip_failed", checks: { streaming: "passed", tools: "failed" } });
    expect(requests).toHaveLength(2);
  });

  it("never replays a tool or makes a third request", async () => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => stream(response, eventsFor(protocol, body, turn, { replay: true })));
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ code: "unexpected_tool_call" });
    expect(requests).toHaveLength(2);
  });

  it("never retries a failure after the synthetic tool result was submitted", async () => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => {
      if (turn === 1) stream(response, eventsFor(protocol, body, turn));
      else { response.writeHead(429); response.end(); }
    });
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ code: "rate_limited", checks: { tools: "failed" } });
    expect(requests).toHaveLength(2);
  });

  it("stops a hanging stream at the total deadline", async () => {
    const { binding, requests } = await fixture(protocol, (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": heartbeat\n\n");
    });
    const result = await probeApiProfile(binding, { runtimeCheck, timeoutMs: 60 });
    expect(result.code).toBe("timeout");
    expect(requests).toHaveLength(1);
  });

  it("cancels an in-flight request without a retry", async () => {
    const controller = new AbortController();
    const { binding, requests } = await fixture(protocol, () => controller.abort());
    expect(await probeApiProfile(binding, { runtimeCheck, signal: controller.signal })).toMatchObject({ code: "cancelled" });
    expect(requests).toHaveLength(1);
  });

  it("enforces a response byte limit", async () => {
    const { binding, requests } = await fixture(protocol, (_body, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`: ${"x".repeat(256 * 1024)}\n\n`);
    });
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ code: "response_too_large" });
    expect(requests).toHaveLength(1);
  });

  it("refuses redirects so credentials never reach a different endpoint", async () => {
    const { binding, requests } = await fixture(protocol, (_body, response) => {
      response.writeHead(307, { location: "/unexpected" });
      response.end();
    });
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ status: "failed", code: "connection_failed" });
    expect(requests).toHaveLength(1);
  });

  it("checks runtime before sending any API request", async () => {
    const { binding, requests } = await fixture(protocol, () => { throw new Error("must not reach upstream"); });
    expect(await probeApiProfile(binding, { runtimeCheck: async () => false })).toMatchObject({ code: "runtime_unavailable", checks: { runtime: "failed", streaming: "not_tested", tools: "not_tested" } });
    expect(requests).toHaveLength(0);
  });

  it("does not send a request when cancelled before startup", async () => {
    const { binding, requests } = await fixture(protocol, () => { throw new Error("must not reach upstream"); });
    const controller = new AbortController();
    controller.abort();
    expect(await probeApiProfile(binding, { runtimeCheck, signal: controller.signal })).toMatchObject({ code: "cancelled" });
    expect(requests).toHaveLength(0);
  });

  it("honors a configured smaller output limit on both requests", async () => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => stream(response, eventsFor(protocol, body, turn)));
    binding.apiProfile!.modelCapabilities = { maxOutputTokens: 128 };
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ status: "passed" });
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.body[protocol === "openai_responses" ? "max_output_tokens" : "max_tokens"]).toBe(128);
  });

  it.each(["missing_key", "tools_disabled", "invalid_url"] as const)("does not claim runtime failure for %s before any check ran", async (fault) => {
    const { binding, requests } = await fixture(protocol, () => { throw new Error("must not reach upstream"); });
    if (fault === "missing_key") binding.environment = {};
    else if (fault === "tools_disabled") binding.apiProfile!.modelCapabilities = { tools: false };
    else binding.apiProfile!.baseUrl = "not a URL";
    const check = vi.fn(async () => true);
    expect(await probeApiProfile(binding, { runtimeCheck: check })).toMatchObject({
      status: "failed", code: fault === "missing_key" ? "credential_missing" : fault === "invalid_url" ? "invalid_profile" : "tools_disabled",
      checks: { runtime: "not_tested", streaming: "not_tested", tools: "not_tested" },
    });
    expect(check).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("rejects streams missing their message start", async () => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => stream(response, eventsFor(protocol, body, turn).slice(1)));
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ code: "invalid_stream", checks: { streaming: "failed" } });
    expect(requests).toHaveLength(1);
  });

  it("rejects a broken second stream and never repeats the submitted tool result", async () => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => stream(response, turn === 1 ? eventsFor(protocol, body, turn) : eventsFor(protocol, body, turn).slice(0, -1)));
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ code: "invalid_stream", checks: { streaming: "failed", tools: "failed" } });
    expect(requests).toHaveLength(2);
  });

  it("decodes SSE fragmented across byte, JSON and CRLF boundaries", async () => {
    const { binding, requests } = await fixture(protocol, (body, response, turn) => {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      const text = `: 注释\r\n\r\n${sse(eventsFor(protocol, body, turn))}`;
      for (const byte of Buffer.from(text)) response.write(Buffer.from([byte]));
      response.end();
    });
    expect(await probeApiProfile(binding, { runtimeCheck })).toMatchObject({ status: "passed" });
    expect(requests).toHaveLength(2);
  });
});
