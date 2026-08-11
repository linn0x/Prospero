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

export interface WindowLayoutInfo {
  foldingFeature: FoldingFeatureInfo | null;
}

export type ProsperoWindowLayoutModuleEvents = {
  onLayoutChange: (params: WindowLayoutInfo) => void;
};
