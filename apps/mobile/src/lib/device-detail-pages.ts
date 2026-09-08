export type AddDeviceSide = "before" | "after";

export type DeviceDetailPage =
  | { kind: "device"; hostIndex: number }
  | { kind: "add"; side: AddDeviceSide };

/** Keep the title/close row (44), rail (42), and their gaps (18) outside the scrollable card. */
export function deviceDetailLayout(width: number, height: number) {
  const topInset = height >= 600 ? 80 : 12;
  const availableHeight = height - topInset - 12;
  const stageHeight = Math.min(644, Math.max(104, availableHeight));
  return {
    cardWidth: Math.min(720, Math.max(0, width - 32)),
    cardHeight: Math.max(0, stageHeight - 104),
    stageHeight,
    stageTop: topInset,
  };
}

/** The home card keeps its original coordinate system; the two add pages sit outside it. */
export function deviceDetailPosition(offset: number, stride: number, hostCount: number): number {
  if (!Number.isFinite(offset) || !Number.isFinite(stride) || stride <= 0) return 0;
  return Math.max(-1, Math.min(hostCount, offset / stride - 1));
}

export function deviceDetailPage(index: number, hostCount: number): DeviceDetailPage {
  if (index <= 0) return { kind: "add", side: "before" };
  if (index >= hostCount + 1) return { kind: "add", side: "after" };
  return { kind: "device", hostIndex: index - 1 };
}

export function deviceDetailPageIndex(
  hostIndex: number,
  hostCount: number,
  addSide: AddDeviceSide | null | undefined,
): number {
  if (addSide === "before") return 0;
  if (addSide === "after") return hostCount + 1;
  return Math.min(Math.max(0, hostIndex), Math.max(0, hostCount - 1)) + 1;
}

/** Ignore stale momentum-end events while a rail tap is still scrolling to another page. */
export function settledDeviceDetailPage(
  offset: number,
  stride: number,
  hostCount: number,
  pendingPage: number | null,
): number | null {
  const pagePosition = deviceDetailPosition(offset, stride, hostCount) + 1;
  if (pendingPage !== null && Math.abs(pagePosition - pendingPage) > 0.025) return null;
  return Math.round(pagePosition);
}
