export type AddDeviceSide = "before" | "after";

export interface HomeDevicePreview {
  detailsOpen: boolean;
  detailHostId: string | null;
  addDeviceSide: AddDeviceSide | null;
  quickSwitchActive: boolean;
  previewHostId: string | null;
}

/** Only the detail carousel owns the two add pages; the quick switcher has real hosts only. */
export function showsAddDevicePreview(state: Pick<HomeDevicePreview, "detailsOpen" | "quickSwitchActive">): boolean {
  return state.detailsOpen && !state.quickSwitchActive;
}

export function homeDevicePreviewIndex(hosts: readonly { id: string }[], selectedHostId: string | undefined, state: HomeDevicePreview): number {
  if (showsAddDevicePreview(state) && state.addDeviceSide) {
    return state.addDeviceSide === "before" ? -1 : hosts.length;
  }
  const hostId = state.quickSwitchActive && state.previewHostId ? state.previewHostId
    : state.detailsOpen && state.detailHostId ? state.detailHostId : selectedHostId;
  return Math.max(0, hosts.findIndex((host) => host.id === hostId));
}

export function clampDetailPreviewPosition(position: number, hostCount: number): number {
  return Number.isFinite(position) ? Math.min(Math.max(0, hostCount), Math.max(-1, position)) : 0;
}
