import { Platform } from "react-native";

/** Menlo 不随 Android 分发；monospace 会映射到设备自带的等宽字体。 */
export const MONOSPACE_FONT = Platform.OS === "ios" ? "Menlo" : "monospace";
