export const LEGACY_DESKTOP_SPEC_LIMIT = 320;
export const LEGACY_DESKTOP_RESULT_LIMIT = 400;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function records(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.map(object)
    : Object.values(object(value)).map(object);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function limitedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export function legacyProjectionNeedsRefresh(
  sourceMtimeNs: bigint | undefined,
  targetMtimeNs: bigint | undefined,
  projectedSourceMtimeNs?: bigint | undefined,
): boolean {
  if (sourceMtimeNs === undefined) return false;
  if (projectedSourceMtimeNs !== undefined) return projectedSourceMtimeNs !== sourceMtimeNs;
  return targetMtimeNs === undefined || targetMtimeNs < sourceMtimeNs;
}

export function legacyProjectionSourceMtime(prefix: string): bigint | undefined {
  const match = prefix.match(/"sourceMtimeNs":"(\d+)"/);
  if (!match?.[1]) return undefined;
  try { return BigInt(match[1]); } catch { return undefined; }
}

export function createLegacyDesktopProjection(source: unknown, sourceMtimeNs?: bigint): JsonObject {
  const state = object(source);
  return {
    version: 1,
    ...(sourceMtimeNs !== undefined ? { sourceMtimeNs: String(sourceMtimeNs) } : {}),
    revision: typeof state["eventSeq"] === "number" ? state["eventSeq"] : 0,
    runs: records(state["runs"]).map((run) => ({
      id: run["id"],
      objective: run["objective"],
      status: run["status"],
      coordinatorSessionId: run["coordinatorSessionId"],
      graphRevision: run["graphRevision"],
      createdAt: run["createdAt"],
      updatedAt: run["updatedAt"],
      automation: run["automation"] ?? null,
    })),
    tasks: records(state["tasks"]).map((task) => {
      const spec = text(task["spec"]);
      const result = typeof task["result"] === "string" ? task["result"] : null;
      return {
        id: task["id"],
        runId: task["runId"],
        title: task["title"],
        skills: task["skills"] ?? [],
        deps: task["deps"],
        parentId: task["parentId"],
        status: task["status"],
        result: result === null
          ? null
          : limitedText(result, LEGACY_DESKTOP_RESULT_LIMIT),
        createdAt: task["createdAt"],
        updatedAt: task["updatedAt"],
        spec: limitedText(spec, LEGACY_DESKTOP_SPEC_LIMIT),
        specTruncated: spec.length > LEGACY_DESKTOP_SPEC_LIMIT,
        resultTruncated: result !== null &&
          result.length > LEGACY_DESKTOP_RESULT_LIMIT,
      };
    }),
    dispatches: records(state["dispatches"]).map((dispatch) => ({
      id: dispatch["id"],
      runId: dispatch["runId"],
      taskId: dispatch["taskId"],
      sessionId: dispatch["sessionId"],
      state: dispatch["state"],
      startedAt: dispatch["startedAt"],
      settledAt: dispatch["settledAt"],
      worktreePath: dispatch["worktreePath"],
    })),
    gates: records(state["gates"]).map((gate) => ({
      id: gate["id"],
      runId: gate["runId"],
      taskId: gate["taskId"],
      question: gate["question"],
      options: gate["options"],
      status: gate["status"],
      decision: gate["decision"],
      createdAt: gate["createdAt"],
      resolvedAt: gate["resolvedAt"],
    })),
    worktreeAssets: records(state["worktreeAssets"]),
  };
}
