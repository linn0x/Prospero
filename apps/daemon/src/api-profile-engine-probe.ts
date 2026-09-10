import { spawn, execFile, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { query, createSdkMcpServer, tool, type Options as ClaudeOptions, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentApiEngineValidation, AgentApiProtocol } from "@prospero/protocol";
import type { AccountBinding } from "./agent-accounts.js";
import { programCommandFor } from "./agents.js";

type Json = Record<string, unknown>;
type Engine = "codex" | "claude" | "opencode";
const TOOL = "prospero_connection_probe";
const MAX_BYTES = 512 * 1024;
const MAX_PROCESS_BYTES = 1024 * 1024;

export interface ApiProfileEngineProbeOptions {
  signal?: AbortSignal;
  /** Includes runtime startup and both model requests; defaults to 45s, capped at 60s. */
  timeoutMs?: number;
  /** Internal test seams. Production callers supply only signal/timeout. */
  fetch?: typeof globalThis.fetch;
  spawn?: typeof spawn;
  claudeQuery?: typeof query;
  executable?: string;
}

class EngineFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, detail: string): never { throw new EngineFailure(code, detail); }
function obj(value: unknown): Json { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function version(value: string): string | undefined { return value.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?\b/)?.[0]; }

interface RunContext {
  binding: AccountBinding; engine: Engine; protocol: AgentApiProtocol;
  root: string; cwd: string; env: Record<string, string>; executable: string;
  signal: AbortSignal; options: ApiProfileEngineProbeOptions;
  checks: AgentApiEngineValidation["checks"];
  nonce: string; receipt: string; toolCalls: number; text: string; textDelta: boolean;
  children: Set<ChildProcess>;
  configurationSeen: boolean;
  gatewayFailure?: EngineFailure;
  cliVersion?: string;
  toolName: string;
}

function environment(root: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"), TMPDIR: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    CODEX_HOME: path.join(root, "codex"), CODEX_SQLITE_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    DISABLE_AUTOUPDATER: "1", ENABLE_TOOL_SEARCH: "false", MCP_TOOL_TIMEOUT: "1000",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
  };
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "ComSpec"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

function executableFor(engine: Engine, override?: string): string {
  if (override) return override;
  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env["PATH"] ?? "").split(path.delimiter)) for (const suffix of suffixes) {
    const candidate = path.join(directory, engine + suffix);
    if (existsSync(candidate)) return candidate;
  }
  return engine;
}

