import type { DesktopSnapshot, DesktopSnapshotPatch } from "./types";

const SNAPSHOT_KEYS = [
  "daemon",
  "projects",
  "projectAliases",
  "pinnedProjectPaths",
  "pinnedSessionIds",
  "unreadSessionIds",
  "workflowTemplates",
  "devices",
  "accounts",
  "orchestration",
  "logs",
  "settings",
] as const satisfies readonly (keyof DesktopSnapshot)[];
type MissingSnapshotKey = Exclude<keyof DesktopSnapshot, (typeof SNAPSHOT_KEYS)[number]>;
const SNAPSHOT_KEYS_ARE_EXHAUSTIVE: MissingSnapshotKey extends never ? true : never = true;
void SNAPSHOT_KEYS_ARE_EXHAUSTIVE;

/** Creates an identity-based patch. StateStore keeps unchanged slices stable. */
export function diffDesktopSnapshot(previous: DesktopSnapshot | undefined, next: DesktopSnapshot): DesktopSnapshotPatch {
  if (!previous) return next;
  const patch: DesktopSnapshotPatch = {};
  for (const key of SNAPSHOT_KEYS) {
    if (previous[key] !== next[key]) Object.assign(patch, { [key]: next[key] });
  }
  return patch;
}

export function applyDesktopSnapshotPatch(snapshot: DesktopSnapshot, patch: DesktopSnapshotPatch): DesktopSnapshot {
  return Object.keys(patch).length === 0 ? snapshot : { ...snapshot, ...patch };
}

export function isEmptyDesktopSnapshotPatch(patch: DesktopSnapshotPatch): boolean {
  return Object.keys(patch).length === 0;
}
