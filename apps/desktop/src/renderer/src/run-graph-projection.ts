import type { JsonObject } from "../../shared/types";
import { array, text } from "./state";

export function groupParallelTasks(tasks: JsonObject[], expanded: ReadonlySet<string>) {
  const ids = new Set(tasks.map(task => text(task.id)));
  const successors = new Map<string, string[]>();
  for (const task of tasks) for (const dep of dependencies(task)) successors.set(dep, [...(successors.get(dep) ?? []), text(task.id)]);
  const buckets = new Map<string, JsonObject[]>();
  for (const task of tasks) {
    const deps = [...new Set(dependencies(task).filter(id => ids.has(id)))].sort();
    if (!deps.length) continue;
    const key = JSON.stringify([deps, [...(successors.get(text(task.id)) ?? [])].sort()]);
    buckets.set(key, [...(buckets.get(key) ?? []), task]);
  }
  const groups = new Map<string, JsonObject[]>();
  const replacements = new Map<string, string>();
  for (const members of buckets.values()) {
    if (members.length < 3) continue;
    const id = `parallel:${members.map(task => text(task.id)).sort().join(':')}`;
    if (expanded.has(id)) continue;
    groups.set(id, members);
    for (const member of members) replacements.set(text(member.id), id);
  }
  const emitted = new Set<string>();
  const projected: JsonObject[] = [];
  for (const task of tasks) {
    const id = replacements.get(text(task.id)) ?? text(task.id);
    if (emitted.has(id)) continue;
    emitted.add(id);
    const members = groups.get(id);
    const statuses = members?.map(member => text(member.status)) ?? [];
    const status = ['running', 'dispatched', 'starting', 'failed', 'blocked', 'pending', 'cancelled'].find(value => statuses.includes(value)) ?? 'done';
    projected.push({ ...task, id, deps: [...new Set(dependencies(task).map(dep => replacements.get(dep) ?? dep))], ...(members ? { parentId: null, status } : {}) });
  }
  return { tasks: projected, groups };
}

export function graphNeighborhood(tasks: JsonObject[], focusId: string | undefined, depth = 2): JsonObject[] {
  if (!focusId || !tasks.some(task => text(task.id) === focusId)) return tasks;
  const upstream = new Map<string, string[]>();
  const downstream = new Map<string, string[]>();
  for (const task of tasks) {
    const id = text(task.id);
    upstream.set(id, dependencies(task));
    for (const dep of dependencies(task)) downstream.set(dep, [...(downstream.get(dep) ?? []), id]);
  }
  const visible = new Set([focusId]);
  for (const adjacency of [upstream, downstream]) {
    let frontier = [focusId];
    const visited = new Set(frontier);
    for (let level = 0; level < depth; level++) {
      const next: string[] = [];
      for (const id of frontier) for (const neighbor of adjacency.get(id) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor); visible.add(neighbor); next.push(neighbor);
      }
      frontier = next;
    }
  }
  return tasks.filter(task => visible.has(text(task.id)));
}

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
