import { createContext, useContext, useMemo } from "react";
import { StyleSheet, Text, type TextProps } from "react-native";
import { scaleConversationTextStyle } from "@/lib/conversation-font-size";

export const ConversationFontScale = createContext(1);
export const useConversationFontScale = () => useContext(ConversationFontScale);

/** A local reading preference, composed with the system's native accessibility font scale. */
export function ConversationText({ style, ...props }: TextProps) {
  const scale = useConversationFontScale();
  const scaledStyle = useMemo(() => scaleConversationTextStyle(StyleSheet.flatten(style) ?? {}, scale), [scale, style]);
  return <Text {...props} style={scaledStyle} />;
}
