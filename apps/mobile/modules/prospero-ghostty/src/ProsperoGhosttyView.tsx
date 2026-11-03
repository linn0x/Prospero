import { requireNativeViewManager } from "expo-modules-core";
import type { ComponentType, RefAttributes } from "react";
import type { View } from "react-native";

import type { ProsperoGhosttyViewProps } from "./ProsperoGhostty.types";

type NativeGhosttyView = ComponentType<ProsperoGhosttyViewProps & RefAttributes<View>>;

let ProsperoGhosttyView: NativeGhosttyView | null = null;

try {
  ProsperoGhosttyView = requireNativeViewManager<ProsperoGhosttyViewProps>("ProsperoGhostty") as NativeGhosttyView;
} catch {
  ProsperoGhosttyView = null;
}

export default ProsperoGhosttyView;
