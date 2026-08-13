import { useEffect, useMemo, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

import ProsperoWindowLayoutModule from "../../modules/prospero-window-layout/src/ProsperoWindowLayoutModule";
import type {
  WindowLayoutInfo,
} from "../../modules/prospero-window-layout/src/ProsperoWindowLayout.types";
import {
  verticalPaneLayout,
  windowWidthClass,
} from "@/lib/adaptive-layout-math";

export {
  primaryPaneWidth,
  verticalPaneLayout,
  windowWidthClass,
  type VerticalPaneLayout,
  type WindowWidthClass,
} from "@/lib/adaptive-layout-math";

const EMPTY_LAYOUT: WindowLayoutInfo = { foldingFeature: null };

function readCurrentLayout(): WindowLayoutInfo {
  if (Platform.OS !== "android" || !ProsperoWindowLayoutModule) {
    return EMPTY_LAYOUT;
  }
  try {
    return ProsperoWindowLayoutModule.getCurrent();
  } catch {
    return EMPTY_LAYOUT;
  }
}

export function useAdaptiveLayout() {
  const { width, height } = useWindowDimensions();
  const [layout, setLayout] = useState<WindowLayoutInfo>(readCurrentLayout);

  useEffect(() => {
    if (Platform.OS !== "android" || !ProsperoWindowLayoutModule) return;
    let active = true;
    const refresh = () => {
      if (active) setLayout(readCurrentLayout());
    };
    // The Activity window can be created a little later than the JS tree. A
    // frame-aligned read plus a delayed read covers devices whose first
    // WindowManager flow value is delayed until a configuration change.
    const frame = requestAnimationFrame(refresh);
    const delayed = setTimeout(refresh, 300);
    const subscription = ProsperoWindowLayoutModule.addListener(
      "onLayoutChange",
      setLayout,
    );
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      clearTimeout(delayed);
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (Platform.OS !== "android" || !ProsperoWindowLayoutModule) return;
    const frame = requestAnimationFrame(() => setLayout(readCurrentLayout()));
    return () => cancelAnimationFrame(frame);
  }, [height, width]);

  return useMemo(() => {
    const widthClass = windowWidthClass(width);
    return {
      width,
      height,
      widthClass,
      isMedium: widthClass !== "compact",
      isExpanded: widthClass === "expanded",
      foldingFeature: layout.foldingFeature,
      verticalPanes: verticalPaneLayout(width, layout.foldingFeature, height),
    };
  }, [height, layout.foldingFeature, width]);
}
