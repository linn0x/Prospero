import type { OrchestrationRun, OrchestrationSnapshot } from "@prospero/protocol";
import type { ConnStatus } from "@/lib/store";

export const GOAL_RUN_SUMMARY_LIMIT = 3;

export type OrchestrationNoticeTone = "quiet" | "warning" | "danger";

export interface OrchestrationConnectionNotice {
  text: string;
  tone: OrchestrationNoticeTone;
  canRetry: boolean;
}

/** Keeps each transient transport state distinct instead of treating failures as loading. */
export function orchestrationConnectionNotice(
  status: ConnStatus,
  lastError: string | null,
  hostName: string | undefined,
): OrchestrationConnectionNotice | null {
  const target = hostName ?? "Mac";
  switch (status) {
    case "connected":
      return null;
    case "idle":
      return { text: `${target} 尚未连接`, tone: "quiet", canRetry: false };
    case "connecting":
      return { text: `正在连接 ${target}…`, tone: "warning", canRetry: false };
    case "reconnecting":
      return { text: `正在重连 ${target}…`, tone: "warning", canRetry: false };
    case "failed":
      return {
        text: lastError ? `连接失败：${lastError}` : "连接失败。请检查网络后重试。",
        tone: "danger",
        canRetry: true,
      };
  }
}

export interface GoalRunOverview {
  visibleRuns: OrchestrationRun[];
  activeRunCount: number;
  truncatedRunCount: number;
  pendingGateCount: number;
  truncatedPendingGateCount: number;
  /** The first hidden Run that contains a pending Gate, if any. */
  firstTruncatedGateRunId: string | null;
}

/**
 * Indexes coordinator sessions for the session list and detail screen.
 * An active Run wins over historical Runs; otherwise the newest update wins.
 */
export function coordinatorRunsBySession(
  runs: readonly OrchestrationRun[],
): Map<string, OrchestrationRun> {
  const indexed = new Map<string, OrchestrationRun>();
  for (const run of runs) {
    const sessionId = run.coordinatorSessionId;
    if (!sessionId) continue;
    const previous = indexed.get(sessionId);
    const active = run.status === "active";
    const previousActive = previous?.status === "active";
    if (
      previous === undefined ||
      (active && !previousActive) ||
      (active === previousActive && run.updatedAt > previous.updatedAt)
    ) {
      indexed.set(sessionId, run);
    }
  }
  return indexed;
}

/**
 * Home intentionally remains a compact summary. Pending human decisions come
 * first, then the newest remaining Runs, with deterministic ties for a stable
 * order across snapshot deliveries.
 */
export function goalRunOverview(
  snapshot: OrchestrationSnapshot | null,
  limit = GOAL_RUN_SUMMARY_LIMIT,
): GoalRunOverview {
  const activeRuns = (snapshot?.runs ?? []).filter((run) => run.status === "active");
  const activeRunIds = new Set(activeRuns.map((run) => run.id));
  const pendingGatesByRun = new Map<string, number>();
  for (const gate of snapshot?.gates ?? []) {
    if (gate.status !== "pending" || !activeRunIds.has(gate.runId)) continue;
    pendingGatesByRun.set(gate.runId, (pendingGatesByRun.get(gate.runId) ?? 0) + 1);
  }

  const orderedRuns = [...activeRuns].sort((left, right) => {
    const gateOrder = Number((pendingGatesByRun.get(right.id) ?? 0) > 0)
      - Number((pendingGatesByRun.get(left.id) ?? 0) > 0);
    if (gateOrder !== 0) return gateOrder;
    return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
  });
  const visibleRuns = orderedRuns.slice(0, Math.max(0, limit));
  const truncatedRuns = orderedRuns.slice(visibleRuns.length);
  const pendingGateCount = Array.from(pendingGatesByRun.values()).reduce(
    (total, count) => total + count,
    0,
  );
  const truncatedPendingGateCount = truncatedRuns.reduce(
    (total, run) => total + (pendingGatesByRun.get(run.id) ?? 0),
    0,
  );

  return {
    visibleRuns,
    activeRunCount: orderedRuns.length,
    truncatedRunCount: truncatedRuns.length,
    pendingGateCount,
    truncatedPendingGateCount,
    firstTruncatedGateRunId:
      truncatedRuns.find((run) => (pendingGatesByRun.get(run.id) ?? 0) > 0)?.id ?? null,
  };
}

/** Builds the one-hop deep link from the compact home summary to orchestration. */
export function orchestrationRoute(hostId: string, runId?: string | null): string {
  const path = `/host/${encodeURIComponent(hostId)}/orchestration`;
  return runId ? `${path}?runId=${encodeURIComponent(runId)}` : path;
}

/** Ignores a stale or malformed deep-link selection and preserves normal entry. */
export function selectedRouteRunId(
  value: string | string[] | undefined,
  runs: readonly OrchestrationRun[],
): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && runs.some((run) => run.id === candidate) ? candidate : null;
}
