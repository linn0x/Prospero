import type { JsonObject } from "../../shared/types";

const TERMINAL_WORKTREE_STATES = new Set(["cleaned", "missing"]);
const URGENT_WORKTREE_STATES = new Set([
  "conflict",
  "dirty",
  "diverged",
  "error",
  "failed",
  "unmerged",
]);
const COMPLETED_TASK_STATES = new Set(["done", "completed", "succeeded"]);

export type TaskBoardColumnId = "queued" | "ready" | "running" | "review" | "done";

export type RunTimelineItem = {
  id: string;
  kind: "task" | "gate";
  item: JsonObject;
  time: number;
};

function valueText(value: unknown): string {
  return typeof value === "string" ? value.toLocaleLowerCase() : "";
}

function valueRecord(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function worktreeNeedsAttention(asset: JsonObject): boolean {
  return !TERMINAL_WORKTREE_STATES.has(valueText(asset["state"]));
}

function worktreePriority(asset: JsonObject): number {
  const state = valueText(asset["state"]);
  const inspectionState = valueText(valueRecord(asset["lastInspection"])["state"]);
  if (URGENT_WORKTREE_STATES.has(state) || URGENT_WORKTREE_STATES.has(inspectionState)) return 0;
  return worktreeNeedsAttention(asset) ? 1 : 2;
}

export function prioritizeWorktrees(assets: JsonObject[]): JsonObject[] {
  return [...assets].sort((left, right) => {
    const priority = worktreePriority(left) - worktreePriority(right);
    if (priority !== 0) return priority;
    const rightUpdatedAt = timestamp(right["updatedAt"] ?? right["createdAt"]);
    const leftUpdatedAt = timestamp(left["updatedAt"] ?? left["createdAt"]);
    return rightUpdatedAt - leftUpdatedAt;
  });
}

export function runTimelineItems(tasks: JsonObject[], gates: JsonObject[]): RunTimelineItem[] {
  return [
    ...tasks.map((item): RunTimelineItem => ({
      id: String(item["id"] ?? ""),
      kind: "task",
      item,
      time: timestamp(item["updatedAt"] ?? item["createdAt"]),
    })),
    ...gates.map((item): RunTimelineItem => ({
      id: String(item["id"] ?? ""),
      kind: "gate",
      item,
      time: timestamp(item["resolvedAt"] ?? item["createdAt"]),
    })),
  ].sort((left, right) => right.time - left.time || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

export function runListLabel(objective: string): string {
  return objective.match(/\bsupervise PSM\s+([^\s]+)/i)?.[1] ?? objective;
}

export function prioritizeRuns(runs: JsonObject[]): JsonObject[] {
  return [...runs].sort((left, right) => {
    const active = Number(valueText(right["status"]) === "active") - Number(valueText(left["status"]) === "active");
    if (active !== 0) return active;
    const updated = timestamp(right["updatedAt"] ?? right["createdAt"]) - timestamp(left["updatedAt"] ?? left["createdAt"]);
    return updated || String(left["id"] ?? "").localeCompare(String(right["id"] ?? ""));
  });
}

export function deriveTaskBoardStates(tasks: JsonObject[]): Map<string, TaskBoardColumnId> {
  const completed = new Set(
    tasks
      .filter((task) => COMPLETED_TASK_STATES.has(valueText(task["status"])))
      .map((task) => String(task["id"] ?? ""))
      .filter(Boolean),
  );
  const states = new Map<string, TaskBoardColumnId>();
  for (const task of tasks) {
    const id = String(task["id"] ?? "");
    const status = valueText(task["status"]);
    if (!id) continue;
    if (status === "pending") {
      const deps = Array.isArray(task["deps"])
        ? task["deps"].map(String)
        : [];
      states.set(id, deps.every((dependency) => completed.has(dependency)) ? "ready" : "queued");
    } else if (status === "ready") {
      states.set(id, "ready");
    } else if (["dispatched", "running", "starting"].includes(status)) {
      states.set(id, "running");
    } else if (["blocked", "failed", "waiting_approval"].includes(status)) {
      states.set(id, "review");
    } else if (COMPLETED_TASK_STATES.has(status) || status === "cancelled") {
      states.set(id, "done");
    }
  }
  return states;
}
