import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, useWindowDimensions } from "react-native";

import ProsperoWindowLayoutModule from "../../modules/prospero-window-layout/src/ProsperoWindowLayoutModule";
import type {
  WindowLayoutInfo,
} from "../../modules/prospero-window-layout/src/ProsperoWindowLayout.types";
import {
  devicePosture,
  splitPaneBounds,
  splitPaneLayout,
  verticalPaneLayout,
  windowWidthClass,
} from "@/lib/adaptive-layout-math";
import { useSplitPanePreferences } from "@/lib/split-pane-preferences";

export {
  devicePosture,
  primaryPaneWidth,
  splitPaneBounds,
  splitPaneLayout,
  type DevicePosture,
  type FoldPosture,
  type SplitPaneOptions,
  type WindowOrientation,
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

/**
 * Android:让当前 Activity 按传感器转屏，即使系统锁定了自动旋转;false 交还给系统。
 * 其它平台和没有原生模块的构建上是空操作。
 */
export function setSensorRotation(enabled: boolean): void {
  if (Platform.OS !== "android") return;
  try {
    ProsperoWindowLayoutModule?.setSensorRotation?.(enabled);
  } catch {
    // 旧版原生模块没有这个函数;保持系统默认即可。
  }
}

export function useAdaptiveLayout() {
  const { width, height } = useWindowDimensions();
  const [layout, setLayout] = useState<WindowLayoutInfo>(readCurrentLayout);
  const customRatio = useSplitPanePreferences((state) => state.customRatio);
  const hydrateSplit = useSplitPanePreferences((state) => state.hydrate);
  const setCustomRatio = useSplitPanePreferences((state) => state.setCustomRatio);
  const commitCustomRatio = useSplitPanePreferences((state) => state.commitCustomRatio);
  const resetCustomRatio = useSplitPanePreferences((state) => state.resetCustomRatio);

  useEffect(() => {
    void hydrateSplit();
  }, [hydrateSplit]);

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

  const setSplitStart = useCallback(
    (nextStart: number) => {
      if (!Number.isFinite(width) || width <= 0) return;
      setCustomRatio(nextStart / width);
    },
    [setCustomRatio, width],
  );

  const commitSplitStart = useCallback(
    (nextStart: number) => {
      if (!Number.isFinite(width) || width <= 0) return;
      commitCustomRatio(nextStart / width);
    },
    [commitCustomRatio, width],
  );

  return useMemo(() => {
    const widthClass = windowWidthClass(width);
    const splitPanes = splitPaneLayout(
      width,
      height,
      layout.foldingFeature,
      customRatio !== null ? { customRatio } : undefined,
    );
    const splitBounds = splitPaneBounds(width, splitPanes?.gap ?? 1);
    return {
      width,
      height,
      widthClass,
      isMedium: widthClass !== "compact",
      isExpanded: widthClass === "expanded",
      foldingFeature: layout.foldingFeature,
      verticalPanes: verticalPaneLayout(width, layout.foldingFeature, height),
      splitPanes,
      splitBounds,
      splitResizable: Boolean(splitPanes && layout.foldingFeature?.occlusionType !== "full"),
      setSplitStart,
      commitSplitStart,
      resetSplitStart: resetCustomRatio,
      // 窗口尺寸和 WindowManager 事件到达顺序不定，两者任一变化都重新判定。
      posture: devicePosture(width, height, layout.foldingFeature, layout.device),
    };
  }, [
    commitSplitStart,
    customRatio,
    height,
    layout.device,
    layout.foldingFeature,
    resetCustomRatio,
    setSplitStart,
    width,
  ]);
}
