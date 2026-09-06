import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentApiProtocol, AgentApiValidation } from "@prospero/protocol";
import type { AccountBinding } from "./agent-accounts.js";
import { programCommandFor } from "./agents.js";

type Engine = "codex" | "claude" | "opencode";
type Json = Record<string, unknown>;
const TOOL_NAME = "prospero_connection_probe";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_EVENTS = 4096;
const SCOPE = "此检查验证 CLI 可启动、直接 API 协议的流式响应与无副作用工具往返；尚未验证 Agent 引擎的完整执行路径。";

export interface ApiProfileProbeOptions {
  signal?: AbortSignal;
  /** Total deadline, including runtime startup and both HTTP requests; capped at 30 seconds. */
  timeoutMs?: number;
  /** Test seams: tests use synthetic credentials and a local protocol server. */
  fetch?: typeof globalThis.fetch;
  runtimeCheck?: (engine: Engine, signal: AbortSignal) => Promise<boolean>;
}

class ProbeFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function string(value: unknown): string { return typeof value === "string" ? value : ""; }

function invalidStream(): never { throw new ProbeFailure("invalid_stream", "响应流格式无效或没有完整结束。"); }

/** Only fixed local messages are exposed. Never echo upstream bodies, URLs, keys or process stderr. */
function upstreamFailure(status?: number, error?: unknown): ProbeFailure {
  const value = object(error);
  const code = string(value["code"]) || string(value["type"]);
  if (status === 401 || status === 403 || ["authentication_error", "invalid_api_key", "permission_error"].includes(code)) {
    return new ProbeFailure("authentication_failed", "API 鉴权失败，请检查该 Profile 的 Key 和访问权限。");
  }
  if (status === 429 || status === 529 || ["rate_limit_error", "rate_limit_exceeded", "overloaded_error", "insufficient_quota"].includes(code)) {
    return new ProbeFailure("rate_limited", "API 限流、额度不足或暂时过载；没有自动重试。");
  }
  if (code === "model_not_found") return new ProbeFailure("model_not_found", "API 无法使用配置的模型。");
  if (status === 404) return new ProbeFailure("endpoint_or_model_not_found", "API 端点或模型不存在。");
  return new ProbeFailure("upstream_error", "API 返回错误；没有自动重试。");
}

