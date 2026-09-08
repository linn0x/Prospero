import type { HostRuntime } from "./store";

/** Use two columns on phones, with room for larger accessibility text and narrow panes. */
export function edgeDeviceColumns(availableWidth: number, fontScale = 1): number {
  return Math.max(1, Math.min(4, Math.floor(availableWidth / (144 * Math.max(1, fontScale)))));
}

export function edgeDeviceConnectionLabel(runtime: HostRuntime | undefined): string {
  if (runtime?.status === "connected") return runtime.rttMs == null ? "在线" : `${runtime.rttMs}ms`;
  if (runtime?.status === "connecting") return "连接中";
  if (runtime?.status === "reconnecting") return "重连中";
  if (runtime?.status === "failed") return "连接失败";
  return "离线";
}

/** Preserve address-book order and never reintroduce a removed device when toggling. */
export function toggleEdgeHost(hosts: readonly { id: string }[], selectedIds: ReadonlySet<string>, hostId: string): string[] {
  return hosts.filter((host) => host.id === hostId ? !selectedIds.has(host.id) : selectedIds.has(host.id)).map((host) => host.id);
}