const stopping = new WeakMap<ChildProcess, Promise<void>>();
async function stopChild(child: ChildProcess): Promise<void> {
  const current = stopping.get(child);
  if (current) return current;
  const pending = terminateChild(child);
  stopping.set(child, pending);
  return pending;
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (process.platform !== "win32" && child.pid) {
    // Kill the owned process group even if a CLI wrapper has already exited.
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  } else {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (child.pid) await new Promise<void>((resolve) => {
      execFile("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { timeout: 1_000, maxBuffer: 4096, windowsHide: true }, () => resolve());
    });
    try { child.kill("SIGKILL"); } catch {}
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 750);
    child.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

function startChild(ctx: RunContext, args: string[], extra: SpawnOptions = {}): ChildProcess {
  ctx.signal.throwIfAborted();
  const command = programCommandFor(ctx.executable, args, process.platform, ctx.env);
  const child = (ctx.options.spawn ?? spawn)(command.file, command.args, {
    cwd: ctx.cwd, env: ctx.env, stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32", windowsHide: true, ...extra,
  });
  ctx.children.add(child);
  const abort = (): void => { void stopChild(child); };
  ctx.signal.addEventListener("abort", abort, { once: true });
  child.once("close", () => { ctx.signal.removeEventListener("abort", abort); void stopChild(child); });
  return child;
}

async function runtimeVersion(ctx: RunContext): Promise<string> {
  const child = startChild(ctx, ["--version"]);
  return new Promise<string>((resolve, reject) => {
    let output = "";
    let bytes = 0;
    const timer = setTimeout(() => { void stopChild(child); reject(new EngineFailure("runtime_unavailable", "Agent CLI 启动超时。")); }, 5_000);
    const data = (chunk: Buffer): void => {
      bytes += chunk.byteLength;
      if (bytes > 16 * 1024) { void stopChild(child); reject(new EngineFailure("runtime_unavailable", "Agent CLI 版本输出异常。")); }
      else output += chunk.toString("utf8");
    };
    child.stdout?.on("data", data);
    child.stderr?.on("data", () => {});
    child.once("error", () => { clearTimeout(timer); reject(new EngineFailure("runtime_unavailable", "所需 Agent CLI 未安装或无法启动。")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      const detected = version(output);
      if (code === 0 && detected) resolve(detected);
      else reject(new EngineFailure("runtime_unavailable", "Agent CLI 没有返回有效版本。"));
    });
  });
}

function invokeTool(ctx: RunContext, name: string, args: unknown): string {
  ctx.signal.throwIfAborted();
  const input = obj(args);
  if (name !== ctx.toolName || ctx.toolCalls !== 0 || input["nonce"] !== ctx.nonce || Object.keys(input).length !== 1) {
    fail("tool_call_invalid", "引擎请求了不允许、重复或参数无效的工具，验证已停止。");
  }
  ctx.toolCalls += 1;
  ctx.receipt = `prospero-engine-ok-${randomUUID()}`;
  return ctx.receipt;
}

function prompt(ctx: RunContext): string {
  return `This is an isolated connection test. Call ${ctx.toolName} exactly once with nonce ${ctx.nonce}. After its result, reply with only the exact receipt string the tool returned. Do not use any other tools.`;
}

/** Checks a complete bounded SSE before releasing it to a tool-capable runtime. */
function safeStream(raw: string, ctx: RunContext): void {
  let complete = false;
  const chatNames = new Map<number, string>();
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    if (data === "[DONE]") { complete ||= ctx.protocol === "openai_chat_completions"; continue; }
    let event: Json;
    try { event = obj(JSON.parse(data)); } catch { fail("invalid_stream", "上游返回了无效的响应流。"); }
    if (event["error"] || event["type"] === "error" || event["type"] === "response.failed" || event["type"] === "response.incomplete") fail("upstream_error", "上游未成功完成引擎测试请求。");
    const item = obj(event["item"]);
    const block = obj(event["content_block"]);
    if (item["type"] === "function_call" && (item["name"] !== ctx.toolName || item["namespace"])) fail("unexpected_tool_call", "上游请求了测试工具以外的操作，已在执行前拦截。");
    if (item["type"] && !["function_call", "message", "reasoning"].includes(str(item["type"]))) fail("unexpected_tool_call", "上游返回了不允许的引擎操作。");
    if (block["type"] === "tool_use" && block["name"] !== ctx.toolName) fail("unexpected_tool_call", "上游请求了测试工具以外的操作，已在执行前拦截。");
    if (block["type"] && !["tool_use", "text", "thinking", "redacted_thinking"].includes(str(block["type"]))) fail("unexpected_tool_call", "上游返回了不允许的服务端工具操作。");
    for (const rawChoice of Array.isArray(event["choices"]) ? event["choices"] : []) {
      const delta = obj(obj(rawChoice)["delta"]);
      if (delta["function_call"]) fail("unexpected_tool_call", "上游返回了未启用的旧工具调用格式。");
      for (const rawCall of Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : []) {
        const call = obj(rawCall); const index = Number(call["index"]);
        chatNames.set(index, (chatNames.get(index) ?? "") + str(obj(call["function"])["name"]));
      }
    }
    if (event["type"] === "response.completed") {
      const response = obj(event["response"]);
      if (response["status"] !== "completed") fail("invalid_stream", "上游响应流没有成功完成。");
      for (const rawItem of Array.isArray(response["output"]) ? response["output"] : []) {
        const output = obj(rawItem);
        if (!["function_call", "message", "reasoning"].includes(str(output["type"]))) fail("unexpected_tool_call", "上游返回了不允许的引擎操作。");
        if (output["type"] === "function_call" && (output["name"] !== ctx.toolName || output["namespace"])) fail("unexpected_tool_call", "上游请求了测试工具以外的操作，已在执行前拦截。");
      }
      complete = true;
    }
    if (event["type"] === "message_stop") complete = true;
  }
  if (!complete || [...chatNames.values()].some((name) => name !== ctx.toolName)) fail("invalid_stream", "上游响应流未完整结束或包含不允许的工具。");
}

async function gateway(ctx: RunContext): Promise<{ baseUrl: string; token: string; mcpUrl: string; failure: Promise<never>; close(): Promise<void> }> {
  const token = randomUUID();
  const profile = ctx.binding.apiProfile!;
  const upstream = new URL(profile.baseUrl);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname);
  if ((upstream.protocol !== "https:" && !(upstream.protocol === "http:" && local)) || upstream.username || upstream.password || upstream.search || upstream.hash) fail("invalid_profile", "API Profile 地址无效。");
  const suffix = ctx.protocol === "anthropic" ? "/v1/messages" : ctx.protocol === "openai_responses" ? "/responses" : "/chat/completions";
  upstream.pathname = upstream.pathname.replace(/\/+$/, "") + suffix;
  let modelRequests = 0;
  let localRequests = 0;
  let bytes = 0;
  let rejectFailure!: (error: EngineFailure) => void;
  const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failure.catch(() => {});
  const reject = (response: ServerResponse, failure: EngineFailure): void => {
    ctx.gatewayFailure ??= failure;
    rejectFailure(failure);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Prospero engine probe stopped" } }));
  };
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (++localRequests > 20) fail("request_limit", "引擎测试超过本地请求上限。");
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (!url.pathname.startsWith(`/${token}/`)) fail("configuration_mismatch", "引擎请求了配置以外的地址。");
        // Claude's CLI probes its configured base before initialization. This
        // local health reply cannot reach the upstream or validate credentials.
        if (ctx.engine === "claude" && request.method === "HEAD" && url.pathname === `/${token}/api/hello` && !url.search) {
          response.writeHead(200); response.end(); return;
        }
        // Streamable HTTP clients may probe the optional server-to-client SSE
        // channel. This stateless MCP server only supports POST responses.
        if (request.method === "GET" && url.pathname === `/${token}/mcp` && !url.search) {
          response.writeHead(405, { Allow: "POST" }); response.end(); return;
        }
        if (request.method !== "POST") fail("configuration_mismatch", "引擎请求了测试范围以外的端点。");
        const chunks: Buffer[] = []; let requestBytes = 0;
        for await (const chunk of request) {
          const value = Buffer.from(chunk as Buffer); requestBytes += value.byteLength;
          if (requestBytes > MAX_BYTES) fail("request_too_large", "引擎请求超过测试大小上限。");
          chunks.push(value);
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: Json;
        try { body = obj(JSON.parse(raw)); } catch { fail("invalid_request", "引擎请求不是有效 JSON。"); }
        if (url.pathname === `/${token}/mcp`) {
          const id = body["id"];
          const method = body["method"];
          if (id === undefined) { response.writeHead(202); response.end(); return; }
          let result: unknown;
          if (method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "prospero_probe", version: "1.0.0" } };
          else if (method === "tools/list") result = { tools: [{ name: TOOL, description: "Return a synthetic verification receipt without side effects.", inputSchema: { type: "object", properties: { nonce: { type: "string", enum: [ctx.nonce] } }, required: ["nonce"], additionalProperties: false } }] };
          else if (method === "tools/call") {
            const params = obj(body["params"]);
            if (params["name"] !== TOOL) fail("unexpected_tool_call", "引擎请求了未注册的 MCP 工具。");
            result = { content: [{ type: "text", text: invokeTool(ctx, ctx.toolName, params["arguments"]) }] };
          } else if (method === "ping") result = {};
          else fail("unexpected_tool_call", "引擎请求了不允许的 MCP 操作。");
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
          return;
        }
        const wanted = `/${token}${ctx.protocol === "anthropic" ? "/v1/messages" : "/v1" + suffix}`;
        if (url.pathname !== wanted || (url.search && !(ctx.protocol === "anthropic" && url.search === "?beta=true"))) fail("configuration_mismatch", "引擎请求了测试范围以外的模型端点。");
        if (ctx.protocol === "anthropic" ? request.headers["x-api-key"] !== token : request.headers.authorization !== `Bearer ${token}`) fail("configuration_mismatch", "引擎未使用该测试配置注入的凭据。");
        if (body["model"] !== profile.model || body["stream"] !== true) fail("configuration_mismatch", "引擎未使用 Profile 中指定的模型或流式协议。");
        const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
        const names = tools.map((rawTool) => { const t = obj(rawTool); return str(t["name"] ?? obj(t["function"])["name"]); });
        // Current Codex retains these declarations even with environment/skill
        // discovery disabled. safeStream blocks their invocation before any
        // response reaches the runtime; only the synthetic dynamic tool executes.
        const retainedCodexTool = (rawTool: unknown): boolean => {
          const t = obj(rawTool);
          return ctx.engine === "codex" && ((t["type"] === "function" && t["name"] === "request_user_input") ||
            (t["type"] === "namespace" && t["name"] === "skills" && Array.isArray(t["tools"]) && t["tools"].every((raw) => ["list", "read"].includes(str(obj(raw)["name"])))));
        };
        if (!names.includes(ctx.toolName) || tools.some((t, index) => names[index] !== ctx.toolName && !retainedCodexTool(t))) fail("configuration_mismatch", "引擎未正确限制测试工具，已在调用上游前停止。");
        if (++modelRequests > 2) fail("request_limit", "引擎测试最多允许两次模型请求，已阻止重试或额外调用。");
        if (modelRequests === 2 && (ctx.toolCalls !== 1 || !ctx.receipt || !raw.includes(ctx.receipt))) fail("tool_roundtrip_failed", "引擎没有将合成工具结果传回模型。");
        const maxOutput = Math.min(profile.modelCapabilities?.maxOutputTokens ?? 1024, 1024);
        const outputKey = ctx.protocol === "openai_responses" ? "max_output_tokens" : ctx.protocol === "openai_chat_completions" && body["max_completion_tokens"] !== undefined ? "max_completion_tokens" : "max_tokens";
        body[outputKey] = Math.min(typeof body[outputKey] === "number" ? Number(body[outputKey]) : maxOutput, maxOutput);
        if (outputKey === "max_completion_tokens") delete body["max_tokens"];
        const key = ctx.binding.environment[ctx.protocol === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]!;
        ctx.configurationSeen = true;
        ctx.checks.configuration = "passed";
        const result = await (ctx.options.fetch ?? globalThis.fetch)(upstream, {
          method: "POST", body: JSON.stringify(body), redirect: "error", signal: ctx.signal,
          headers: { ...profile.headers, "content-type": "application/json", accept: "text/event-stream", ...(ctx.protocol === "anthropic" ? { "x-api-key": key, "anthropic-version": "2023-06-01", ...(typeof request.headers["anthropic-beta"] === "string" ? { "anthropic-beta": request.headers["anthropic-beta"] } : {}) } : { authorization: `Bearer ${key}` }) },
        });
        if (!result.ok) { void result.body?.cancel(); fail(result.status === 401 || result.status === 403 ? "authentication_failed" : result.status === 429 ? "rate_limited" : result.status === 404 ? "endpoint_or_model_not_found" : "upstream_error", "上游拒绝了引擎测试请求；没有自动重试。"); }
        if (!result.body || !result.headers.get("content-type")?.includes("text/event-stream")) fail("invalid_stream", "上游没有返回流式响应。");
        let stream = "";
        const reader = result.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) fail("response_too_large", "引擎测试响应超过大小上限。");
            stream += decoder.decode(chunk.value, { stream: true });
          }
          stream += decoder.decode();
        } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
        safeStream(stream, ctx);
        // Buffering protects the CLI from unexpected tool operations. The engine
        // still parses the original SSE and must emit its own incremental events.
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(stream);
      } catch (error) {
        reject(response, error instanceof EngineFailure ? error : new EngineFailure("connection_failed", "引擎测试的受控连接失败。"));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") fail("connection_failed", "无法启动本地引擎测试连接。");
  const base = `http://127.0.0.1:${address.port}/${token}`;
  return { baseUrl: ctx.protocol === "anthropic" ? base : base + "/v1", token, mcpUrl: base + "/mcp", failure, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

async function runCodex(ctx: RunContext, baseUrl: string, token: string): Promise<void> {
  ctx.env["OPENAI_API_KEY"] = token;
  const profile = ctx.binding.apiProfile!;
  const config: Json = {
    model: profile.model, model_provider: "prospero_probe",
    "model_providers.prospero_probe.name": "Prospero engine probe", "model_providers.prospero_probe.base_url": baseUrl,
    "model_providers.prospero_probe.env_key": "OPENAI_API_KEY", "model_providers.prospero_probe.wire_api": "responses",
    "model_providers.prospero_probe.requires_openai_auth": false,
    "model_providers.prospero_probe.request_max_retries": 0, "model_providers.prospero_probe.stream_max_retries": 0,
    "features.shell_tool": false, "features.unified_exec": false, "features.multi_agent": false,
    "features.skill_search": false, "features.skip_host_skill_discovery": true,
    "features.skill_mcp_dependency_install": false, "features.plugins": false, "features.apps": false,
    "features.hooks": false, "features.memories": false, "features.shell_snapshot": false,
    "features.browser_use": false, "features.computer_use": false, "features.image_generation": false,
    "features.code_mode": false, "features.tool_suggest": false, "features.goals": false,
    "features.unbounded_connection_retries": false, "features.request_permissions_tool": false, "features.enable_request_compression": false,
    "tools.view_image": false, web_search: "disabled", check_for_update_on_startup: false,
    "analytics.enabled": false, "feedback.enabled": false,
    ...(profile.modelCapabilities?.contextWindow ? { model_context_window: profile.modelCapabilities.contextWindow } : {}),
    ...(profile.modelCapabilities?.reasoning === false ? { model_supports_reasoning_summaries: false, model_reasoning_summary: "none" } : {}),
  };
  const args = ["app-server"];
  for (const [key, value] of Object.entries(config)) args.push("-c", `${key}=${JSON.stringify(value)}`);
  const child = startChild(ctx, args);
  let nextId = 0; let buffer = ""; let bytes = 0;
  const pending = new Map<number, { resolve(value: Json): void; reject(error: Error): void }>();
  let finish!: () => void; let rejectTurn!: (error: Error) => void;
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; rejectTurn = reject; });
  void completed.catch(() => {});
  const error = (failure: EngineFailure): void => { for (const call of pending.values()) call.reject(failure); pending.clear(); rejectTurn(failure); };
  const send = (message: Json): void => { child.stdin?.write(JSON.stringify(message) + "\n"); };
  const request = (method: string, params: Json): Promise<Json> => {
    ctx.signal.throwIfAborted(); const id = ++nextId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }); });
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > MAX_PROCESS_BYTES) { error(new EngineFailure("runtime_output_limit", "引擎输出超过测试上限。")); void stopChild(child); return; }
    buffer += chunk.toString("utf8");
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message: Json;
      try { message = obj(JSON.parse(line)); } catch { error(new EngineFailure("runtime_protocol_error", "Codex app-server 返回无效协议。")); continue; }
      const id = message["id"];
      if (typeof id === "number" && pending.has(id)) {
        const call = pending.get(id)!; pending.delete(id);
        if (message["error"]) call.reject(new EngineFailure("configuration_mismatch", "Codex 拒绝了隔离测试配置。"));
        else call.resolve(obj(message["result"]));
        continue;
      }
      const method = message["method"]; const params = obj(message["params"]);
      if (id !== undefined && method === "item/tool/call") {
        try { const receipt = invokeTool(ctx, str(params["tool"]), params["arguments"]); send({ id, result: { success: true, contentItems: [{ type: "inputText", text: receipt }] } }); }
        catch (failure) { send({ id, result: { success: false, contentItems: [] } }); error(failure as EngineFailure); }
      } else if (id !== undefined && method) {
        send({ id, error: { code: -32601, message: "Not available in isolated engine probe" } });
        error(new EngineFailure("unexpected_tool_call", "Codex 请求了测试范围以外的操作。"));
      } else if (method === "item/agentMessage/delta") { ctx.text += str(params["delta"]); ctx.textDelta ||= str(params["delta"]).length > 0; }
      else if (method === "turn/completed") {
        if (obj(params["turn"])["status"] === "completed") finish();
        else error(new EngineFailure("engine_turn_failed", "Codex 未完成测试轮次。"));
      } else if (method === "error") error(ctx.gatewayFailure ?? new EngineFailure("engine_turn_failed", "Codex 引擎测试失败。"));
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > MAX_PROCESS_BYTES) { error(new EngineFailure("runtime_output_limit", "引擎输出超过测试上限。")); void stopChild(child); } });
  child.on("error", () => error(new EngineFailure("runtime_unavailable", "无法启动 Codex app-server。")));
  child.on("close", () => error(new EngineFailure("runtime_closed", "Codex app-server 在测试完成前退出。")));
  const initialized = await request("initialize", { clientInfo: { name: "prospero_engine_probe", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  if (str(initialized["codexHome"]) && path.resolve(str(initialized["codexHome"])) !== path.resolve(ctx.env["CODEX_HOME"]!)) fail("configuration_mismatch", "Codex 没有使用隔离配置目录。");
  send({ method: "initialized", params: {} });
  const thread = await request("thread/start", {
    cwd: ctx.cwd, model: profile.model, modelProvider: "prospero_probe", sandbox: "read-only", approvalPolicy: "never",
    ephemeral: true, environments: [], baseInstructions: "You are running an isolated synthetic connection test. Use only the registered probe tool.",
    dynamicTools: [{ type: "function", name: TOOL, description: "Return a synthetic receipt without side effects.", inputSchema: { type: "object", properties: { nonce: { type: "string", enum: [ctx.nonce] } }, required: ["nonce"], additionalProperties: false } }],
  });
  if (thread["model"] !== profile.model || !str(obj(thread["thread"])["id"])) fail("configuration_mismatch", "Codex 没有载入 Profile 模型。");
  await request("turn/start", { threadId: obj(thread["thread"])["id"], input: [{ type: "text", text: prompt(ctx) }] });
  await completed;
}

async function runClaude(ctx: RunContext, baseUrl: string, token: string): Promise<void> {
  const profile = ctx.binding.apiProfile!;
  ctx.env["ANTHROPIC_API_KEY"] = token; ctx.env["ANTHROPIC_BASE_URL"] = baseUrl; ctx.env["ANTHROPIC_MODEL"] = profile.model;
  ctx.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = String(Math.min(profile.modelCapabilities?.maxOutputTokens ?? 1024, 1024));
  if (profile.modelCapabilities?.contextWindow) ctx.env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"] = String(profile.modelCapabilities.contextWindow);
  if (profile.modelCapabilities?.reasoning === false) ctx.env["MAX_THINKING_TOKENS"] = "0";
  const mcp = createSdkMcpServer({ name: "prospero_probe", version: "1.0.0", alwaysLoad: true, tools: [
    tool(TOOL, "Return a synthetic verification receipt without side effects.", { nonce: z.literal(ctx.nonce) }, async (args) => ({ content: [{ type: "text", text: invokeTool(ctx, ctx.toolName, args) }] })),
  ] });
  const abortController = new AbortController();
  const abort = (): void => abortController.abort();
  ctx.signal.addEventListener("abort", abort, { once: true });
  const options: ClaudeOptions = {
    cwd: ctx.cwd, env: ctx.env, pathToClaudeCodeExecutable: ctx.executable,
    tools: [], allowedTools: [ctx.toolName], settingSources: [], strictMcpConfig: true, skills: [],
    extraArgs: { bare: null, "disable-slash-commands": null, "no-session-persistence": null },
    mcpServers: { prospero_probe: mcp }, permissionMode: "dontAsk", maxTurns: 2,
    includePartialMessages: true, abortController, model: profile.model,
    ...(profile.modelCapabilities?.reasoning === false ? { thinking: { type: "disabled" as const } } : {}),
    systemPrompt: "You are running an isolated synthetic connection test. Use only the registered probe tool.",
    stderr: () => {},
    spawnClaudeCodeProcess: (options) => startChild(ctx, options.args) as unknown as ReturnType<NonNullable<ClaudeOptions["spawnClaudeCodeProcess"]>>,
  };
  let closeInput!: () => void;
  const inputClosed = new Promise<void>((resolve) => { closeInput = resolve; });
  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield { type: "user", message: { role: "user", content: prompt(ctx) }, parent_tool_use_id: null, session_id: "" };
    // In-process MCP control messages need stdin to remain open through the turn.
    await inputClosed;
  }
  const q = (ctx.options.claudeQuery ?? query)({ prompt: input(), options });
  let bytes = 0; let completed = false;
  try {
    for await (const message of q) {
      ctx.signal.throwIfAborted();
      bytes += Buffer.byteLength(JSON.stringify(message));
      if (bytes > MAX_PROCESS_BYTES) fail("runtime_output_limit", "引擎输出超过测试上限。");
      if (ctx.gatewayFailure) throw ctx.gatewayFailure;
      if (message.type === "system" && message.subtype === "init") {
        if (message.cwd !== ctx.cwd || message.model !== profile.model || message.tools.some((name) => name !== ctx.toolName) || message.plugins.length || message.skills.length) fail("configuration_mismatch", "Claude 没有载入预期的隔离工具与模型配置。");
        const detected = version(message.claude_code_version);
        if (detected) ctx.cliVersion = detected;
      }
      if (message.type === "stream_event" && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
        ctx.text += message.event.delta.text; ctx.textDelta ||= message.event.delta.text.length > 0;
      }
      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) fail("engine_turn_failed", "Claude 引擎未完成合成工具测试。");
        completed = true;
        closeInput();
        break;
      }
    }
    if (!completed) fail("runtime_closed", "Claude 在测试完成前结束了输出。");
  } finally { closeInput(); ctx.signal.removeEventListener("abort", abort); abortController.abort(); q.close(); }
}

