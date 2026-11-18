import { View } from "react-native";
import Svg, { Path } from "react-native-svg";

export function WorkspaceFolderIcon({ expanded, size, color }: {
  expanded: boolean; size: number; color: string;
}) {
  // Swap the geometry of one opaque path. No crossfade, font loading or animated
  // completion callback can briefly hide it or restore a stale folder state.
  return <View testID="workspace-folder" pointerEvents="none" accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path fill={color} d={expanded
        ? "M3 5h6l2 2h9v3H7L3 20V5Zm4.8 6H23l-4.2 9H3.8l4-9Z"
        : "M3 5h6l2 2h10v13H3V5Z"} />
    </Svg>
  </View>;
}
