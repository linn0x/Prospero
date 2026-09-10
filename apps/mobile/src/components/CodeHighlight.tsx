import { memo, useMemo } from "react";
import { Text } from "react-native";
import { highlightCode, RAINBOW_COLORS, SYNTAX_COLORS } from "@/lib/code-highlight";
import { useMobileTheme } from "@/lib/theme";

/** Inherit font size and selection from the parent Text (including conversation typography). */
export const CodeHighlight = memo(function CodeHighlight({ code, language, rainbow = true }: {
  code: string; language?: string | null; rainbow?: boolean;
}) {
  const { scheme } = useMobileTheme();
  const highlighted = useMemo(() => highlightCode(code, language, rainbow), [code, language, rainbow]);
  return <>{highlighted.tokens.map((token, index) => <Text key={index} style={{
    color: token.rainbow === undefined ? SYNTAX_COLORS[scheme][token.kind] : RAINBOW_COLORS[scheme][token.rainbow],
  }}>{token.text}</Text>)}</>;
});