async function runOpencode(ctx: RunContext, baseUrl: string, token: string, mcpUrl: string): Promise<void> {
  const profile = ctx.binding.apiProfile!;
  ctx.env["OPENAI_API_KEY"] = token;
  const configFile = path.join(ctx.root, "config", "opencode", "opencode.json");
  await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const config = {
    $schema: "https://opencode.ai/config.json", model: `prospero_probe/${profile.model}`, small_model: `prospero_probe/${profile.model}`,
    autoupdate: false, share: "disabled", plugin: [], permission: { "*": "deny", "prospero_probe_*": "allow" },
    provider: { prospero_probe: { npm: "@ai-sdk/openai-compatible", name: "Prospero engine probe", env: ["OPENAI_API_KEY"], options: { baseURL: baseUrl },
      models: { [profile.model]: { name: profile.model, tool_call: true, limit: { context: profile.modelCapabilities?.contextWindow ?? 32000, output: Math.min(profile.modelCapabilities?.maxOutputTokens ?? 1024, 1024) } } } } },
    mcp: { prospero_probe: { type: "remote", url: mcpUrl, oauth: false, enabled: true } },
    agent: { prospero_probe: { mode: "primary", description: "Isolated synthetic connection probe", prompt: "Use only the synthetic probe tool.", permission: { "*": "deny", "prospero_probe_*": "allow" } } },
  };
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  ctx.env["OPENCODE_CONFIG"] = configFile;
  const child = startChild(ctx, ["run", "--pure", "--format", "json", "--model", `prospero_probe/${profile.model}`, "--agent", "prospero_probe", "--title", "Prospero engine probe", prompt(ctx)]);
  // `run` also reads piped input before starting, even when argv has the prompt.
  child.stdin?.end();
  let buffer = ""; let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const error = (): void => reject(ctx.gatewayFailure ?? new EngineFailure("engine_turn_failed", "OpenCode 没有完成隔离引擎测试。"));
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength; if (bytes > MAX_PROCESS_BYTES) { void stopChild(child); error(); return; }
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let event: Json; try { event = obj(JSON.parse(line)); } catch { error(); continue; }
        if (event["type"] === "text") { ctx.text += str(obj(event["part"])["text"]); ctx.textDelta ||= str(obj(event["part"])["text"]).length > 0; }
        if (event["type"] === "error") error();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > MAX_PROCESS_BYTES) { void stopChild(child); error(); } });
    child.once("error", error);
    child.once("close", (code) => code === 0 ? resolve() : error());
  });
}

