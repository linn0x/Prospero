import type { DesktopSnapshot, JsonObject, SessionInfo } from "../../../shared/types";

export type AttentionKind = "approvals" | "questions" | "issues";
export type AttentionFilter = "all" | AttentionKind;
const string = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const ended = new Set(["done", "completed", "failed", "died", "exited", "cancelled"]);
const newest = (field: string) => (a: JsonObject, b: JsonObject) => (Number(b[field]) || 0) - (Number(a[field]) || 0);

export function pendingRequests(session: SessionInfo, kind: "approvals" | "questions"): number {
  const value = kind === "approvals" ? session.pendingPermissions : session.pendingQuestions;
  const count = typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const waiting = kind === "approvals" ? ["waiting_approval", "waiting_permission"].includes(session.status) : session.status === "waiting_input";
  return Math.max(count, waiting ? 1 : 0);
}

export function attentionSummary(snapshot: DesktopSnapshot) {
  const runs = new Map(snapshot.orchestration.runs.map(run => [string(run.id), run]));
  const taskById = new Map(snapshot.orchestration.tasks.map(task => [string(task.id), task]));
  const worktrees = new Map(snapshot.orchestration.worktreeAssets.map(asset => [string(asset.taskId), asset]));
  const activeRun = (item: JsonObject) => string(runs.get(string(item.runId))?.status) === "active";
  const gates = snapshot.orchestration.gates.filter(gate => activeRun(gate) && gate.status === "pending").sort(newest("createdAt"));
  const tasks = snapshot.orchestration.tasks.filter(task => activeRun(task) && ["failed", "blocked"].includes(string(task.status))).sort(newest("updatedAt"));
  const live = snapshot.daemon.sessions.filter(session => !ended.has(session.status));
  const approvalSessions = live.filter(session => pendingRequests(session, "approvals") > 0);
  const questionSessions = live.filter(session => pendingRequests(session, "questions") > 0);
  const counts = {
    approvals: gates.length + approvalSessions.reduce((sum, s) => sum + pendingRequests(s, "approvals"), 0),
    questions: questionSessions.reduce((sum, s) => sum + pendingRequests(s, "questions"), 0),
    issues: tasks.length,
  };
  const offline = !snapshot.daemon.running;
  const context = (item: JsonObject) => {
    const task = taskById.get(string(item.taskId) || string(item.id));
    const run = runs.get(string(item.runId));
    const automation = run?.automation && typeof run.automation === "object" ? run.automation as JsonObject : undefined;
    const workspace = string(worktrees.get(string(task?.id))?.repo) || string(task?.cwd) || string(run?.cwd) || string(automation?.cwd);
    const project = snapshot.projectAliases[workspace.toLowerCase()] || workspace.split(/[\\/]/).filter(Boolean).at(-1) || "";
    return { title: string(task?.title) || string(run?.objective), project };
  };
  return { gates, tasks, approvalSessions, questionSessions, counts, offline, total: counts.approvals + counts.questions + counts.issues + Number(offline), context };
}
