export interface FoldBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FoldingFeatureInfo {
  bounds: FoldBounds;
  orientation: "horizontal" | "vertical";
  state: "flat" | "half-opened";
  occlusionType: "full" | "none";
  isSeparating: boolean;
}

export interface DeviceDisplayInfo {
  /** 系统声明了铰链角度传感器。 */
  isFoldable: boolean;
  /** 当前所在显示屏(而不是窗口)的最短边,dp。 */
  displaySmallestWidth: number;
}

export interface WindowLayoutInfo {
  foldingFeature: FoldingFeatureInfo | null;
  /** 旧版原生模块没有这个字段。 */
  device?: DeviceDisplayInfo;
}

export type ProsperoWindowLayoutModuleEvents = {
  onLayoutChange: (params: WindowLayoutInfo) => void;
};
