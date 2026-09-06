import { useCallback, useEffect, useMemo, useState } from "react";
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
import type {
  AgentAccount,
  AgentApiProtocol,
  AgentModelCapabilities,
  AgentCredentialKind,
  CodeAgentKind,
  S2CMessage,
  UsageAccount,
} from "@prospero/protocol";
import { getAgentAccountEngine } from "@prospero/protocol";
import { AgentIcon } from "@/components/AgentIcon";
import { Icon } from "@/components/Icon";
import { PromptDialog } from "@/components/PromptDialog";
import {
  accountApiProtocolDefaults,
  accountApiStatus,
  modelTokenLimit,
  updateModelTokenLimit,
  accountApiProtocolFromProfile,
  accountApiProtocolLabel,
  accountApiProtocolsForAgent,
} from "@/lib/account-api-profile";
import { useHostConnection } from "@/lib/use-host-connection";
import { untilLabel } from "@/lib/format";
import { color, font, quotaRemainingColor, quotaRemainingPct, radius, space } from "@/lib/theme";

type UsageResult = Extract<S2CMessage, { type: "usage.result" }>;

type AccountsPageCache = {
  accounts: AgentAccount[];
  usage: UsageResult | null;
  accountsUpdatedAt: number;
};

const ACCOUNTS_CACHE_TTL_MS = 60_000;
const accountsPageCache = new Map<string, AccountsPageCache>();

function cacheAccounts(hostId: string, accounts: AgentAccount[]): void {
  const cached = accountsPageCache.get(hostId);
  accountsPageCache.set(hostId, {
    accounts,
    usage: cached?.usage ?? null,
    accountsUpdatedAt: Date.now(),
  });
}

function cacheUsage(hostId: string, usage: UsageResult | null): void {
  const cached = accountsPageCache.get(hostId);
  accountsPageCache.set(hostId, {
    accounts: cached?.accounts ?? [],
    usage,
    accountsUpdatedAt: cached?.accountsUpdatedAt ?? 0,
  });
}

type Editor =
  | { kind: "create"; agent: CodeAgentKind }
  | { kind: "rename"; account: AgentAccount }
  | { kind: "credential"; account: AgentAccount; credentialKind: AgentCredentialKind }
  | {
      kind: "api";
      agent: CodeAgentKind;
      account?: AgentAccount;
      phase: "name" | "baseUrl" | "model" | "contextWindow" | "maxOutputTokens" | "apiKey";
      draft: { name: string; protocol: AgentApiProtocol; baseUrl: string; model: string; modelCapabilities?: AgentModelCapabilities };
    }
  | null;

