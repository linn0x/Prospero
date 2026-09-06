import type { OrchestrationSnapshot, SessionInfo } from "../../shared/types";

export interface ManagedWorkspace {
  path: string;
  repo: string;
  runId: string;
  taskTitle?: string;
  cleaned?: boolean;
}
export interface ManagedWorkspaceGroup {
  key: string;
  /** Only registered, ordinary projects can become parents. */
  project?: string;
  repo: string;
  workspaces: ManagedWorkspace[];
}
export interface ManagedWorkspaceLayout {
  projects: string[];
  groups: ManagedWorkspaceGroup[];
  byPath: Map<string, { workspace: ManagedWorkspace; group: ManagedWorkspaceGroup }>;
}

function normalized(path: string): string {
  const value = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:\//i.test(value) || value.startsWith("//") ? value.toLocaleLowerCase() : value;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Exact registered asset paths only: names and directory prefixes never classify a project. */
export function groupManagedWorkspaces(
  projects: readonly string[],
  orchestration: OrchestrationSnapshot,
): ManagedWorkspaceLayout {
  const assets = new Map<string, { path: string; repo: string; runId: string; taskId?: string; cleaned?: boolean }>();
  const ambiguous = new Set<string>();
  for (const asset of orchestration.worktreeAssets ?? []) {
    const assetPath = string(asset.path), repo = string(asset.repo), runId = string(asset.runId);
    if (!assetPath || !repo || !runId) continue;
    if (asset.kind !== "run" && asset.kind !== "worker") continue;
    const key = normalized(assetPath), previous = assets.get(key);
    if (previous && (normalized(previous.repo) !== normalized(repo) || previous.runId !== runId)) {
      ambiguous.add(key);
      continue;
    }
    const taskId = string(asset.taskId);
    assets.set(key, { path: assetPath, repo, runId, ...(taskId ? { taskId } : {}),
      ...(asset.state === "cleaned" || asset.cleanup ? { cleaned: true } : {}) });
  }
  for (const key of ambiguous) assets.delete(key);
  const ordinary = projects.filter(project => !assets.has(normalized(project)));
  const ordinaryByPath = new Map(ordinary.map(project => [normalized(project), project]));
  const runs = new Map(orchestration.runs.map(run => [string(run.id), run]));
  const tasks = new Map(orchestration.tasks.map(task => [`${String(task.runId)}\0${String(task.id)}`, task]));
  const groups = new Map<string, ManagedWorkspaceGroup>();
  const byPath: ManagedWorkspaceLayout["byPath"] = new Map();
  for (const projectPath of projects) {
    const asset = assets.get(normalized(projectPath));
    if (!asset) continue;
    let repo = asset.repo;
    const seen = new Set([normalized(projectPath)]);
    while (assets.has(normalized(repo)) && !seen.has(normalized(repo))) {
      seen.add(normalized(repo));
      repo = assets.get(normalized(repo))!.repo;
    }
    // Older assets recorded repo=path. Run automation retains the original cwd.
    if (seen.has(normalized(repo))) {
      const automation = runs.get(asset.runId)?.automation;
      const cwd = automation && typeof automation === "object" ? string((automation as Record<string, unknown>).cwd) : undefined;
      if (cwd && !assets.has(normalized(cwd))) repo = cwd;
    }
    let parent = ordinaryByPath.get(normalized(repo));
    if (!parent) {
      const automation = runs.get(asset.runId)?.automation;
      const cwd = automation && typeof automation === "object" ? string((automation as Record<string, unknown>).cwd) : undefined;
      if (cwd && (normalized(cwd) === normalized(repo) || normalized(cwd).startsWith(`${normalized(repo)}/`))) {
        parent = ordinaryByPath.get(normalized(cwd));
      }
    }
    const key = `tasks:${normalized(parent ?? repo)}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, repo, ...(parent ? { project: parent } : {}), workspaces: [] };
      groups.set(key, group);
    }
    const title = asset.taskId ? tasks.get(`${asset.runId}\0${asset.taskId}`)?.title : undefined;
    // A task title may contain a whole prompt. Bound work before splitting codepoints.
    const taskTitle = typeof title === "string" ? [...title.slice(0, 240)].slice(0, 120).join("") : undefined;
    const workspace: ManagedWorkspace = { path: projectPath, repo, runId: asset.runId,
      ...(taskTitle?.trim() ? { taskTitle } : {}), ...(asset.cleaned ? { cleaned: true } : {}) };
    group.workspaces.push(workspace);
    byPath.set(projectPath, { workspace, group });
  }
  return { projects: ordinary, groups: [...groups.values()], byPath };
}

/** Count visible session activity once, independently of collapsed presentation. */
export function managedWorkspaceActivity(sessions: readonly SessionInfo[]): { running: number; pending: number } {
  let running = 0, pending = 0;
  for (const session of sessions) {
    if (["starting", "running"].includes(session.status)) running++;
    const interactions = (session.pendingPermissions ?? 0) + (session.pendingQuestions ?? 0);
    pending += interactions || (["waiting_approval", "waiting_input"].includes(session.status) ? 1 : 0);
  }
  return { running, pending };
}

/** Keep a child with an important session inside the parent project's preview budget. */
export function managedWorkspaceParent(layout: ManagedWorkspaceLayout, project: string): string | undefined {
  return layout.byPath.get(project)?.group.project ?? (layout.byPath.has(project) ? undefined : project);
}
