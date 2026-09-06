import { createServer, type Server } from "node:http";
import type { AgentApiProtocol } from "@prospero/protocol";
import type { AccountBinding } from "../src/agent-accounts.js";

type Json = Record<string, any>;
export function engineEvents(protocol: AgentApiProtocol, body: Json, turn: number): Json[] | (Json | string)[] {
  const tools = body.tools as Json[];
  const tool = tools.map((value) => value.function ?? value).find((value) => String(value.name).includes("prospero_connection_probe"));
  if (!tool) throw new Error("engine did not register its probe tool");
  const schema = tool.input_schema ?? tool.parameters;
  const nonce = schema.properties.nonce.const ?? schema.properties.nonce.enum?.[0];
  if (!nonce) throw new Error("engine probe nonce missing");
  const args = JSON.stringify({ nonce });
  const text = JSON.stringify(body).match(/prospero-engine-ok-[0-9a-f-]+/)?.[0] ?? "missing-receipt";
  if (protocol === "openai_responses") {
    const output = turn === 1
      ? { type: "function_call", id: "fc_probe", call_id: "call_probe", name: tool.name, arguments: args, status: "completed" }
      : { type: "message", id: "msg_probe", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    const base = { id: `resp_probe_${turn}`, object: "response", created_at: 1, status: "in_progress", model: body.model, output: [], parallel_tool_calls: false };
    const events: Json[] = [
      { type: "response.created", response: base },
      { type: "response.in_progress", response: base },
      { type: "response.output_item.added", output_index: 0, item: turn === 1 ? { ...output, arguments: "", status: "in_progress" } : { ...output, content: [], status: "in_progress" } },
    ];
    if (turn === 1) events.push(
      { type: "response.function_call_arguments.delta", item_id: "fc_probe", output_index: 0, delta: args },
      { type: "response.function_call_arguments.done", item_id: "fc_probe", output_index: 0, arguments: args },
    );
    else events.push(
      { type: "response.content_part.added", item_id: "msg_probe", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg_probe", output_index: 0, content_index: 0, delta: text.slice(0, 10) },
      { type: "response.output_text.delta", item_id: "msg_probe", output_index: 0, content_index: 0, delta: text.slice(10) },
      { type: "response.output_text.done", item_id: "msg_probe", output_index: 0, content_index: 0, text },
      { type: "response.content_part.done", item_id: "msg_probe", output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } },
    );
    events.push(
      { type: "response.output_item.done", output_index: 0, item: output },
      { type: "response.completed", response: { ...base, status: "completed", output: [output], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
    );
    return events.map((event, sequence_number) => ({ ...event, sequence_number }));
  }
  if (protocol === "anthropic") return [
    { type: "message_start", message: { id: `msg_probe_${turn}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: turn === 1 ? { type: "tool_use", id: "toolu_probe", name: tool.name, input: {} } : { type: "text", text: "" } },
    ...(turn === 1 ? [{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }] : [
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 10) } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(10) } },
    ]),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: turn === 1 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  const chunk = (delta: Json, finish_reason: string | null = null) => ({ id: "chatcmpl_probe", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] });
  return [chunk({ role: "assistant" }), turn === 1 ? chunk({ tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: tool.name, arguments: args } }] }) : chunk({ content: text }), chunk({}, turn === 1 ? "tool_calls" : "stop"), "[DONE]"];
}

export async function engineUpstream(protocol: AgentApiProtocol): Promise<{ server: Server; binding: AccountBinding; requests: Json[]; close(): Promise<void> }> {
  const requests: Json[] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      try {
        const body = JSON.parse(raw) as Json;
        requests.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of engineEvents(protocol, body, requests.length)) {
          response.write(`${typeof event === "string" ? "" : `event: ${String(event.type ?? "message")}\n`}data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
        }
        response.end();
      } catch {
        response.writeHead(400); response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const anthropic = protocol === "anthropic";
  const binding: AccountBinding = {
    id: "synthetic-engine-profile", name: "Synthetic engine profile", agent: anthropic ? "claude" : "codex", managed: true,
    apiProfile: { provider: anthropic ? "anthropic_compatible" : "openai_compatible", protocol, model: "synthetic-model", baseUrl: `http://127.0.0.1:${address.port}${anthropic ? "" : "/v1"}`,
      modelCapabilities: { contextWindow: 32000, maxOutputTokens: 512, reasoning: false } },
    environment: { [anthropic ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]: "synthetic-engine-upstream-key" },
    ...(protocol === "openai_chat_completions" ? { adapterAgent: "opencode" as const } : {}),
  };
  return { server, binding, requests, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