async function checkRuntime(engine: Engine, signal: AbortSignal): Promise<boolean> {
  const root = await mkdtemp(path.join(os.tmpdir(), "prospero-api-runtime-probe-"));
  try {
    const workspace = path.join(root, "workspace");
    const config = path.join(root, "config");
    await Promise.all([mkdir(workspace, { mode: 0o700 }), mkdir(config, { mode: 0o700 })]);
    const environment: NodeJS.ProcessEnv = {
      HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"), CODEX_HOME: config,
      CODEX_SQLITE_HOME: config, CLAUDE_CONFIG_DIR: config,
      OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
    };
    // CLI discovery and Windows execution only; never inherit API credentials,
    // NODE_OPTIONS, agent configuration or the user's project environment.
    for (const key of ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "ComSpec", "TMPDIR", "TMP", "TEMP"]) {
      if (process.env[key]) environment[key] = process.env[key];
    }
    const command = programCommandFor(engine, ["--version"], process.platform, environment);
    signal.throwIfAborted();
    return await new Promise<boolean>((resolve) => {
      execFile(command.file, command.args, {
        cwd: workspace, env: environment, signal, timeout: 5_000,
        killSignal: "SIGKILL", maxBuffer: 16 * 1024, windowsHide: true,
      }, (error) => resolve(error === null));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function endpoint(baseUrl: string, protocol: AgentApiProtocol): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new ProbeFailure("invalid_profile", "API Profile 地址无效。"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) {
    throw new ProbeFailure("invalid_profile", "API Profile 地址无效。");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") + (protocol === "anthropic" ? "/v1/messages" : protocol === "openai_responses" ? "/responses" : "/chat/completions");
  return url.toString();
}

interface ToolCall { id: string; name: string; arguments: string }
interface StreamResult {
  text: string;
  textDeltaSeen: boolean;
  calls: ToolCall[];
  /** Protocol-native bounded response context, reused only with the same upstream. */
  history: unknown[];
}

/** Reads SSE incrementally, with one cumulative byte/event budget for both requests. */
async function readSse(
  response: Response,
  signal: AbortSignal,
  budget: { bytes: number; events: number },
  accept: (event: Json | "[DONE]") => boolean,
): Promise<void> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new ProbeFailure("streaming_unavailable", "API 没有返回 SSE 流式响应。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  const abort = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) invalidStream();
      budget.bytes += chunk.value.byteLength;
      if (budget.bytes > MAX_RESPONSE_BYTES) throw new ProbeFailure("response_too_large", "API 响应超出连接测试的大小上限。");
      try { buffer += decoder.decode(chunk.value, { stream: true }); } catch { invalidStream(); }
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue; // Comments, ping heartbeats without data, and SSE metadata.
        if (++budget.events > MAX_EVENTS) throw new ProbeFailure("response_too_large", "API 响应超出连接测试的事件上限。");
        let event: Json | "[DONE]";
        if (data === "[DONE]") event = data;
        else {
          try {
            const parsed: unknown = JSON.parse(data);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidStream();
            event = parsed as Json;
          } catch { invalidStream(); }
        }
        if (accept(event)) return;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function collectStream(response: Response, protocol: AgentApiProtocol, signal: AbortSignal, budget: { bytes: number; events: number }): Promise<StreamResult> {
  const result: StreamResult = { text: "", textDeltaSeen: false, calls: [], history: [] };
  const calls = new Map<number, ToolCall>();
  const blocks = new Map<number, Json>();
  const closedBlocks = new Set<number>();
  let finish = "";
  let messageStarted = false;
  let responseId = "";
  await readSse(response, signal, budget, (event) => {
    if (event === "[DONE]") {
      if (protocol !== "openai_chat_completions" || !messageStarted || !["stop", "tool_calls"].includes(finish)) invalidStream();
      return true;
    }
    if (event["error"] || event["type"] === "error" || event["type"] === "response.failed") {
      throw upstreamFailure(undefined, event["error"] ?? object(event["response"])["error"]);
    }
    if (protocol === "openai_chat_completions") {
      const choices = event["choices"];
      if (!Array.isArray(choices)) invalidStream();
      for (const raw of choices) {
        const choice = object(raw);
        if (choice["index"] !== 0 || finish) invalidStream();
        const delta = object(choice["delta"]);
        if (delta["role"] !== undefined) {
          if (delta["role"] !== "assistant") invalidStream();
          messageStarted = true;
        }
        if (!messageStarted) invalidStream();
        if (typeof delta["content"] === "string" && delta["content"].length > 0) {
          result.text += delta["content"];
          result.textDeltaSeen = true;
        }
        if (Array.isArray(delta["tool_calls"])) for (const rawCall of delta["tool_calls"]) {
          const chunk = object(rawCall);
          if (!Number.isInteger(chunk["index"]) || Number(chunk["index"]) < 0) invalidStream();
          const index = Number(chunk["index"]);
          const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
          const fn = object(chunk["function"]);
          call.id += string(chunk["id"]);
          call.name += string(fn["name"]);
          call.arguments += string(fn["arguments"]);
          calls.set(index, call);
        }
        if (typeof choice["finish_reason"] === "string") {
          finish = choice["finish_reason"];
          if (!["stop", "tool_calls"].includes(finish)) throw new ProbeFailure("incomplete_response", "API 在测试完成前停止了生成。");
        }
      }
      return false;
    }
    const type = string(event["type"]);
    if (protocol === "openai_responses") {
      if (type === "response.created") {
        const created = object(event["response"]);
        if (responseId || !string(created["id"]) || created["status"] !== "in_progress") invalidStream();
        responseId = string(created["id"]);
      } else if (type.startsWith("response.") && !responseId) invalidStream();
      if (type === "response.output_item.added") {
        const index = event["output_index"];
        const item = object(event["item"]);
        if (!Number.isInteger(index) || Number(index) < 0 || blocks.has(Number(index)) || !string(item["id"]) || !string(item["type"])) invalidStream();
        blocks.set(Number(index), item);
        if (item["type"] === "function_call") calls.set(Number(index), { id: string(item["call_id"]), name: string(item["name"]), arguments: string(item["arguments"]) });
      }
      if (type === "response.function_call_arguments.delta") {
        const index = Number(event["output_index"]);
        const item = blocks.get(index);
        const call = calls.get(index);
        if (!call || !item || item["id"] !== event["item_id"] || closedBlocks.has(index)) invalidStream();
        call.arguments += string(event["delta"]);
      }
      if (type === "response.output_text.delta") {
        const index = Number(event["output_index"]);
        const item = blocks.get(index);
        if (!item || item["type"] !== "message" || item["id"] !== event["item_id"] || closedBlocks.has(index)) invalidStream();
        result.text += string(event["delta"]);
        result.textDeltaSeen ||= string(event["delta"]).length > 0;
      }
      if (type === "response.output_item.done") {
        const index = Number(event["output_index"]);
        const item = object(event["item"]);
        const initial = blocks.get(index);
        if (!initial || initial["id"] !== item["id"] || initial["type"] !== item["type"] || closedBlocks.has(index)) invalidStream();
        const call = calls.get(index);
        if (call && (item["call_id"] !== call.id || item["name"] !== call.name || item["arguments"] !== call.arguments)) invalidStream();
        blocks.set(index, item);
        closedBlocks.add(index);
      }
      if (type === "response.incomplete") throw new ProbeFailure("incomplete_response", "API 在测试完成前停止了生成。");
      if (type === "response.completed") {
        const completed = object(event["response"]);
        if (completed["id"] !== responseId || completed["status"] !== "completed" || !Array.isArray(completed["output"]) || completed["output"].length !== blocks.size || closedBlocks.size !== blocks.size) invalidStream();
        result.history = completed["output"];
        let completedText = "";
        for (const [index, raw] of result.history.entries()) {
          const item = object(raw);
          const ended = blocks.get(index);
          if (!ended || ended["id"] !== item["id"] || ended["type"] !== item["type"]) invalidStream();
          if (item["type"] === "function_call") {
            const call = calls.get(index);
            if (!call || item["call_id"] !== call.id || item["name"] !== call.name || item["arguments"] !== call.arguments) invalidStream();
            result.calls.push(call);
          }
          if (item["type"] === "message") {
            if (item["role"] !== "assistant" || !Array.isArray(item["content"])) invalidStream();
            for (const rawPart of item["content"]) {
              const part = object(rawPart);
              if (part["type"] === "output_text") completedText += string(part["text"]);
            }
          }
        }
        if (completedText !== result.text) invalidStream();
        return true;
      }
      return false;
    }
    if (type === "message_start") {
      const message = object(event["message"]);
      if (messageStarted || message["type"] !== "message" || message["role"] !== "assistant" || !string(message["id"])) invalidStream();
      messageStarted = true;
    }
    if (["content_block_start", "content_block_delta", "content_block_stop"].includes(type)) {
      if (!messageStarted || !Number.isInteger(event["index"]) || Number(event["index"]) < 0) invalidStream();
      const index = Number(event["index"]);
      if (type === "content_block_start") {
        if (blocks.has(index)) invalidStream();
        const block = object(event["content_block"]);
        if (!string(block["type"])) invalidStream();
        blocks.set(index, { ...block });
        if (block["type"] === "text") result.text += string(block["text"]);
        if (block["type"] === "tool_use") calls.set(index, { id: string(block["id"]), name: string(block["name"]), arguments: "" });
      } else {
        const block = blocks.get(index);
        if (!block || closedBlocks.has(index)) invalidStream();
        if (type === "content_block_stop") {
          closedBlocks.add(index);
          return false;
        }
        const delta = object(event["delta"]);
        if (delta["type"] === "text_delta") {
          if (block["type"] !== "text") invalidStream();
          const text = string(delta["text"]);
          result.text += text;
          result.textDeltaSeen ||= text.length > 0;
          block["text"] = string(block["text"]) + text;
        }
        if (delta["type"] === "input_json_delta") {
          const call = calls.get(index);
          if (!call) invalidStream();
          call.arguments += string(delta["partial_json"]);
        }
      }
    }
    if (type === "message_delta") {
      if (!messageStarted || closedBlocks.size !== blocks.size) invalidStream();
      const reason = object(event["delta"])["stop_reason"];
      if (reason !== undefined && reason !== null) finish = string(reason);
    }
    if (type === "message_stop") {
      if (!messageStarted || closedBlocks.size !== blocks.size || !["tool_use", "end_turn"].includes(finish) || ((calls.size > 0) !== (finish === "tool_use"))) invalidStream();
      for (const [index, block] of blocks) {
        const call = calls.get(index);
        if (call) {
          if (!call.arguments) call.arguments = JSON.stringify(block["input"] ?? {});
          try { block["input"] = JSON.parse(call.arguments) as unknown; } catch { invalidStream(); }
        }
        result.history.push(block);
      }
      return true;
    }
    return false;
  });
  if (protocol !== "openai_responses") result.calls = [...calls.values()];
  if (protocol === "openai_chat_completions") {
    if ((result.calls.length > 0) !== (finish === "tool_calls")) invalidStream();
    result.history = [{ role: "assistant", content: result.text || null, ...(result.calls.length ? { tool_calls: result.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) } : {}) }];
  }
  return result;
}

function requestBody(protocol: AgentApiProtocol, model: string, maxOutputTokens: number, prompt: string, nonce: string, previous?: { stream: StreamResult; call: ToolCall; receipt: string }): Json {
  const parameters = { type: "object", properties: { nonce: { type: "string", enum: [nonce] } }, required: ["nonce"], additionalProperties: false };
  const fn = { name: TOOL_NAME, description: "Return a verification receipt. This synthetic tool has no side effects.", parameters };
  const user = { role: "user", content: prompt };
  if (protocol === "openai_responses") return {
    model, stream: true, store: false, max_output_tokens: maxOutputTokens,
    // Stateless reasoning models need their encrypted reasoning context on the
    // tool-result request; forwarding only an item id would require stored state.
    include: ["reasoning.encrypted_content"],
    tools: [{ type: "function", ...fn, strict: true }],
    tool_choice: previous ? "none" : { type: "function", name: TOOL_NAME },
    input: previous ? [user, ...previous.stream.history, { type: "function_call_output", call_id: previous.call.id, output: previous.receipt }] : [user],
  };
  if (protocol === "openai_chat_completions") return {
    model, stream: true, max_tokens: maxOutputTokens,
    tools: [{ type: "function", function: fn }],
    tool_choice: previous ? "none" : { type: "function", function: { name: TOOL_NAME } },
    messages: previous ? [user, ...previous.stream.history, { role: "tool", tool_call_id: previous.call.id, content: previous.receipt }] : [user],
  };
  return {
    model, stream: true, max_tokens: maxOutputTokens,
    tools: [{ name: TOOL_NAME, description: fn.description, input_schema: parameters }],
    tool_choice: previous ? { type: "none" } : { type: "tool", name: TOOL_NAME },
    messages: previous ? [user, { role: "assistant", content: previous.stream.history }, { role: "user", content: [{ type: "tool_result", tool_use_id: previous.call.id, content: previous.receipt }] }] : [user],
  };
}

/**
 * Explicit, user-initiated validation. Sends at most two requests, never retries,
 * never follows redirects and never runs tools or reads a user's workspace.
 * Runtime availability and direct wire compatibility are deliberately separate:
 * this is not an end-to-end execution of Codex, Claude Code or OpenCode.
 */
export async function probeApiProfile(binding: AccountBinding, options: ApiProfileProbeOptions = {}): Promise<AgentApiValidation> {
  const startedAt = Date.now();
  const profile = binding.apiProfile;
  const protocol = profile?.protocol ?? (binding.agent === "claude" ? "anthropic" : "openai_responses");
  const engine: Engine = protocol === "openai_chat_completions" ? "opencode" : protocol === "anthropic" ? "claude" : "codex";
  const checks: AgentApiValidation["checks"] = { runtime: "not_tested", streaming: "not_tested", tools: "not_tested" };
  const controller = new AbortController();
  const requestedTimeout = options.timeoutMs ?? 20_000;
  const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(1, Math.min(30_000, requestedTimeout)) : 20_000;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cancel = (): void => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) controller.abort();
  let phase: "runtime" | "streaming" | "tools" | undefined;
  try {
    controller.signal.throwIfAborted();
    if (!profile) throw new ProbeFailure("invalid_profile", "此账号没有 API Profile。");
    if (profile.modelCapabilities?.tools === false) throw new ProbeFailure("tools_disabled", "该 Profile 已声明不支持工具调用，无法验证 Agent 工具往返。");
    const url = endpoint(profile.baseUrl, protocol);
    const key = binding.environment[protocol === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"];
    if (!key || /[\r\n\0]/.test(key)) throw new ProbeFailure("credential_missing", "API Profile 尚未配置有效的 Key。");
    const maxOutputTokens = Math.min(1024, profile.modelCapabilities?.maxOutputTokens ?? 1024);
    phase = "runtime";
    if (!await (options.runtimeCheck ?? checkRuntime)(engine, controller.signal)) {
      controller.signal.throwIfAborted();
      throw new ProbeFailure("runtime_unavailable", "所需 Agent CLI 未安装或无法启动。");
    }
    checks.runtime = "passed";
    phase = "streaming";
    const headers = { "content-type": "application/json", accept: "text/event-stream", ...(protocol === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${key}` }) };
    const nonce = randomUUID();
    const prompt = `This is a connection test. Call ${TOOL_NAME} exactly once with nonce ${nonce}. After receiving its result, reply with only the exact receipt string returned by that tool. Do not call any other tools.`;
    const budget = { bytes: 0, events: 0 };
    let requests = 0;
    const send = async (body: Json): Promise<StreamResult> => {
      controller.signal.throwIfAborted();
      if (++requests > 2) throw new ProbeFailure("request_limit", "连接测试已达到请求上限。");
      const response = await (options.fetch ?? globalThis.fetch)(url, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, redirect: "error",
      });
      controller.signal.throwIfAborted();
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw upstreamFailure(response.status);
      }
      try { return await collectStream(response, protocol, controller.signal, budget); }
      catch (error) { checks.streaming = "failed"; throw error; }
    };
    const first = await send(requestBody(protocol, profile.model, maxOutputTokens, prompt, nonce));
    checks.streaming = "passed";
    phase = "tools";
    const call = first.calls[0];
    if (first.calls.length !== 1 || !call?.id || call.name !== TOOL_NAME) {
      throw new ProbeFailure("tool_call_invalid", "API 没有返回唯一且符合要求的测试工具调用。");
    }
    let args: Json;
    try { args = object(JSON.parse(call.arguments) as unknown); } catch { throw new ProbeFailure("tool_arguments_invalid", "API 返回的工具参数不是有效 JSON。"); }
    if (args["nonce"] !== nonce || Object.keys(args).length !== 1) {
      throw new ProbeFailure("tool_arguments_invalid", "API 返回的测试工具参数不符合要求。");
    }
    // Created only now: the model must consume tool_result to know this value.
    // No filesystem, shell, MCP or user-defined tool can ever be invoked here.
    const receipt = `prospero-ok-${randomUUID()}`;
    const last = await send(requestBody(protocol, profile.model, maxOutputTokens, prompt, nonce, { stream: first, call, receipt }));
    if (last.calls.length > 0) throw new ProbeFailure("unexpected_tool_call", "API 在工具结果回传后再次请求工具；测试已停止。");
    if (!last.textDeltaSeen) {
      checks.streaming = "failed";
      throw new ProbeFailure("streaming_unavailable", "API 没有返回流式文本增量。");
    }
    if (last.text.trim() !== receipt) throw new ProbeFailure("tool_roundtrip_failed", "API 未正确返回工具结果，工具往返验证失败。");
    checks.tools = "passed";
    return { status: "passed", checkedAt: Date.now(), engine, checks, latencyMs: Date.now() - startedAt, detail: SCOPE };
  } catch (error) {
    if (phase) checks[phase] = "failed";
    const failure = controller.signal.aborted
      ? new ProbeFailure(timedOut ? "timeout" : "cancelled", timedOut ? "连接测试超时，已停止且没有自动重试。" : "连接测试已取消。")
      : error instanceof ProbeFailure ? error : new ProbeFailure("connection_failed", "无法完成 API 连接测试，请检查地址、网络和协议配置。");
    return { status: "failed", checkedAt: Date.now(), engine, checks, code: failure.code, latencyMs: Date.now() - startedAt, detail: `${failure.message} ${SCOPE}` };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    controller.abort();
  }
}
