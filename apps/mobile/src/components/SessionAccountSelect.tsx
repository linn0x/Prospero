import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { getAgentAccountEngine, type AgentAccount } from "@prospero/protocol";
import { Icon } from "./Icon";
import { Sheet } from "./Sheet";
import { useMobileTheme } from "@/lib/theme";

const ACCOUNT_STATUS_LABELS: Record<AgentAccount["status"], string> = {
  signed_in: "已登录",
  signed_out: "未登录",
  unavailable: "CLI 未安装",
  error: "状态异常",
};

export function SessionAccountSelect({
  accounts,
  selected,
  loading,
  error,
  supported,
  disabled,
  label = "订阅账号",
  emptyHint,
  onSelect,
  onRetry,
  onManage,
}: {
  accounts: AgentAccount[];
  selected?: AgentAccount;
  loading: boolean;
  error: string | null;
  supported: boolean;
  disabled: boolean;
  label?: string;
  emptyHint?: string;
  onSelect(account: AgentAccount): void;
  onRetry(): void;
  onManage?: () => void;
}) {
  const { palette } = useMobileTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return accounts.filter((account) =>
      [
        account.name,
        getAgentAccountEngine(account),
        account.apiProfile?.model,
        account.apiProfile ? "API 旧版" : "订阅 账号 本机",
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(search),
    );
  }, [accounts, query]);

  const detail = (account: AgentAccount) => {
    const engine = getAgentAccountEngine(account);
    if (account.apiProfile) {
      return `${engine} · API · ${account.apiProfile.model}`;
    }
    const envLabel = account.managed ? "独立订阅登录态" : "本机订阅环境";
    return `${engine} · ${envLabel} · ${ACCOUNT_STATUS_LABELS[account.status]}`;
  };

  return (
    <View style={styles.section}>
      <View style={styles.labelRow}>
        <Text style={{ color: palette.textDim, fontSize: 12.5, fontWeight: "600" }}>{label}</Text>
        {onManage && (
          <Pressable
            onPress={onManage}
            disabled={disabled || !supported}
            accessibilityRole="button"
            accessibilityLabel="管理电脑上的账号和 API"
            hitSlop={8}
          >
            <Text style={{ color: palette.accent, fontSize: 12.5, fontWeight: "600" }}>管理</Text>
          </Pressable>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="选择账号或 API"
        accessibilityState={{ disabled: disabled || !supported, expanded: open }}
        disabled={disabled || !supported}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
        style={[
          styles.selector,
          { backgroundColor: palette.surfaceRaised, borderColor: palette.border },
          (disabled || !supported) && { opacity: 0.55 },
        ]}
      >
        <View style={styles.copy}>
          <View style={styles.nameLine}>
            <Text numberOfLines={1} style={{ color: palette.text, fontWeight: "600", flexShrink: 1 }}>
              {selected?.name ?? (loading ? "正在读取订阅账号…" : emptyHint ?? "选择电脑上的订阅账号")}
            </Text>
            {selected?.isDefault && (
              <Text style={[styles.defaultPill, { color: palette.accent, backgroundColor: palette.accentBg }]}>
                默认
              </Text>
            )}
          </View>
          <Text numberOfLines={2} style={{ color: palette.textDim, fontSize: 12 }}>
            {selected
              ? detail(selected)
              : accounts.length > 0
                ? `共 ${accounts.length} 个可选环境，点按切换或搜索`
                : "可在「账号与模型源」中添加官方订阅登录态，或切换到上方 API 模型源"}
          </Text>
        </View>
        {loading ? (
          <ActivityIndicator color={palette.accent} />
        ) : (
          <Icon name="chevron.down" size={15} color={palette.textDim} />
        )}
      </Pressable>
      {!supported && (
        <Text accessibilityRole="alert" style={{ color: palette.warn, fontSize: 12 }}>
          连接支持账号管理的电脑后可选择订阅账号和 API 模型源。
        </Text>
      )}
      {error && (
        <View style={styles.labelRow}>
          <Text accessibilityRole="alert" style={[styles.copy, { color: palette.warn, fontSize: 12 }]}>
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="重新读取电脑账号"
            disabled={disabled || loading}
            onPress={onRetry}
            style={styles.retry}
          >
            <Text style={{ color: palette.accent, fontWeight: "600" }}>重试</Text>
          </Pressable>
        </View>
      )}
      <Sheet visible={open} title="选择订阅账号" onClose={() => setOpen(false)}>
        <TextInput
          accessibilityLabel="搜索电脑账号或 API"
          value={query}
          onChangeText={setQuery}
          placeholder="搜索订阅名称、Claude、Codex 或模型"
          placeholderTextColor={palette.textFaint}
          autoCorrect={false}
          autoCapitalize="none"
          style={[styles.search, { color: palette.text, borderColor: palette.border, backgroundColor: palette.surfaceRaised }]}
        />
        <Text style={{ color: palette.textDim, fontSize: 12, marginVertical: 10 }}>
          来自这台电脑 · {matches.length} / {accounts.length} · 选择后自动匹配对应 Agent
        </Text>
        {matches.map((account) => (
          <Pressable
            key={account.id}
            accessibilityRole="radio"
            accessibilityLabel={`${account.name}，${detail(account)}`}
            accessibilityState={{ checked: selected?.id === account.id }}
            disabled={disabled}
            onPress={() => {
              onSelect(account);
              setOpen(false);
            }}
            style={[
              styles.row,
              {
                backgroundColor: selected?.id === account.id ? palette.accentBg : palette.surfaceRaised,
                borderColor: selected?.id === account.id ? palette.accent : palette.border,
              },
            ]}
          >
            <View style={styles.copy}>
              <View style={styles.nameLine}>
                <Text style={{ color: palette.text, fontWeight: "600", flexShrink: 1 }}>
                  {account.name}
                </Text>
                {account.isDefault && (
                  <Text style={[styles.defaultPill, { color: palette.accent, backgroundColor: palette.accentBg }]}>
                    默认
                  </Text>
                )}
              </View>
              <Text style={{ color: palette.textDim, fontSize: 12 }}>{detail(account)}</Text>
              {(account.apiProfileError || account.status !== "signed_in") && (
                <Text style={{ color: palette.warn, fontSize: 12 }}>
                  {account.apiProfileError ??
                    (account.status === "signed_out" ? "尚未登录或配置密钥" : "运行环境不可用")}
                </Text>
              )}
            </View>
            {selected?.id === account.id && (
              <Icon name="checkmark.circle.fill" size={18} color={palette.accent} />
            )}
          </Pressable>
        ))}
        {!matches.length && (
          <Text style={{ color: palette.textDim, paddingVertical: 16 }}>
            {loading
              ? "正在读取…"
              : query.trim()
                ? "没有匹配的账号"
                : "暂无可用订阅账号，可切换到「API 模型源」或前往「账号与模型源」登录。"}
          </Text>
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  selector: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  copy: { flex: 1, minWidth: 0, gap: 4 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  defaultPill: {
    fontSize: 10.5,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: 999,
    overflow: "hidden",
  },
  search: { minHeight: 44, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10 },
  row: {
    minHeight: 62,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  retry: { minHeight: 36, justifyContent: "center", paddingHorizontal: 8 },
});
