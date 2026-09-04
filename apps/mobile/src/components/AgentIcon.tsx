import { Appearance, StyleSheet, useColorScheme, View, type ColorSchemeName } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { AgentKind } from "@prospero/protocol";
import { agentLogoPath } from "@/components/agent-logos";
import { Icon, type IconName } from "@/components/Icon";
import { color, radius } from "@/lib/theme";

/**
 * agent 的标识与识别色。
 *
 * 有官方标的用官方标(claude / codex / deepseek / opencode / grok / trae),没有的用系统符号
 * —— shell 和 custom 不是产品,是"随便跑个命令",给它们编一个标反而是在暗示
 * 那儿有个不存在的东西。
 *
 * 颜色取各家品牌色,但压过一道:原色是给白底做主视觉用的,直接摆到深色界面上
 * 会亮得跳出来,六个并排更是一片吵。识别靠色相,不靠饱和度。
 */
const AGENTS: Record<AgentKind, { dark: string; light: string; symbol?: IconName }> = {
  claude: { dark: "#D97757", light: "#A94F31" },
  codex: { dark: "#8AB4F8", light: "#315EA8" },
  deepseek: { dark: "#829BFF", light: "#3D57C8" },
  opencode: { dark: "#5BC98C", light: "#1E7049" },
  grok: { dark: "#C9C9D4", light: "#404957" },
  trae: { dark: "#3ED592", light: "#147A50" },
  shell: { dark: "#C1C7D0", light: "#404957", symbol: "terminal.fill" },
  custom: { dark: "#C1C7D0", light: "#404957", symbol: "command" },
};

export function agentTint(
  agent: AgentKind,
  scheme: ColorSchemeName | null | undefined = Appearance.getColorScheme(),
): string {
  return scheme === "light" ? AGENTS[agent].light : AGENTS[agent].dark;
}

/**
 * `badge` 给标识加一块同色浅底 —— 在需要点的地方,色块能撑出可点面积;
 * 列表行里就不必了,那儿只是标识,不是按钮。
 */
export function AgentIcon({
  agent,
  size = 15,
  badge = false,
}: {
  agent: AgentKind;
  size?: number;
  badge?: boolean;
}) {
  const scheme = useColorScheme();
  const { symbol } = AGENTS[agent];
  const tint = agentTint(agent, scheme);
  const path = agentLogoPath[agent];
  const glyph =
    path !== undefined ? (
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path d={path} fill={tint} fillRule="evenodd" clipRule="evenodd" />
      </Svg>
    ) : (
      <Icon name={symbol ?? "terminal.fill"} size={size} color={tint} weight="semibold" />
    );
  if (!badge) return glyph;
  return (
    <View
      style={[
        styles.badge,
        { width: size * 1.8, height: size * 1.8, backgroundColor: `${tint}22` },
      ]}
    >
      {glyph}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
});