/** Actual isolated engine execution, separate from the direct wire protocol probe. */
export async function probeApiProfileEngine(binding: AccountBinding, options: ApiProfileEngineProbeOptions = {}): Promise<AgentApiEngineValidation> {
  const started = Date.now();
  const protocol = binding.apiProfile?.protocol ?? (binding.agent === "claude" ? "anthropic" : "openai_responses");
  const engine: Engine = protocol === "anthropic" ? "claude" : protocol === "openai_chat_completions" ? "opencode" : "codex";
  const checks: AgentApiEngineValidation["checks"] = { runtime: "not_tested", configuration: "not_tested", streaming: "not_tested", tools: "not_tested" };
  const controller = new AbortController(); let timedOut = false;
  const timeout = Math.min(60000, Math.max(1, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 45000));
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let ctx: RunContext | undefined; let gate: Awaited<ReturnType<typeof gateway>> | undefined; let root: string | undefined;
  let phase: keyof typeof checks | undefined;
  try {
    controller.signal.throwIfAborted();
    if (!binding.apiProfile) fail("invalid_profile", "此账号没有 API Profile。");
    if (binding.apiProfile.modelCapabilities?.tools === false) fail("tools_disabled", "该 Profile 已声明不支持工具调用。");
    if (!binding.environment[protocol === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"]) fail("credential_missing", "API Profile 尚未配置 Key。");
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "prospero-engine-probe-")));
    const env = environment(root); const cwd = path.join(root, "workspace");
    await Promise.all([cwd, env["CODEX_HOME"]!, env["CLAUDE_CONFIG_DIR"]!, env["TMPDIR"]!, env["XDG_CONFIG_HOME"]!, env["XDG_DATA_HOME"]!, env["XDG_CACHE_HOME"]!, env["XDG_STATE_HOME"]!].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
    ctx = { binding, protocol, engine, root, cwd, env, executable: executableFor(engine, options.executable), signal: controller.signal,
      options, checks, nonce: randomUUID(), receipt: "", toolCalls: 0, text: "", textDelta: false, children: new Set(), configurationSeen: false,
      toolName: engine === "claude" ? `mcp__prospero_probe__${TOOL}` : engine === "opencode" ? `prospero_probe_${TOOL}` : TOOL };
    phase = "runtime"; ctx.cliVersion = await runtimeVersion(ctx); checks.runtime = "passed";
    phase = "configuration"; gate = await gateway(ctx);
    const run = engine === "codex" ? runCodex(ctx, gate.baseUrl, gate.token) : engine === "claude" ? runClaude(ctx, gate.baseUrl, gate.token) : runOpencode(ctx, gate.baseUrl, gate.token, gate.mcpUrl);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new EngineFailure("cancelled", "引擎测试已取消。")); controller.signal.addEventListener("abort", onAbort, { once: true }); });
    try { await Promise.race([run, cancelled, gate.failure]); } finally { controller.signal.removeEventListener("abort", onAbort); }
    if (ctx.gatewayFailure) throw ctx.gatewayFailure;
    if (!ctx.configurationSeen) fail("configuration_mismatch", "引擎没有使用 Profile 指定的受控模型连接。");
    phase = "streaming";
    if (!ctx.textDelta) fail("streaming_unavailable", "引擎没有输出流式文本事件。");
    checks.streaming = "passed"; phase = "tools";
    if (ctx.toolCalls !== 1 || !ctx.receipt || ctx.text.trim() !== ctx.receipt) fail("tool_roundtrip_failed", "引擎没有完成合成工具调用、结果回传和最终文本验证。");
    checks.tools = "passed";
    return { status: "passed", checkedAt: Date.now(), engine, ...(ctx.cliVersion ? { cliVersion: ctx.cliVersion } : {}), checks, latencyMs: Date.now() - started,
      detail: "实际 Agent 引擎已在隔离目录载入 Profile，完成流式事件与合成工具往返。响应经受控代理完整检查后交给引擎；未执行项目工具。" };
  } catch (error) {
    if (phase === "configuration" && checks.configuration === "passed") phase = ctx?.toolCalls ? "tools" : "streaming";
    if (phase) checks[phase] = "failed";
    const failure = controller.signal.aborted ? new EngineFailure(timedOut ? "timeout" : "cancelled", timedOut ? "引擎测试超时，已停止。" : "引擎测试已取消。")
      : error instanceof EngineFailure ? error : ctx?.gatewayFailure ?? new EngineFailure("engine_failed", "无法完成隔离引擎测试。");
    return { status: "failed", checkedAt: Date.now(), engine, ...(ctx?.cliVersion ? { cliVersion: ctx.cliVersion } : {}), checks, code: failure.code,
      latencyMs: Date.now() - started, detail: failure.message };
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controller.abort();
    if (ctx) await Promise.all([...ctx.children].map(stopChild));
    await gate?.close();
    if (root) await rm(root, { recursive: true, force: true });
  }
}
