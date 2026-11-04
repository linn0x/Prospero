import type { AgentApiCatalogModel, CodeAgentKind, ModelSource, ModelSourceRoute } from "@prospero/protocol";

export type SourceModelChoice =
  | { kind: "route"; route: ModelSourceRoute }
  | { kind: "catalog"; model: AgentApiCatalogModel; protocol: ModelSourceRoute["protocol"]; credentialId: string };

export function modelSourcePresentation(width: number, height: number): "side" | "bottom" {
  return width >= 720 && width > height ? "side" : "bottom";
}

export function sourceRouteMatchesAgent(route: Pick<ModelSourceRoute, "protocol">, preferred: CodeAgentKind): boolean {
  if (preferred === "pi") return true;
  if (preferred === "claude") return route.protocol === "anthropic";
  if (preferred === "opencode") return route.protocol === "openai_chat_completions";
  return route.protocol === "openai_responses" || route.protocol === "openai_chat_completions";
}

export function sourceCatalogTarget(source: ModelSource, preferred: CodeAgentKind): { protocol: ModelSourceRoute["protocol"]; credentialId: string } | null {
  if (!source.enabled) return null;
  const route = source.routes.find((item) => item.id === source.defaultRouteId && item.enabled && item.modelCapabilities?.tools !== false && sourceRouteMatchesAgent(item, preferred)) ??
    source.routes.find((item) => item.enabled && item.modelCapabilities?.tools !== false && sourceRouteMatchesAgent(item, preferred));
  const endpoint = route
    ? source.endpoints.find((item) => item.protocol === route.protocol)
    : source.endpoints.find((item) => sourceRouteMatchesAgent(item, preferred));
  const credential = source.credentials.find((item) => item.id === route?.credentialId) ?? source.credentials[0];
  return endpoint && credential ? { protocol: endpoint.protocol, credentialId: credential.id } : null;
}

export function catalogRouteInput(model: AgentApiCatalogModel, protocol: ModelSourceRoute["protocol"], credentialId: string) {
  const capabilities = model.modelCapabilities ? { ...model.modelCapabilities } : undefined;
  if (protocol === "openai_chat_completions" && capabilities && (capabilities.contextWindow === undefined) !== (capabilities.maxOutputTokens === undefined)) {
    delete capabilities.contextWindow;
    delete capabilities.maxOutputTokens;
  }
  return { name: (model.label?.trim() || model.id).slice(0, 80), model: model.id, protocol, credentialId, enabled: true,
    ...(capabilities && Object.keys(capabilities).length ? { modelCapabilities: capabilities } : {}) };
}

/** Pick the compatible Agent automatically when selecting a model source route. */
export function agentForSourceRoute(route: ModelSourceRoute, preferred: CodeAgentKind): CodeAgentKind {
  if (preferred === "pi") return "pi";
  if (route.protocol === "anthropic") return "claude";
  if (route.protocol === "openai_chat_completions" && preferred === "opencode") return "opencode";
  return "codex";
}

/** Show each enabled model once, preferring the default or the current Agent's route. */
export function availableSourceRoutes(source: ModelSource, preferred: CodeAgentKind): ModelSourceRoute[] {
  if (!source.enabled) return [];
  const routes = source.routes.filter((route) => route.enabled && route.modelCapabilities?.tools !== false && sourceRouteMatchesAgent(route, preferred));
  const byModel = new Map<string, ModelSourceRoute>();
  for (const route of routes) {
    const current = byModel.get(route.model);
    if (!current || route.id === source.defaultRouteId ||
      (current.id !== source.defaultRouteId && agentForSourceRoute(route, preferred) === preferred && agentForSourceRoute(current, preferred) !== preferred)) {
      byModel.set(route.model, route);
    }
  }
  return [...byModel.values()];
}
