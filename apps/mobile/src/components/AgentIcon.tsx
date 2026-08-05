import { StyleSheet, View } from "react-native";
import type { AgentKind } from "@prospero/protocol";
import { Icon, type IconName } from "@/components/Icon";
import { color, radius } from "@/lib/theme";

/**
 * agent 的图标与识别色。
 *
 * 用的是 SF Symbols 而不是各家的品牌 logo:一来手里没有那些矢量文件,二来
 * 混进一堆来路不同的位图会把这套界面的质感拉掉 —— 系统符号和 App 里其余图标
 * 共用同一套字形与光学重心,这是"看起来像原生"最省力的一步。
 *
 * 所以符号取的是各家的【气质】而非商标:claude 是那个星芒,codex 是代码尖括号,
 * opencode 是花括号,grok 是闪电。颜色才是真正的身份 —— 扫一眼认色,不必读字。
 */
const AGENTS: Record<AgentKind, { symbol: IconName; tint: string }> = {
  claude: { symbol: "asterisk", tint: "#D98A5E" },
  codex: { symbol: "chevron.left.forwardslash.chevron.right", tint: "#7AA2F7" },
  opencode: { symbol: "curlybraces", tint: "#5BC98C" },
  grok: { symbol: "bolt.fill", tint: "#B48EAD" },
  trae: { symbol: "wand.and.stars", tint: "#E5A341" },
  shell: { symbol: "terminal.fill", tint: "#9B9BA6" },
  custom: { symbol: "command", tint: "#9B9BA6" },
};

export function agentTint(agent: AgentKind): string {
  return AGENTS[agent].tint;
}

/**
 * `badge` 给图标加一块同色的浅底 —— 在选项这种需要点的地方,色块能撑出
 * 可点面积;在列表行里就不必了,那儿只是标识,不是按钮。
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
  const { symbol, tint } = AGENTS[agent];
  const glyph = <Icon name={symbol} size={size} color={tint} weight="semibold" />;
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
    // 底色是 agent 色的 13% 透明版;深色界面上再压一层卡片色,免得发灰
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
});
