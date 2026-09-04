import type { JsonObject } from "../../shared/types";
import { array, text } from "./state";

const CURRENT_STATUSES = new Set(["pending", "dispatched", "running", "starting", "blocked"]);
const TERMINAL_STATUSES = new Set(["done", "completed", "succeeded", "failed", "cancelled"]);

function dependencies(task: JsonObject): string[] {
  return array(task["deps"]).map(String);
}

export function taskWasSuperseded(task: JsonObject, parentIds: ReadonlySet<string>): boolean {
  const status = text(task["status"]);
  if (status !== "failed" && status !== "cancelled") return false;
  if (parentIds.has(text(task["id"]))) return true;
  const result = text(task["result"]).toLocaleLowerCase();
  return result.includes("superseded")
    || result.includes("quiesced before applying typed feedback")
    || result.includes("typed_feedback_replan");
}

export function projectCurrentGraph(tasks: JsonObject[]): { tasks: JsonObject[]; hiddenCount: number } {
  const byId = new Map(tasks.map((task) => [text(task["id"]), task]));
  const parentIds = new Set(tasks.map((task) => text(task["parentId"])).filter(Boolean));
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, Set<string>>();

  for (const task of tasks) {
    const id = text(task["id"]);
    const parentId = text(task["parentId"]);
    const upstream = [...new Set([...dependencies(task), ...(parentId ? [parentId] : [])])]
      .filter((candidate) => byId.has(candidate));
    predecessors.set(id, upstream);
    for (const ancestor of upstream) {
      const children = successors.get(ancestor) ?? new Set<string>();
      children.add(id);
      successors.set(ancestor, children);
    }
  }

  const stack: string[] = [];
  for (const task of tasks) {
    const id = text(task["id"]);
    if (taskWasSuperseded(task, parentIds)) continue;
    const status = text(task["status"]);
    if (CURRENT_STATUSES.has(status) || ((successors.get(id)?.size ?? 0) === 0 && TERMINAL_STATUSES.has(status))) {
      stack.push(id);
    }
  }

  const visible = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() ?? "";
    if (visible.has(id)) continue;
    visible.add(id);
    for (const ancestor of predecessors.get(id) ?? []) {
      if (!visible.has(ancestor)) stack.push(ancestor);
    }
  }

  const projectedTasks = tasks.filter((task) => visible.has(text(task["id"])));
  return { tasks: projectedTasks, hiddenCount: tasks.length - projectedTasks.length };
}

export function projectGraphView(
  tasks: JsonObject[],
  view: "current" | "history",
): { tasks: JsonObject[]; hiddenCount: number } {
  return view === "history" ? { tasks, hiddenCount: 0 } : projectCurrentGraph(tasks);
}
