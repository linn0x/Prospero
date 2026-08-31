import type { DesktopSnapshot, JsonObject, SessionCreateInput } from "./types";

export type SessionLaunchWorkspace = {
  path: string;
  kind: "project" | "worktree";
  label: string;
  detail: string;
};

export type SessionLaunchAccount = {
  id: string;
  name: string;
  status: string;
  isDefault: boolean;
  apiProfile: JsonObject | undefined;
};

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function recordValue(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function pathLabel(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

/** Mirrors the desktop's existing case-insensitive project matching. */
export function sessionLaunchPathKey(value: string): string {
  const normalized = value.replace(/[\\/]+$/, "");
  return (normalized || value).toLocaleLowerCase();
}

export function isLaunchableWorktreeAsset(asset: JsonObject): boolean {
  const state = stringValue(asset["state"]);
  const path = stringValue(asset["path"]);
  if (!path || state === "cleaned" || state === "missing") return false;
  const inspection = recordValue(asset["lastInspection"]);
  return inspection["pathExists"] !== false;
}

export function sessionLaunchWorkspaces(
  snapshot: DesktopSnapshot,
): SessionLaunchWorkspace[] {
  const result: SessionLaunchWorkspace[] = [];
  const seen = new Set<string>();
  for (const project of snapshot.projects) {
    const key = sessionLaunchPathKey(project);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      path: project,
      kind: "project",
      label:
        snapshot.projectAliases[key] || pathLabel(project),
      detail: project,
    });
  }
  for (const asset of snapshot.orchestration.worktreeAssets) {
    if (!isLaunchableWorktreeAsset(asset)) continue;
    const path = stringValue(asset["path"]);
    const key = sessionLaunchPathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      path,
      kind: "worktree",
      label: stringValue(asset["branch"]) || pathLabel(path),
      detail: path,
    });
  }
  return result;
}

export function isSessionLaunchWorkspace(
  snapshot: DesktopSnapshot,
  path: string,
): boolean {
  const key = sessionLaunchPathKey(path);
  return sessionLaunchWorkspaces(snapshot).some(
    (workspace) => sessionLaunchPathKey(workspace.path) === key,
  );
}

export function sessionLaunchAccounts(
  accounts: JsonObject[],
  agent: SessionCreateInput["agent"],
): SessionLaunchAccount[] {
  if (agent !== "codex" && agent !== "claude") return [];
  return accounts.flatMap((account): SessionLaunchAccount[] => {
    const id = stringValue(account["id"]);
    if (!id || stringValue(account["agent"]) !== agent) return [];
    const profile = recordValue(account["apiProfile"]);
    return [{
      id,
      name: stringValue(account["name"]) || id,
      status: stringValue(account["status"]),
      isDefault: account["isDefault"] === true,
      apiProfile: Object.keys(profile).length > 0 ? profile : undefined,
    }];
  });
}

export function defaultSessionLaunchAccountId(
  accounts: JsonObject[],
  agent: SessionCreateInput["agent"],
): string | undefined {
  const matches = sessionLaunchAccounts(accounts, agent);
  return matches.find((account) => account.isDefault)?.id ?? matches[0]?.id;
}
