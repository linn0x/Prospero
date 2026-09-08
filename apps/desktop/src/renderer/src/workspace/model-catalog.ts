import type { AgentModel, AgentModelCatalog, DesktopApi, JsonObject, SessionInfo } from "../../../shared/types";


const catalogCache = new Map<string, { value: AgentModelCatalog; at: number }>();
const catalogRequests = new Map<string, Promise<AgentModelCatalog>>();
const LIMIT = 40;

// The running adapter's capability is authoritative. Account defaults describe
// session creation and may mark API sources as non-selectable (e.g. DeepSeek).
export function modelSwitchSupported(session: SessionInfo, _account?: JsonObject): boolean {
  return session.kind === "structured" && session.agentControls?.model === true;
}

export function supportedModelEffort(model: AgentModel | undefined, effort: string): string | undefined {
  return effort && model?.supportedEfforts.includes(effort) ? effort : undefined;
}

export function cachedModelCatalog(sessionId: string, now = Date.now()): AgentModelCatalog | undefined {
  const item = catalogCache.get(sessionId);
  return item && now - item.at < 60_000 ? item.value : undefined;
}

export function saveModelCatalog(sessionId: string, value: AgentModelCatalog): void {
  catalogCache.delete(sessionId);
  catalogCache.set(sessionId, { value, at: Date.now() });
  while (catalogCache.size > LIMIT) catalogCache.delete(catalogCache.keys().next().value!);
}

export function loadModelCatalog(api: Pick<DesktopApi, "getAgentModels">, sessionId: string, refresh = false): Promise<AgentModelCatalog> {
  const cached = refresh ? undefined : cachedModelCatalog(sessionId);
  if (cached) return Promise.resolve(cached);
  const inflight = catalogRequests.get(sessionId);
  if (inflight) return inflight;
  const request = api.getAgentModels(sessionId).then((value) => {
    saveModelCatalog(sessionId, value);
    return value;
  }).finally(() => { catalogRequests.delete(sessionId); });
  catalogRequests.set(sessionId, request);
  return request;
}
