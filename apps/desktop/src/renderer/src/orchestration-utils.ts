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
