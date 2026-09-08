import { AgentModelCapabilitiesSchema, AgentReasoningEffortSchema, type AgentApiCatalogModel, type AgentApiProtocol, type AgentModelCapabilities } from "@prospero/protocol";
import { AgentAccountFeatureError } from "./agent-account-feature-error.js";

export interface ApiModelCatalogInput {
  protocol: AgentApiProtocol;
  baseUrl: string;
  apiKey: string;
}

export interface ApiModelCatalogOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  maxModels?: number;
  maxPages?: number;
}

export function apiModelsUrl(baseUrl: string, protocol: AgentApiProtocol): URL {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new AgentAccountFeatureError("invalid_request", "API 地址必须是完整 URL"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (baseUrl.length > 2000 || /[\r\n\0]/.test(baseUrl) || url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new AgentAccountFeatureError("invalid_request", "API 地址必须使用 HTTPS（localhost 可使用 HTTP），且不能包含凭据或查询参数");
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  pathname = pathname.replace(/\/(?:chat\/completions|responses|messages|models)$/i, "");
  if (!pathname || protocol === "anthropic" && !/\/v\d+(?:beta\d*)?$/i.test(pathname)) pathname += "/v1";
  url.pathname = `${pathname}/models`;
  return url;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeText(value: unknown, max: number, secret: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text) || text.includes(secret)) return undefined;
  return text;
}

function catalogCapabilities(row: Record<string, unknown>, protocol: AgentApiProtocol): AgentModelCapabilities | undefined {
  const explicit = record(row["model_capabilities"]);
  const capabilities = record(row["capabilities"]);
  const result: AgentModelCapabilities = {};
  const limits = {
    contextWindow: explicit?.["contextWindow"] ?? (protocol === "anthropic" ? row["max_input_tokens"] : row["context_window"]),
    maxOutputTokens: explicit?.["maxOutputTokens"] ?? (protocol === "anthropic" ? row["max_tokens"] : row["max_output_tokens"]),
  };
  for (const field of ["contextWindow", "maxOutputTokens"] as const) {
    const value = limits[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 100_000_000) result[field] = value;
  }
  if (result.contextWindow && result.maxOutputTokens && result.maxOutputTokens > result.contextWindow) {
    delete result.contextWindow; delete result.maxOutputTokens;
  }
  for (const field of ["tools", "vision", "reasoning"] as const) {
    const native = protocol === "anthropic" ? capabilities?.[field === "vision" ? "image_input" : field === "reasoning" ? "thinking" : "tools"] : capabilities?.[field];
    const value = explicit?.[field] ?? (typeof native === "boolean" ? native : record(native)?.["supported"]);
    if (typeof value === "boolean") result[field] = value;
  }
  const effort = protocol === "anthropic" ? record(capabilities?.["effort"]) : null;
  const reported = explicit?.["supportedEfforts"] ?? row["supported_reasoning_efforts"];
  if (Array.isArray(reported) && reported.length <= 10 && reported.every(value => AgentReasoningEffortSchema.safeParse(value).success)) {
    result.supportedEfforts = [...new Set(reported)] as AgentModelCapabilities["supportedEfforts"];
  } else if (effort?.["supported"] === false) result.supportedEfforts = [];
  else if (effort?.["supported"] === true) {
    const values = AgentReasoningEffortSchema.options.filter(value => record(effort[value])?.["supported"] === true);
    if (values.length) result.supportedEfforts = values;
  }
  if (result.reasoning === false) delete result.supportedEfforts;
  return Object.keys(result).length ? AgentModelCapabilitiesSchema.parse(result) : undefined;
}

export async function fetchApiModels(input: ApiModelCatalogInput, options: ApiModelCatalogOptions = {}): Promise<AgentApiCatalogModel[]> {
  if (!input.apiKey.trim() || input.apiKey.length > 8192 || /[\r\n\0]/.test(input.apiKey)) {
    throw new AgentAccountFeatureError("invalid_request", "请填写有效的 API Key");
  }
  const endpoint = apiModelsUrl(input.baseUrl, input.protocol);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  const maxModels = Math.min(options.maxModels ?? 1000, 1000);
  const maxPages = options.maxPages ?? 10;
  const models = new Map<string, AgentApiCatalogModel>();
  const seenCursors = new Set<string>();
  let totalBytes = 0;
  let cursor: string | undefined;
  try {
    for (let page = 0; page < maxPages; page++) {
      let url = new URL(endpoint);
      if (input.protocol === "anthropic") url.searchParams.set("limit", "100");
      if (cursor) url.searchParams.set(input.protocol === "anthropic" ? "after_id" : "after", cursor);
      let response: Response | undefined;
      for (let redirect = 0; redirect <= 3; redirect++) {
        response = await (options.fetch ?? fetch)(url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: input.protocol === "anthropic"
            ? { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01", accept: "application/json" }
            : { authorization: `Bearer ${input.apiKey}`, accept: "application/json" },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        let next: URL;
        try { next = new URL(location ?? "", url); } catch { throw new AgentAccountFeatureError("unsupported", "模型目录重定向无效"); }
        if (!location || redirect === 3 || next.origin !== endpoint.origin || next.username || next.password) {
          throw new AgentAccountFeatureError("unsupported", "模型目录不支持跨站或过多重定向");
        }
        url = next;
      }
      if (!response) throw new AgentAccountFeatureError("network", "无法连接模型目录");
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new AgentAccountFeatureError("authentication", "模型目录认证失败，请检查 API Key 与访问权限");
        if ([404, 405, 501].includes(response.status)) throw new AgentAccountFeatureError("unsupported", "服务商不支持模型目录，仍可手动填写模型 ID");
        throw new AgentAccountFeatureError("network", "模型目录请求失败，请稍后重试或手动填写模型 ID");
      }
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > maxBytes - totalBytes) {
        await response.body?.cancel();
        throw new AgentAccountFeatureError("limit_exceeded", "模型目录响应超过大小限制");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new AgentAccountFeatureError("invalid_format", "模型目录响应格式不兼容");
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          totalBytes += chunk.value.byteLength;
          if (totalBytes > maxBytes) throw new AgentAccountFeatureError("limit_exceeded", "模型目录响应超过大小限制");
          chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      let payload: Record<string, unknown> | null;
      try { payload = record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { throw new AgentAccountFeatureError("invalid_format", "模型目录响应不是有效 JSON"); }
      if (!payload || !Array.isArray(payload["data"])) throw new AgentAccountFeatureError("invalid_format", "模型目录响应缺少模型列表");
      if (payload["has_more"] !== undefined && typeof payload["has_more"] !== "boolean") throw new AgentAccountFeatureError("invalid_format", "模型目录分页信息无效");
      for (const value of payload["data"]) {
        const row = record(value);
        const id = safeText(row?.["id"], 300, input.apiKey);
        if (!row || !id) throw new AgentAccountFeatureError("invalid_format", "模型目录包含无效模型记录");
        const label = safeText(row["display_name"] ?? row["name"], 300, input.apiKey);
        const owner = safeText(row["owned_by"], 300, input.apiKey);
        const description = safeText(row["description"], 1000, input.apiKey);
        const modelCapabilities = catalogCapabilities(row, input.protocol);
        if (!models.has(id)) models.set(id, { id, ...(label ? { label } : {}), ...(owner ? { owner } : {}), ...(description ? { description } : {}), ...(modelCapabilities ? { modelCapabilities } : {}) });
        if (models.size > maxModels) throw new AgentAccountFeatureError("limit_exceeded", "模型数量超过目录限制，请手动填写模型 ID");
      }
      if (payload["has_more"] !== true) {
        if (models.size === 0) throw new AgentAccountFeatureError("empty_catalog", "服务商返回空模型目录，仍可手动填写模型 ID");
        return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
      }
      cursor = safeText(payload["last_id"], 300, input.apiKey);
      if (!cursor || seenCursors.has(cursor)) throw new AgentAccountFeatureError("invalid_format", "模型目录分页信息无效");
      seenCursors.add(cursor);
    }
    throw new AgentAccountFeatureError("limit_exceeded", "模型目录分页超过限制，请手动填写模型 ID");
  } catch (error) {
    if (error instanceof AgentAccountFeatureError) throw error;
    if (controller.signal.aborted) throw new AgentAccountFeatureError("timeout", "模型目录请求已超时或取消，请重试");
    throw new AgentAccountFeatureError("network", "无法连接模型目录，请检查地址和网络");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}
