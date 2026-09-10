import { normalizeDeviceOrder, orderDevices } from "./device-order";

export type WorkspaceOrders = Record<string, string[]>;

export function normalizeWorkspaceOrders(value: unknown): WorkspaceOrders {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([hostId, paths]) => [hostId, normalizeDeviceOrder(paths)]));
}

export function orderWorkspaces<T extends { path: string }>(projects: readonly T[], paths: readonly string[]): T[] {
  return orderDevices(projects.map((project) => ({ id: project.path, project })), paths).map((item) => item.project);
}

/** Keep each host's slots in the combined feed, and apply its saved directory order within them. */
export function orderEdgeWorkspaces<T extends { host: { id: string }; project: { path: string } }>(
  projects: readonly T[], orders: WorkspaceOrders,
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of projects) {
    const group = groups.get(item.host.id) ?? [];
    group.push(item);
    groups.set(item.host.id, group);
  }
  for (const [hostId, group] of groups) {
    groups.set(hostId, orderDevices(group.map((item) => ({ id: item.project.path, item })), orders[hostId] ?? []).map(({ item }) => item));
  }
  return projects.map((item) => groups.get(item.host.id)!.shift()!);
}
