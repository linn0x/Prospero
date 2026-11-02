import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { getAgentAccountEngine, type AgentAccount } from "@prospero/protocol";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { useMobileTheme } from "@/lib/theme";

export function SessionAccountSelect({ accounts, selected, loading, error, supported, disabled, onSelect, onRetry, onManage }: {
  accounts: AgentAccount[];
  selected?: AgentAccount;
  loading: boolean;
  error: string | null;
  supported: boolean;
  disabled: boolean;
  onSelect(account: AgentAccount): void;
  onRetry(): void;
  onManage(): void;
}) {
  const { palette } = useMobileTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return accounts.filter(account => [account.name, getAgentAccountEngine(account), account.apiProfile?.model, account.apiProfile ? "API" : "账号 本机"].join(" ").toLocaleLowerCase().includes(search));
  }, [accounts, query]);
  const detail = (account: AgentAccount) => `${getAgentAccountEngine(account)} · ${account.apiProfile ? `API · ${account.apiProfile.model}` : account.managed ? "独立账号" : "本机账号"}`;
  return <View style={styles.section}>
    <View style={styles.labelRow}>
      <Text style={{ color: palette.text, fontSize: 13, fontWeight: "600" }}>账号 / API</Text>
      <Pressable onPress={onManage} disabled={disabled || !supported} accessibilityRole="button" accessibilityLabel="管理电脑上的账号和 API" hitSlop={8}>
        <Text style={{ color: palette.accent }}>管理</Text>
      </Pressable>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel="选择账号或 API" accessibilityState={{ disabled: disabled || !supported, expanded: open }} disabled={disabled || !supported}
      onPress={() => { setQuery(""); setOpen(true); }} style={[styles.selector, { backgroundColor: palette.surfaceRaised }]}>
      <View style={styles.copy}>
        <Text numberOfLines={2} style={{ color: palette.text, fontWeight: "600" }}>{selected?.name ?? (loading ? "正在读取电脑账号…" : "选择电脑上的账号或 API")}</Text>
        <Text numberOfLines={2} style={{ color: palette.textDim, fontSize: 12 }}>{selected ? detail(selected) : `共 ${accounts.length} 个账号与 API，可按名称或模型搜索`}</Text>
      </View>
      {loading ? <ActivityIndicator color={palette.accent} /> : <Icon name="chevron.down" size={16} color={palette.accent} />}
    </Pressable>
    {!supported && <Text accessibilityRole="alert" style={{ color: palette.warn }}>连接支持账号管理的电脑后可选择账号和 API。</Text>}
    {error && <View style={styles.labelRow}>
      <Text accessibilityRole="alert" style={[styles.copy, { color: palette.warn }]}>{error}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="重新读取电脑账号" disabled={disabled || loading} onPress={onRetry} style={styles.retry}><Text style={{ color: palette.accent }}>重试</Text></Pressable>
    </View>}
    <Sheet visible={open} title="选择账号 / API" onClose={() => setOpen(false)}>
      <TextInput accessibilityLabel="搜索电脑账号或 API" value={query} onChangeText={setQuery} placeholder="搜索名称、模型、Claude 或 Codex" placeholderTextColor={palette.textFaint} autoCorrect={false} autoCapitalize="none"
        style={[styles.search, { color: palette.text, borderColor: palette.border }]} />
      <Text style={{ color: palette.textDim, marginVertical: 10 }}>来自这台电脑 · {matches.length} / {accounts.length} · 选择后自动匹配 Agent</Text>
      {matches.map(account => <Pressable key={account.id} accessibilityRole="radio" accessibilityLabel={`${account.name}，${detail(account)}`} accessibilityState={{ checked: selected?.id === account.id }} disabled={disabled}
        onPress={() => { onSelect(account); setOpen(false); }} style={[styles.row, { backgroundColor: selected?.id === account.id ? palette.accentBg : palette.surfaceRaised }]}>
        <View style={styles.copy}>
          <Text style={{ color: palette.text, fontWeight: "600" }}>{account.name}</Text>
          <Text style={{ color: palette.textDim, fontSize: 12 }}>{detail(account)}</Text>
          {(account.apiProfileError || account.status !== "signed_in") && <Text style={{ color: palette.warn, fontSize: 12 }}>{account.apiProfileError ?? (account.status === "signed_out" ? "尚未登录或配置密钥" : "运行环境不可用")}</Text>}
        </View>
        {selected?.id === account.id && <Icon name="checkmark.circle.fill" size={18} color={palette.accent} />}
      </Pressable>)}
      {!matches.length && <Text style={{ color: palette.textDim, paddingVertical: 16 }}>{loading ? "正在读取…" : query.trim() ? "没有匹配的账号或 API" : "暂无账号，请关闭后重试或前往管理"}</Text>}
    </Sheet>
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 8, marginTop: 12 },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  selector: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 12 },
  copy: { flex: 1, minWidth: 0, gap: 5 },
  search: { minHeight: 48, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10 },
  row: { minHeight: 64, padding: 12, borderRadius: 10, marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 12 },
  retry: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
});
