import type { AgentApiCatalogModel, ModelSource, ModelSourceRoute, ModelSourceAction } from "../../../shared/types";
import { ApiHeadersSchema } from "@prospero/protocol";
import type { AgentModelCapabilities, AgentReasoningEffort } from "@prospero/protocol";
import { accountReasoningEfforts, modelCapabilityDraft, parseModelCapabilities, type ModelCapabilityDraft } from "../account-profile-form";

export type SourceSelection = { sourceId: string; routeId: string; revision: number };

export function parseSourceHeaders(value: string): Record<string, string> {
  const entries = value.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("每行使用 Header: Value / Use Header: Value on each line");
    return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()] as const;
  });
  if (new Set(entries.map(([name]) => name.toLowerCase())).size !== entries.length) throw new Error("Header 名称不能重复 / Duplicate header names");
  const parsed = ApiHeadersSchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) throw new Error("Header 格式无效或包含保留字段；认证请使用 API Key / Invalid or reserved headers; use API Key for authentication");
  return parsed.data;
}

export function selectedSourceRoute(sources: readonly ModelSource[], selection: SourceSelection | undefined) {
  const source = sources.find(item => item.id === selection?.sourceId);
  const route = source?.routes.find(item => item.id === selection?.routeId);
  return source && route && source.enabled && route.enabled && route.modelCapabilities?.tools !== false && source.revision === selection?.revision ? { source, route } : undefined;
}

export function defaultSourceSelection(sources: readonly ModelSource[], preferred?: Pick<SourceSelection, "sourceId" | "routeId">): SourceSelection | undefined {
  const candidates = [...sources].sort((left, right) => Number(right.id === preferred?.sourceId) - Number(left.id === preferred?.sourceId));
  for (const source of candidates) {
    if (!source.enabled) continue;
    const routes = source.routes.filter(route => route.enabled && route.modelCapabilities?.tools !== false);
    const route = routes.find(item => item.id === preferred?.routeId) ?? routes.find(item => item.id === source.defaultRouteId) ?? routes[0];
    if (route) return { sourceId: source.id, routeId: route.id, revision: source.revision };
  }
  return undefined;
}

export function sourceRouteAgent(route: ModelSourceRoute): "codex" | "claude" { return route.protocol === "anthropic" ? "claude" : "codex"; }

export type SourceRouteDraft = { model: string; name: string; protocol: ModelSourceRoute["protocol"]; capabilities: ModelCapabilityDraft; effort: string; partialTokenLimits?: Pick<AgentModelCapabilities, "contextWindow" | "maxOutputTokens"> };
export function hasPartialCatalogLimits(model: AgentApiCatalogModel, protocol: ModelSourceRoute["protocol"]): boolean {
  return protocol === "openai_chat_completions" && (model.modelCapabilities?.contextWindow === undefined) !== (model.modelCapabilities?.maxOutputTokens === undefined);
}
export function catalogCapabilities(model: AgentApiCatalogModel, protocol: ModelSourceRoute["protocol"]): AgentModelCapabilities | undefined {
  if (!model.modelCapabilities) return undefined;
  const capabilities = { ...model.modelCapabilities };
  if (hasPartialCatalogLimits(model, protocol)) { delete capabilities.contextWindow; delete capabilities.maxOutputTokens; }
  return Object.keys(capabilities).length ? capabilities : undefined;
}
export function catalogRouteDraft(model: AgentApiCatalogModel, protocol: ModelSourceRoute["protocol"]): SourceRouteDraft {
  return { name: (model.label?.trim() || model.id).slice(0, 80), model: model.id, protocol, capabilities: modelCapabilityDraft(catalogCapabilities(model, protocol)), effort: "",
    ...(hasPartialCatalogLimits(model, protocol) ? { partialTokenLimits: { contextWindow: model.modelCapabilities?.contextWindow, maxOutputTokens: model.modelCapabilities?.maxOutputTokens } } : {}) };
}
export function retainSourceRouteDrafts(previous: ModelSource["endpoints"], next: ModelSource["endpoints"], drafts: readonly SourceRouteDraft[]): SourceRouteDraft[] {
  const normalize = (url: string) => url.trim().replace(/\/+$/, "");
  return drafts.filter(draft => {
    const before = previous.find(endpoint => endpoint.protocol === draft.protocol);
    const after = next.find(endpoint => endpoint.protocol === draft.protocol);
    return before && after && normalize(before.baseUrl) === normalize(after.baseUrl) && JSON.stringify(before.headers ?? {}) === JSON.stringify(after.headers ?? {});
  });
}
export function sourceDraftRoutes(drafts: readonly SourceRouteDraft[]): NonNullable<Extract<ModelSourceAction, { kind: "create" }>["routes"]> {
  return drafts.map(draft => {
    const modelCapabilities = parseModelCapabilities(draft.capabilities, {}, draft.protocol) as AgentModelCapabilities | null;
    const effort = draft.effort as AgentReasoningEffort;
    if (effort && (draft.protocol === "openai_chat_completions" || !accountReasoningEfforts.includes(effort) || !modelCapabilities?.supportedEfforts?.includes(effort))) throw new Error("默认推理强度须在支持的档位中 / Default effort must be supported");
    return { name: draft.name.trim(), model: draft.model, protocol: draft.protocol, enabled: true, ...(modelCapabilities ? { modelCapabilities } : {}), ...(effort ? { defaultEffort: effort } : {}) };
  });
}

export function catalogRouteUpdates(source: ModelSource, protocol: ModelSourceRoute["protocol"], credentialId: string, models: readonly AgentApiCatalogModel[], selected: ReadonlySet<string>): Extract<ModelSourceAction, { kind: "routes.set" }>["routes"] {
  return models.filter(model => selected.has(model.id)).slice(0, 500).map(model => {
    const existing = source.routes.find(route => route.protocol === protocol && route.credentialId === credentialId && route.model === model.id);
    const modelCapabilities = catalogCapabilities(model, protocol);
    return existing ? { ...existing, enabled: true } : { name: (model.label?.trim() || model.id).slice(0, 80), model: model.id, protocol, credentialId, enabled: true, ...(modelCapabilities ? { modelCapabilities } : {}) };
  });
}

const PREFERENCE_KEY = "prospero.newSession.modelSource";
export function rememberedSourceSelection(): Pick<SourceSelection, "sourceId" | "routeId"> | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? "null");
    if (!value || typeof value !== "object") return undefined;
    const row = value as Record<string, unknown>;
    if (typeof row.sourceId === "string" && typeof row.routeId === "string" && [row.sourceId, row.routeId].every(id => /^[A-Za-z0-9-]{1,100}$/.test(id))) return { sourceId: row.sourceId, routeId: row.routeId };
  } catch {}
  return undefined;
}
export function rememberSourceSelection(selection: SourceSelection | undefined): void {
  try { if (selection) localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ sourceId: selection.sourceId, routeId: selection.routeId })); else localStorage.removeItem(PREFERENCE_KEY); } catch {}
}
