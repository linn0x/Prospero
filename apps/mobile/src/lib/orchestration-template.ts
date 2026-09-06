export const ORCHESTRATION_TEMPLATE_SCHEMA_VERSION = 1 as const;

export interface OrchestrationTemplateDraftNode {
  id: string;
  title: string;
  spec: string;
  deps: string[];
}

export interface OrchestrationTemplateNodeV1 {
  key: string;
  title: string;
  spec: string;
  dependencyKeys: string[];
}

export interface OrchestrationTemplatePayloadV1 {
  schemaVersion: typeof ORCHESTRATION_TEMPLATE_SCHEMA_VERSION;
  objective: string;
  nodes: OrchestrationTemplateNodeV1[];
}

export interface OrchestrationTemplate {
  id: string;
  name: string;
  payload: OrchestrationTemplatePayloadV1;
  createdAtMs: number;
  updatedAtMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createOrchestrationTemplatePayload(
  objective: string,
  nodes: OrchestrationTemplateDraftNode[],
): OrchestrationTemplatePayloadV1 {
  const keyById = new Map(nodes.map((node, index) => [node.id, `node-${String(index + 1)}`]));
  return {
    schemaVersion: ORCHESTRATION_TEMPLATE_SCHEMA_VERSION,
    objective: objective.trim(),
    nodes: nodes.map((node) => ({
      key: keyById.get(node.id)!,
      title: node.title.trim(),
      spec: node.spec.trim(),
      dependencyKeys: node.deps.flatMap((id) => {
        const key = keyById.get(id);
        return key === undefined ? [] : [key];
      }),
    })),
  };
}

export function instantiateOrchestrationTemplate(
  payload: OrchestrationTemplatePayloadV1,
  createId: () => string,
): { objective: string; nodes: OrchestrationTemplateDraftNode[] } {
  const idByKey = new Map(payload.nodes.map((node) => [node.key, createId()]));
  return {
    objective: payload.objective,
    nodes: payload.nodes.map((node) => ({
      id: idByKey.get(node.key)!,
      title: node.title,
      spec: node.spec,
      deps: node.dependencyKeys.flatMap((key) => {
        const id = idByKey.get(key);
        return id === undefined ? [] : [id];
      }),
    })),
  };
}

export function parseOrchestrationTemplatePayload(
  value: unknown,
): OrchestrationTemplatePayloadV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== ORCHESTRATION_TEMPLATE_SCHEMA_VERSION
    || typeof value.objective !== "string"
    || !Array.isArray(value.nodes)
    || value.nodes.length === 0) return null;

  const nodes: OrchestrationTemplateNodeV1[] = [];
  const keys = new Set<string>();
  for (const candidate of value.nodes) {
    if (!isRecord(candidate)
      || typeof candidate.key !== "string"
      || candidate.key.length === 0
      || keys.has(candidate.key)
      || typeof candidate.title !== "string"
      || typeof candidate.spec !== "string"
      || !Array.isArray(candidate.dependencyKeys)
      || candidate.dependencyKeys.some((key) => typeof key !== "string")) return null;
    keys.add(candidate.key);
    nodes.push({
      key: candidate.key,
      title: candidate.title,
      spec: candidate.spec,
      dependencyKeys: [...new Set(candidate.dependencyKeys as string[])],
    });
  }

  if (nodes.some((node) => node.dependencyKeys.some(
    (key) => key === node.key || !keys.has(key),
  ))) return null;

  return {
    schemaVersion: ORCHESTRATION_TEMPLATE_SCHEMA_VERSION,
    objective: value.objective,
    nodes,
  };
}

export function decodeOrchestrationTemplatePayload(
  json: string,
): OrchestrationTemplatePayloadV1 | null {
  try {
    return parseOrchestrationTemplatePayload(JSON.parse(json) as unknown);
  } catch {
    return null;
  }
}