const agentTitle: Record<CodeAgentKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const statusText: Record<AgentAccount["status"], string> = {
  signed_in: "已登录",
  signed_out: "未登录",
  unavailable: "CLI 未安装",
  error: "状态读取失败",
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
  const initialCache = hostId ? accountsPageCache.get(hostId) : undefined;
  const [accounts, setAccounts] = useState<AgentAccount[]>(() => initialCache?.accounts ?? []);
  const [loading, setLoading] = useState(() => initialCache === undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResult | null>(() => initialCache?.usage ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [editor, setEditor] = useState<Editor>(null);
  const [name, setName] = useState("");

  const rememberAccounts = useCallback((nextAccounts: AgentAccount[]): void => {
    setAccounts(nextAccounts);
    if (hostId) cacheAccounts(hostId, nextAccounts);
  }, [hostId]);

  const refresh = useCallback(async (showLoading = false): Promise<void> => {
    if (!conn || runtime.status !== "connected") {
      setLoading(false);
      return;
    }
    if (!conn.supportsAgentAccounts) {
      setError("当前电脑端还不支持账号管理，请先升级并重启 Prospero daemon。");
      setLoading(false);
      return;
    }
    const cached = hostId ? accountsPageCache.get(hostId) : undefined;
    setLoading(showLoading || cached === undefined);
    setError(null);
    try {
      const [nextAccounts, nextUsage] = await Promise.all([
        conn.agentAccounts(),
        conn.usageGet().catch(() => null),
      ]);
      rememberAccounts(nextAccounts);
      setUsage(nextUsage);
      if (hostId) cacheUsage(hostId, nextUsage);
      setNow(Date.now());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setLoading(false);
    }
  }, [conn, hostId, rememberAccounts, runtime.status]);

  useFocusEffect(
    useCallback(() => {
      const cached = hostId ? accountsPageCache.get(hostId) : undefined;
      if (cached) {
        setAccounts(cached.accounts);
        setUsage(cached.usage);
        setNow(Date.now());
        setLoading(false);
      }
      if (!cached || Date.now() - cached.accountsUpdatedAt >= ACCOUNTS_CACHE_TTL_MS) {
        void refresh(cached === undefined);
      }
      return undefined;
    }, [hostId, refresh]),
  );

  useEffect(() => {
    if (!conn || runtime.status !== "connected") return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void conn.usageGet().then((nextUsage) => {
        setUsage(nextUsage);
        if (hostId) cacheUsage(hostId, nextUsage);
      }, () => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [conn, hostId, runtime.status]);

  const grouped = useMemo(
    () => ({
      claude: accounts.filter((account) => account.agent === "claude"),
      codex: accounts.filter((account) => account.agent === "codex"),
    }),
    [accounts],
  );
  const usageByAccount = useMemo(() => {
    const result = new Map<string, UsageAccount>();
    for (const item of usage?.accounts ?? []) {
      if (item.accountId) result.set(item.accountId, item);
    }
    return result;
  }, [usage]);

  const mutate = async (
    accountId: string,
    action: () => Promise<{ accounts: AgentAccount[] }>,
  ): Promise<void> => {
    setBusyId(accountId);
    setError(null);
    try {
      const result = await action();
      rememberAccounts(result.accounts);
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

  const openCreateApi = (agent: CodeAgentKind): void => {
    const open = (protocol: AgentApiProtocol): void => {
      const defaults = accountApiProtocolDefaults(protocol);
      setName("");
      setEditor({
        kind: "api",
        agent,
        phase: "name",
        draft: { name: "", protocol, ...defaults },
      });
    };
    const protocols = accountApiProtocolsForAgent(
      agent,
      conn?.supportsAgentApiProtocols === true,
    );
    if (conn?.supportsAgentApiProtocols !== true) {
      open(protocols[0]!);
      return;
    }
    Alert.alert("选择 API 协议", "请选择服务端实际提供的接口。", [
      ...protocols.map((protocol) => ({
        text: accountApiProtocolLabel(protocol),
        onPress: () => open(protocol),
      })),
      { text: "取消", style: "cancel" as const },
    ]);
  };

  const openConfigureApi = (account: AgentAccount): void => {
    const profile = account.apiProfile;
    if (!profile && !account.apiProfileError) return;
    const current = accountApiProtocolFromProfile(
      account.agent,
      profile?.protocol,
    );
    const open = (protocol: AgentApiProtocol): void => {
      const defaults = protocol === current && profile
        ? { baseUrl: profile.baseUrl, model: profile.model }
        : account.apiProfileError ? { baseUrl: "", model: "" } : accountApiProtocolDefaults(protocol);
      setName(defaults.baseUrl);
      setEditor({
        kind: "api",
        agent: account.agent,
        account,
        phase: "baseUrl",
        draft: { name: account.name, protocol, ...defaults, ...(profile?.modelCapabilities ? { modelCapabilities: profile.modelCapabilities } : {}) },
      });
    };
    if (conn?.supportsAgentApiProtocols !== true) {
      open(current);
      return;
    }
    const protocols = accountApiProtocolsForAgent(account.agent, true);
    Alert.alert("选择 API 协议", "更换协议会同时切换默认地址和模型。", [
      ...protocols.map((protocol) => ({
        text: `${protocol === current ? "✓ " : ""}${accountApiProtocolLabel(protocol)}`,
        onPress: () => open(protocol),
      })),
      { text: "取消", style: "cancel" as const },
    ]);
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
      rememberAccounts(result.accounts);
    } else if (editor.kind === "rename") {
      const result = await conn.renameAgentAccount(editor.account.id, value.trim());
      rememberAccounts(result.accounts);
    } else if (editor.kind === "credential") {
      const result = await conn.setAgentAccountCredential(
        editor.account.id,
        editor.credentialKind,
        value.trim(),
      );
      rememberAccounts(result.accounts);
      setName("");
    } else {
      const trimmedValue = value.trim();
      if (editor.phase === "name") {
        setName(editor.draft.baseUrl);
        setEditor({ ...editor, phase: "baseUrl", draft: { ...editor.draft, name: trimmedValue } });
        return;
      }
      if (editor.phase === "baseUrl") {
        setName(editor.draft.model);
        setEditor({ ...editor, phase: "model", draft: { ...editor.draft, baseUrl: trimmedValue } });
        return;
      }
      if (editor.phase === "model") {
        const nextPhase = conn.supportsAgentApiValidation ? "contextWindow" : "apiKey";
        setName(conn.supportsAgentApiValidation ? String(editor.draft.modelCapabilities?.contextWindow ?? "") : "");
        setEditor({ ...editor, phase: nextPhase, draft: { ...editor.draft, model: trimmedValue } });
        return;
      }
      if (editor.phase === "contextWindow" || editor.phase === "maxOutputTokens") {
        const modelCapabilities = updateModelTokenLimit(editor.draft.modelCapabilities, editor.phase, trimmedValue);
        setName(editor.phase === "contextWindow" ? String(modelCapabilities.maxOutputTokens ?? "") : "");
        setEditor({ ...editor, phase: editor.phase === "contextWindow" ? "maxOutputTokens" : "apiKey", draft: { ...editor.draft, modelCapabilities } });
        return;
      }
      const result = editor.account
        ? await conn.configureAgentApiProfile(
            editor.account.id,
            editor.draft.protocol,
            editor.draft.baseUrl,
            editor.draft.model,
            trimmedValue || undefined,
            JSON.stringify(editor.draft.modelCapabilities ?? {}) === JSON.stringify(editor.account.apiProfile?.modelCapabilities ?? {}) ? undefined : editor.draft.modelCapabilities && Object.keys(editor.draft.modelCapabilities).length ? editor.draft.modelCapabilities : null,
          )
        : await conn.createAgentApiProfile(
            editor.agent,
            editor.draft.name,
            editor.draft.protocol,
            editor.draft.baseUrl,
            editor.draft.model,
            trimmedValue,
            editor.draft.modelCapabilities,
          );
      rememberAccounts(result.accounts);
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
      rememberAccounts(result.accounts);
      if (!result.sessionId) throw new Error("电脑端没有返回登录终端");
      router.push(`/host/${hostId}/session/${result.sessionId}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusyId(null);
    }
  };

  const confirmLogout = (account: AgentAccount): void => {
    if (!conn) return;
    const api = account.apiProfile !== undefined;
    Alert.alert(api ? "移除 API Key" : "注销账号", api
      ? `移除 ${account.name} 的 API Key？该独立配置与会话历史会保留。`
      : `从 ${account.name} 的独立环境注销 ${agentTitle[account.agent]}？`, [
      { text: "取消", style: "cancel" },
      {
        text: api ? "移除" : "注销",
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
          title: "Code Agent 账号与 API",
          headerRight: () => (
            <Pressable onPress={() => void refresh(true)} hitSlop={10} accessibilityLabel="刷新账号状态">
              <Icon name="arrow.clockwise" size={17} color={color.accent} />
            </Pressable>
          ),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void refresh(true)} tintColor={color.accent} />}
      >
        <View style={styles.explainer}>
          <Text style={styles.explainerTitle}>账号/API 隔离，项目共享</Text>
          <Text style={styles.explainerText}>
            每个 Prospero 账号或 API Profile 都拥有独立的凭据、配置、原生会话历史和 MCP/插件状态；创建会话时仍可选择同一个项目目录。
          </Text>
          <Text style={styles.securityText}>
            Codex 可由官方 CLI 登录；API Key 和 Claude 独立令牌经配对加密通道写入电脑端安全存储，不写进账号元数据或对话记录。第三方 API 必须使用 HTTPS（localhost 除外）。
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
              <View style={styles.addActions}>
                <Pressable
                  style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
                  onPress={() => openCreate(agent)}
                  disabled={!conn?.supportsAgentAccounts}
                >
                  <Icon name="plus" size={14} color={color.accent} />
                  <Text style={styles.addButtonText}>新账号</Text>
                </Pressable>
                <Pressable
                  style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
                  onPress={() => openCreateApi(agent)}
                  disabled={!conn?.supportsAgentApiProfiles}
                >
                  <Icon name="plus" size={14} color={color.accent} />
                  <Text style={styles.addButtonText}>新 API</Text>
                </Pressable>
              </View>
            </View>

            {grouped[agent].map((account) => {
              const busy = busyId !== null;
              const hasApiProfile = Boolean(account.apiProfile || account.apiProfileError);
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
                        <Text style={styles.meta}>{hasApiProfile ? accountApiStatus(account) : statusText[account.status]}</Text>
                        {account.authMethod && <Text style={styles.meta}>· {account.authMethod}</Text>}
                      </View>
                      {account.detail && !hasApiProfile && <Text style={styles.environment}>{account.detail}</Text>}
                      <Text style={styles.environment}>
                        {account.apiProfile
                          ? `${getAgentAccountEngine(account)} · ${accountApiProtocolLabel(accountApiProtocolFromProfile(account.agent, account.apiProfile.protocol))} · ${account.apiProfile.model}\n${account.apiProfile.baseUrl}`
                          : account.apiProfileError ? "API Profile · 等待修复" : account.managed ? "Prospero 独立环境" : "现有本机环境（兼容旧会话）"}
                        {account.activeSessions > 0 ? ` · ${String(account.activeSessions)} 个活动会话` : ""}
                      </Text>
                      {hasApiProfile && <View>
                        {account.apiProfileError && <Text style={styles.error}>{account.apiProfileError}</Text>}
                        {account.apiValidation && <>
                          <Text style={styles.environment}>{(["runtime", "streaming", "tools"] as const).map((key) => `${key === "runtime" ? "运行环境" : key === "streaming" ? "流式响应" : "工具调用"}：${account.apiValidation!.checks[key] === "passed" ? "通过" : account.apiValidation!.checks[key] === "failed" ? "失败" : "未测试"}`).join(" · ")}</Text>
                          <Text style={styles.environment}>{account.apiValidation.detail}{"\n"}{new Date(account.apiValidation.checkedAt).toLocaleString()}</Text>
                        </>}
                        {conn?.supportsAgentApiValidation && <Text style={styles.environment}>测试会向服务商发送少量请求，可能消耗额度；API 协议检查不代表完整 Agent 执行已验证。</Text>}
                      </View>}
                      <AccountUsage
                        account={account}
                        usage={usageByAccount.get(account.id)}
                        now={now}
                      />
                    </View>
                    {busyId === account.id && <ActivityIndicator size="small" color={color.accent} />}
                  </View>

                  <View style={styles.actions}>
                    {hasApiProfile ? (
                      <>
                        {conn?.supportsAgentApiValidation && <Action label="测试 API 连接" disabled={busy || Boolean(account.apiProfileError) || account.status === "signed_out"} onPress={() => { if (conn) void mutate(account.id, () => conn.testAgentApiProfile(account.id)).catch(() => {}); }} />}
                        <Action
                          label={account.activeSessions > 0 ? "结束会话后配置" : account.apiProfileError ? "修复配置" : "重新配置"}
                          onPress={() => openConfigureApi(account)}
                          disabled={busy || account.activeSessions > 0}
                        />
                        <Action
                          label={account.activeSessions > 0 ? "结束会话后换 Key" : "替换 API Key"}
                          onPress={() => openCredential(account, "api_key")}
                          disabled={busy || account.activeSessions > 0 || Boolean(account.apiProfileError)}
                        />
                      </>
                    ) : (
                      <>
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
                      </>
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
                    {account.status === "signed_in" && <Action label={account.apiProfile && account.activeSessions > 0 ? "结束会话后移除密钥" : account.apiProfile ? "移除密钥" : "注销"} onPress={() => confirmLogout(account)} disabled={busy || Boolean(account.apiProfile && account.activeSessions > 0)} danger />}
                    {account.managed && <Action label={account.activeSessions > 0 ? "结束会话后删除" : "删除"} onPress={() => confirmDelete(account)} disabled={busy || account.activeSessions > 0} danger />}
                  </View>
                </View>
              );
            })}
          </View>
        ))}

        {conn?.supportsDeepseekHarness && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIdentity}>
                <AgentIcon agent="deepseek" size={21} />
                <Text style={styles.sectionTitle}>DeepSeek Harness</Text>
              </View>
            </View>

            <View style={styles.card}>
              <View style={styles.cardTop}>
                <View style={styles.cardCopy}>
                  <Text style={styles.name}>本机 Harness</Text>
                  <View style={styles.metaRow}>
                    <View style={[styles.statusDot, { backgroundColor: color.success }]} />
                    <Text style={styles.meta}>已接入</Text>
                  </View>
                  <Text style={styles.environment}>
                    模型与 API Key 由 DeepSeek Harness（dsh）管理
                  </Text>
                  <View style={styles.usageBox}>
                    <View style={styles.usageHead}>
                      <Text style={styles.sourceBadge}>Harness 模型</Text>
                      <Text style={styles.usageValue}>额度由模型服务商管理</Text>
                    </View>
                  </View>
                </View>
              </View>
            </View>
          </View>
        )}
      </ScrollView>

      <PromptDialog
        visible={editor !== null}
        title={
          editor?.kind === "rename"
            ? "重命名账号"
            : editor?.kind === "credential"
              ? editor.account.apiProfile
                ? "保存 API Key"
                : editor.credentialKind === "oauth_token"
                ? "导入订阅账号令牌"
                : "导入 Anthropic API Key"
              : editor?.kind === "api"
                ? editor.phase === "name"
                  ? `新增 ${accountApiProtocolLabel(editor.draft.protocol)} 配置`
                  : editor.phase === "baseUrl"
                    ? "API Base URL"
                    : editor.phase === "model"
                      ? "默认模型"
                      : editor.phase === "contextWindow"
                        ? "上下文窗口（可选）"
                        : editor.phase === "maxOutputTokens"
                          ? "最大输出（可选）"
                      : editor.account && conn?.supportsAgentApiProtocols
                        ? "API Key（可选）"
                        : "保存 API Key"
              : `新增 ${editor ? agentTitle[editor.agent] : ""} 账号`
        }
        message={
          editor?.kind === "create"
            ? editor.agent === "claude"
              ? "创建后先生成令牌，再把令牌导入电脑端的独立安全存储。"
              : "创建后会得到独立环境，下一步在官方 CLI 终端完成登录。"
            : editor?.kind === "credential"
              ? editor.account.apiProfile
                ? "粘贴此独立 API Profile 的新 Key。原有 Key 不会显示或回传。"
                : editor.credentialKind === "oauth_token"
                ? "先点“生成令牌”完成 claude setup-token，再粘贴终端最后显示的令牌。"
                : "粘贴该账号自己的 Anthropic Console API Key。"
              : editor?.kind === "api"
                ? editor.phase === "name"
                  ? `${accountApiProtocolLabel(editor.draft.protocol)} 兼容服务将只供这个独立环境使用。`
                  : editor.phase === "baseUrl"
                    ? editor.draft.protocol === "anthropic"
                      ? "输入 API 根地址，例如 https://api.anthropic.com，不要包含 /v1/messages。"
                      : `输入 API 前缀，例如 https://gateway.example.com/v1，不要包含 ${editor.draft.protocol === "openai_responses" ? "/responses" : "/chat/completions"}。`
                    : editor.phase === "model"
                      ? "输入该服务中要作为默认模型使用的精确模型 ID。"
                      : editor.phase === "contextWindow" || editor.phase === "maxOutputTokens"
                        ? `按服务商文档填写 Token 正整数上限；未知可留空。${editor.draft.protocol === "openai_chat_completions" ? "Chat Completions 的两个上限须同时填写或同时留空。" : ""}其他已保存的模型能力保持原值。`
                      : editor.account && conn?.supportsAgentApiProtocols
                        ? "留空会保留现有 Key；新 Key 仅写入电脑端安全存储。"
                        : "Key 仅写入电脑端安全存储，不会保存在账号配置或聊天记录中。"
              : undefined
        }
        value={name}
        confirmLabel={editor?.kind === "api" && editor.phase === "apiKey" && editor.account && conn?.supportsAgentApiProtocols ? "保存配置" : editor?.kind === "credential" || editor?.kind === "api" && editor.phase === "apiKey" ? "安全保存" : editor?.kind === "rename" ? "保存" : editor?.kind === "api" ? "下一步" : "创建"}
        secureTextEntry={editor?.kind === "credential" || editor?.kind === "api" && editor.phase === "apiKey"}
        onChangeText={setName}
        onCancel={() => {
          if (editor?.kind === "credential" || editor?.kind === "api") setName("");
          setEditor(null);
        }}
        onSubmit={submitName}
        validate={(value) => {
          const trimmed = value.trim();
          const optionalApiKey = editor?.kind === "api" && editor.phase === "apiKey" && editor.account !== undefined && conn?.supportsAgentApiProtocols === true;
          const optionalLimit = editor?.kind === "api" && (editor.phase === "contextWindow" || editor.phase === "maxOutputTokens");
          if (!trimmed && !optionalApiKey && !optionalLimit) return editor?.kind === "credential" || editor?.kind === "api" && editor.phase === "apiKey" ? "请粘贴凭据" : "请输入内容";
          if (editor?.kind === "api") {
            if (editor.phase === "contextWindow" || editor.phase === "maxOutputTokens") {
              try {
                const limit = modelTokenLimit(trimmed);
                if (editor.phase === "maxOutputTokens" && editor.draft.protocol === "openai_chat_completions" && (limit === undefined) !== (editor.draft.modelCapabilities?.contextWindow === undefined)) return "Chat Completions 的两个 Token 上限须同时填写或同时留空";
                if (editor.phase === "maxOutputTokens" && limit !== undefined && editor.draft.modelCapabilities?.contextWindow !== undefined && limit > editor.draft.modelCapabilities.contextWindow) return "输出上限不能大于上下文窗口";
              } catch (error) { return error instanceof Error ? error.message : String(error); }
              return null;
            }
            if (editor.phase === "name" && trimmed.length > 80) return "名称不能超过 80 个字符";
            if (editor.phase === "baseUrl" && (trimmed.length > 2000 || /[\r\n\0]/.test(trimmed))) return "API 地址格式不正确";
            if (editor.phase === "model" && (trimmed.length > 300 || /[\r\n\0]/.test(trimmed))) return "模型名称格式不正确";
            if (editor.phase === "apiKey" && (trimmed.length > 8192 || /[\r\n\0]/.test(trimmed))) return "凭据格式不正确";
            return null;
          }
          if (editor?.kind === "credential") {
            if (trimmed.length < (editor.account.apiProfile ? 1 : 20)) return "凭据长度不正确";
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

function tightestWindow(usage: UsageAccount | undefined): UsageAccount["windows"][number] | null {
  return usage?.windows.reduce<UsageAccount["windows"][number] | null>(
    (best, window) => best === null || window.utilization > best.utilization ? window : best,
    null,
  ) ?? null;
}

function sourceLabel(account: AgentAccount, usage: UsageAccount | undefined): string {
  if (account.apiProfile || usage?.source === "api" || /api/i.test(account.authMethod ?? "")) {
    return "API 模型";
  }
  if (usage?.subscription) return `${usage.subscription} 订阅`;
  if (/chatgpt/i.test(account.authMethod ?? "")) return "ChatGPT 订阅";
  return account.status === "signed_in" ? "官方订阅账号" : "来源待登录";
}

function AccountUsage({
  account,
  usage,
  now,
}: {
  account: AgentAccount;
  usage: UsageAccount | undefined;
  now: number;
}) {
  const window = tightestWindow(usage);
  const api = account.apiProfile !== undefined || usage?.source === "api";
  const remaining = window ? quotaRemainingPct(window.utilization) : null;
  return (
    <View style={styles.usageBox}>
      <View style={styles.usageHead}>
        <Text style={styles.sourceBadge}>{sourceLabel(account, usage)}</Text>
        <Text style={[styles.usageValue, remaining !== null && { color: quotaRemainingColor(remaining) }]}>
          {remaining !== null
            ? `${window?.label ?? "额度"}剩余 ${String(remaining)}%`
            : api
              ? "由 API 服务商计费"
              : usage?.reason ?? "额度暂不可用"}
        </Text>
      </View>
      {window && (
        <>
          <View style={styles.usageTrack}>
            <View
              style={[
                styles.usageFill,
                {
                  width: `${remaining ?? 0}%` as const,
                  backgroundColor: quotaRemainingColor(remaining ?? 0),
                },
              ]}
            />
          </View>
          {window.resetsAt && (
            <Text style={styles.resetText}>{untilLabel(window.resetsAt, now)}</Text>
          )}
        </>
      )}
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
  addActions: { flexDirection: "row", alignItems: "center", gap: space.xs },
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
  usageBox: { marginTop: 3, gap: 5 },
  usageHead: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  sourceBadge: { ...font.meta, color: color.accent, backgroundColor: color.accentBg, paddingHorizontal: 7, paddingVertical: 3, borderRadius: radius.sm, overflow: "hidden" },
  usageValue: { ...font.meta, color: color.textDim, flexShrink: 1 },
  usageTrack: { height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: color.surfaceRaised },
  usageFill: { height: "100%", borderRadius: 2 },
  resetText: { ...font.meta, color: color.textFaint },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  action: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.sm, backgroundColor: color.surfaceRaised },
  actionText: { color: color.textDim, fontSize: 12, fontWeight: "600" },
  dangerText: { color: color.danger },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72 },
});
