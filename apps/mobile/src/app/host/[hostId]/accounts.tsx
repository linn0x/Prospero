import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import type { AgentAccount, AgentCredentialKind, CodeAgentKind } from "@prospero/protocol";
import { AgentIcon } from "@/components/AgentIcon";
import { Icon } from "@/components/Icon";
import { PromptDialog } from "@/components/PromptDialog";
import { useHostConnection } from "@/lib/use-host-connection";
import { color, font, radius, space } from "@/lib/theme";

type Editor =
  | { kind: "create"; agent: CodeAgentKind }
  | { kind: "rename"; account: AgentAccount }
  | { kind: "credential"; account: AgentAccount; credentialKind: AgentCredentialKind }
  | null;

const agentTitle: Record<CodeAgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const statusText: Record<AgentAccount["status"], string> = {
  signed_in: "已登录",
  signed_out: "未登录",
  unavailable: "CLI 未安装",
  error: "状态未知",
};

const statusColor: Record<AgentAccount["status"], string> = {
  signed_in: color.success,
  signed_out: color.textFaint,
  unavailable: color.warn,
  error: color.danger,
};

export default function AgentAccountsScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  const { conn, runtime } = useHostConnection(hostId);
  const [accounts, setAccounts] = useState<AgentAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const [name, setName] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    if (!conn || runtime.status !== "connected") {
      setLoading(false);
      return;
    }
    if (!conn.supportsAgentAccounts) {
      setError("当前 Mac 端还不支持账号管理，请先升级并重启 Prospero daemon。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setAccounts(await conn.agentAccounts());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [conn, runtime.status]);

  useFocusEffect(
    useCallback(() => {
      void refresh();
      return undefined;
    }, [refresh]),
  );

  const grouped = useMemo(
    () => ({
      claude: accounts.filter((account) => account.agent === "claude"),
      codex: accounts.filter((account) => account.agent === "codex"),
    }),
    [accounts],
  );

  const mutate = async (
    accountId: string,
    action: () => Promise<{ accounts: AgentAccount[] }>,
  ): Promise<void> => {
    setBusyId(accountId);
    setError(null);
    try {
      const result = await action();
      setAccounts(result.accounts);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {
      setBusyId(null);
    }
  };

  const openCreate = (agent: CodeAgentKind): void => {
    setName("");
    setEditor({ kind: "create", agent });
  };

  const openRename = (account: AgentAccount): void => {
    setName(account.name);
    setEditor({ kind: "rename", account });
  };

  const openCredential = (
    account: AgentAccount,
    credentialKind: AgentCredentialKind,
  ): void => {
    setName("");
    setEditor({ kind: "credential", account, credentialKind });
  };

  const chooseCredential = (account: AgentAccount): void => {
    Alert.alert("导入 Claude 凭据", "选择这个独立环境使用的认证方式。", [
      { text: "取消", style: "cancel" },
      { text: "订阅账号令牌", onPress: () => openCredential(account, "oauth_token") },
      { text: "Console API Key", onPress: () => openCredential(account, "api_key") },
    ]);
  };

  const submitName = async (value: string): Promise<void> => {
    if (!conn || !editor) return;
    if (editor.kind === "create") {
      const result = await conn.createAgentAccount(editor.agent, value.trim());
      setAccounts(result.accounts);
    } else if (editor.kind === "rename") {
      const result = await conn.renameAgentAccount(editor.account.id, value.trim());
      setAccounts(result.accounts);
    } else {
      const result = await conn.setAgentAccountCredential(
        editor.account.id,
        editor.credentialKind,
        value.trim(),
      );
      setAccounts(result.accounts);
      setName("");
    }
    setEditor(null);
  };

  const login = async (account: AgentAccount): Promise<void> => {
    if (!conn || !hostId) return;
    setBusyId(account.id);
    setError(null);
    try {
      const result = await conn.loginAgentAccount(account.id);
      setAccounts(result.accounts);
      if (!result.sessionId) throw new Error("Mac 没有返回登录终端");
      router.push(`/host/${hostId}/session/${result.sessionId}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusyId(null);
    }
  };

  const confirmLogout = (account: AgentAccount): void => {
    if (!conn) return;
    Alert.alert("注销账号", `从 ${account.name} 的独立环境注销 ${agentTitle[account.agent]}？`, [
      { text: "取消", style: "cancel" },
      {
        text: "注销",
        style: "destructive",
        onPress: () => {
          void mutate(account.id, () => conn.logoutAgentAccount(account.id)).catch(() => {});
        },
      },
    ]);
  };

  const confirmDelete = (account: AgentAccount): void => {
    if (!conn) return;
    if (account.activeSessions > 0) {
      Alert.alert("暂时不能删除", `这个账号仍有 ${String(account.activeSessions)} 个活动会话，请先结束它们。`);
      return;
    }
    Alert.alert(
      "删除独立账号环境",
      `会注销 ${account.name}，并删除它的本机配置、会话历史和插件状态。项目文件不会删除。`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => {
            void mutate(account.id, () => conn.deleteAgentAccount(account.id)).catch(() => {});
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Code Agent 账号",
          headerRight: () => (
            <Pressable onPress={() => void refresh()} hitSlop={10} accessibilityLabel="刷新账号状态">
              <Icon name="arrow.clockwise" size={17} color={color.accent} />
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh()} tintColor={color.accent} />}
      >
        <View style={styles.explainer}>
          <Text style={styles.explainerTitle}>账号隔离，项目共享</Text>
          <Text style={styles.explainerText}>
            每个 Prospero 账号拥有独立的凭据、配置、原生会话历史和 MCP/插件状态；创建会话时仍可选择同一个项目目录。
          </Text>
          <Text style={styles.securityText}>
            Codex 由官方 CLI 登录；Claude 独立令牌经配对加密通道写入 Mac 安全存储，不写进账号元数据或对话记录。
          </Text>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
        {loading && accounts.length === 0 && <ActivityIndicator color={color.accent} style={styles.loader} />}

        {(["claude", "codex"] as const).map((agent) => (
          <View key={agent} style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIdentity}>
                <AgentIcon agent={agent} size={21} />
                <Text style={styles.sectionTitle}>{agentTitle[agent]}</Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
                onPress={() => openCreate(agent)}
                disabled={!conn?.supportsAgentAccounts}
              >
                <Icon name="plus" size={14} color={color.accent} />
                <Text style={styles.addButtonText}>新账号</Text>
              </Pressable>
            </View>

            {grouped[agent].map((account) => {
              const busy = busyId === account.id;
              return (
                <View key={account.id} style={styles.card}>
                  <View style={styles.cardTop}>
                    <View style={styles.cardCopy}>
                      <View style={styles.nameRow}>
                        <Text style={styles.name}>{account.name}</Text>
                        {account.isDefault && <Text style={styles.defaultBadge}>默认</Text>}
                      </View>
                      <View style={styles.metaRow}>
                        <View style={[styles.statusDot, { backgroundColor: statusColor[account.status] }]} />
                        <Text style={styles.meta}>{statusText[account.status]}</Text>
                        {account.authMethod && <Text style={styles.meta}>· {account.authMethod}</Text>}
                      </View>
                      <Text style={styles.environment}>
                        {account.managed ? "Prospero 独立环境" : "现有本机环境（兼容旧会话）"}
                        {account.activeSessions > 0 ? ` · ${String(account.activeSessions)} 个活动会话` : ""}
                      </Text>
                    </View>
                    {busy && <ActivityIndicator size="small" color={color.accent} />}
                  </View>

                  <View style={styles.actions}>
                    <Action
                      label={
                        account.agent === "claude" && account.managed
                          ? "生成令牌"
                          : account.status === "signed_in"
                            ? "重新登录"
                            : "登录"
                      }
                      onPress={() => void login(account)}
                      disabled={busy}
                    />
                    {account.agent === "claude" && account.managed && (
                      <Action label="导入凭据" onPress={() => chooseCredential(account)} disabled={busy} />
                    )}
                    {!account.isDefault && (
                      <Action
                        label="设为默认"
                        onPress={() => {
                          if (conn) void mutate(account.id, () => conn.setDefaultAgentAccount(account.id)).catch(() => {});
                        }}
                        disabled={busy}
                      />
                    )}
                    {account.managed && <Action label="重命名" onPress={() => openRename(account)} disabled={busy} />}
                    {account.status === "signed_in" && <Action label="注销" onPress={() => confirmLogout(account)} disabled={busy} danger />}
                    {account.managed && <Action label="删除" onPress={() => confirmDelete(account)} disabled={busy} danger />}
                  </View>
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>

      <PromptDialog
        visible={editor !== null}
        title={
          editor?.kind === "rename"
            ? "重命名账号"
            : editor?.kind === "credential"
              ? editor.credentialKind === "oauth_token"
                ? "导入订阅账号令牌"
                : "导入 Anthropic API Key"
              : `新增 ${editor ? agentTitle[editor.agent] : ""} 账号`
        }
        message={
          editor?.kind === "create"
            ? editor.agent === "claude"
              ? "创建后先生成令牌，再把令牌导入 Mac 的独立安全存储。"
              : "创建后会得到独立环境，下一步在官方 CLI 终端完成登录。"
            : editor?.kind === "credential"
              ? editor.credentialKind === "oauth_token"
                ? "先点“生成令牌”完成 claude setup-token，再粘贴终端最后显示的令牌。"
                : "粘贴该账号自己的 Anthropic Console API Key。"
              : undefined
        }
        value={name}
        confirmLabel={editor?.kind === "credential" ? "安全保存" : editor?.kind === "rename" ? "保存" : "创建"}
        secureTextEntry={editor?.kind === "credential"}
        onChangeText={setName}
        onCancel={() => {
          if (editor?.kind === "credential") setName("");
          setEditor(null);
        }}
        onSubmit={submitName}
        validate={(value) => {
          const trimmed = value.trim();
          if (!trimmed) return editor?.kind === "credential" ? "请粘贴凭据" : "请输入账号名称";
          if (editor?.kind === "credential") {
            if (trimmed.length < 20) return "凭据长度不正确";
            if (trimmed.length > 8192 || /[\r\n\0]/.test(trimmed)) return "凭据格式不正确";
            return null;
          }
          if (trimmed.length > 80) return "名称不能超过 80 个字符";
          return null;
        }}
      />
    </View>
  );
}

function Action({
  label,
  onPress,
  disabled,
  danger = false,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.actionText, danger && styles.dangerText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.lg, paddingBottom: 48, gap: space.lg },
  explainer: { padding: space.lg, borderRadius: radius.lg, backgroundColor: color.surface, gap: space.sm },
  explainerTitle: { ...font.body, fontWeight: "700" },
  explainerText: { ...font.sub, lineHeight: 19 },
  securityText: { ...font.meta, color: color.success, lineHeight: 16 },
  error: { ...font.sub, color: color.danger, paddingHorizontal: space.xs },
  loader: { paddingVertical: space.xl },
  section: { gap: space.sm },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionIdentity: { flexDirection: "row", alignItems: "center", gap: space.sm },
  sectionTitle: { ...font.body, fontWeight: "700" },
  addButton: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.sm, backgroundColor: color.accentBg },
  addButtonText: { color: color.accent, fontSize: 12, fontWeight: "700" },
  card: { backgroundColor: color.surface, borderRadius: radius.md, padding: space.md, gap: space.md },
  cardTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  cardCopy: { flex: 1, gap: 5 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  name: { ...font.body, fontWeight: "700", flexShrink: 1 },
  defaultBadge: { color: color.accent, backgroundColor: color.accentBg, fontSize: 10, fontWeight: "700", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10, overflow: "hidden" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5, flexWrap: "wrap" },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  meta: { ...font.meta, color: color.textDim },
  environment: { ...font.meta, lineHeight: 15 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  action: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.sm, backgroundColor: color.surfaceRaised },
  actionText: { color: color.textDim, fontSize: 12, fontWeight: "600" },
  dangerText: { color: color.danger },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
