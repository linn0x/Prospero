import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Save, Search, Settings, Trash2 } from "lucide-react";
import type {
  BotMemoryEntry,
  BotMemoryScope,
  BotThread,
  PublicBot,
} from "../../../shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useLocale } from "../locale";
import { displayError } from "../state";
import { runBotAction } from "./use-bots";

type ScopeFilter = "all" | BotMemoryScope;
type CreatableScope = Exclude<BotMemoryScope, "global">;

export function feishuStateLabel(
  state: PublicBot["feishuStatus"]["state"],
  t: (zh: string, en: string) => string,
): string {
  switch (state) {
    case "connected":
      return t("飞书已连接", "Feishu connected");
    case "connecting":
      return t("飞书连接中", "Connecting");
    case "reconnecting":
      return t("飞书重连中", "Reconnecting");
    case "error":
      return t("飞书异常", "Feishu error");
    default:
      return t("未接入飞书", "Feishu off");
  }
}

function scopeBadgeLabel(
  scope: BotMemoryScope,
  t: (zh: string, en: string) => string,
): string {
  switch (scope) {
    case "global":
      return t("全局", "Global");
    case "chat":
      return t("群记忆", "Group");
    case "user":
      return t("个人记忆", "Personal");
    case "member":
      return t("群+人记忆", "Member");
  }
}

function scopeDescription(
  scope: BotMemoryScope,
  t: (zh: string, en: string) => string,
): string {
  switch (scope) {
    case "global":
      return t(
        "跨所有桌面端话题与飞书会话共享，记录通用人设、术语与常用规则。",
        "Shared across all Desktop threads and Feishu conversations.",
      );
    case "chat":
      return t(
        "仅在当前飞书群聊内读写，与其他群和私聊完全隔离。",
        "Scoped strictly to this Feishu group chat.",
      );
    case "user":
      return t(
        "记录该成员的个人称呼、偏好与习惯，Bot 可在私聊与群聊中识别其身份。",
        "Stores this person's profile and preferences across conversations.",
      );
    case "member":
      return t(
        "仅记录该成员在当前群内的角色、权限与专属上下文。",
        "Scoped strictly to this member inside this specific group.",
      );
  }
}

function sanitizeEntityInput(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]/g, "");
}

export function BotInspectorSheet({
  open,
  bot,
  activeThread,
  onOpenChange,
  onEditBot,
}: {
  open: boolean;
  bot: PublicBot;
  activeThread?: BotThread | undefined;
  onOpenChange: (open: boolean) => void;
  onEditBot: () => void;
}) {
  const { t } = useLocale();
  const [entries, setEntries] = useState<BotMemoryEntry[]>([]);
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string>("global");
  const [labelInput, setLabelInput] = useState<string>("");
  const [contentInput, setContentInput] = useState<string>("");
  const [dirty, setDirty] = useState(false);

  const [loadingList, setLoadingList] = useState(false);
  const [loadingEntry, setLoadingEntry] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const [createOpen, setCreateOpen] = useState(false);
  const [createScope, setCreateScope] = useState<CreatableScope>("chat");
  const [createChatId, setCreateChatId] = useState("");
  const [createChatName, setCreateChatName] = useState("");
  const [createUserId, setCreateUserId] = useState("");
  const [createUserName, setCreateUserName] = useState("");
  const [createLabel, setCreateLabel] = useState("");
  const [creating, setCreating] = useState(false);

  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const entryReqSeqRef = useRef(0);

  const loadEntry = useCallback(
    async (botId: string, key: string, silent = false): Promise<void> => {
      const seq = ++entryReqSeqRef.current;
      if (!silent) {
        setLoadingEntry(true);
        setSavedNotice(false);
      }
      try {
        const result = await runBotAction({
          kind: "memory.entry.read",
          botId,
          key,
        });
        if (seq !== entryReqSeqRef.current) return;
        const view = result.memory;
        setLabelInput(view?.label ?? "");
        setContentInput(view?.content ?? "");
        setDirty(false);
      } catch (reason) {
        if (seq === entryReqSeqRef.current) {
          setError(displayError(reason));
        }
      } finally {
        if (!silent && seq === entryReqSeqRef.current) {
          setLoadingEntry(false);
        }
      }
    },
    [],
  );

  const loadList = useCallback(
    async (options?: { silent?: boolean; preferKey?: string }): Promise<void> => {
      const silent = options?.silent ?? false;
      if (!silent) {
        setLoadingList(true);
        setError(undefined);
      }
      try {
        const result = await runBotAction({
          kind: "memory.list",
          botId: bot.id,
        });
        const nextEntries = result.memories ?? [];
        setEntries(nextEntries);

        const targetCandidate = options?.preferKey ?? selectedKeyRef.current;
        const resolvedKey = nextEntries.some((item) => item.key === targetCandidate)
          ? targetCandidate
          : (nextEntries[0]?.key ?? "global");

        if (resolvedKey !== selectedKeyRef.current) {
          setSelectedKey(resolvedKey);
          setConfirmDelete(false);
          await loadEntry(bot.id, resolvedKey, silent);
        } else if (!dirtyRef.current) {
          await loadEntry(bot.id, resolvedKey, silent);
        }
      } catch (reason) {
        if (!silent) {
          setError(displayError(reason));
        }
      } finally {
        if (!silent) {
          setLoadingList(false);
        }
      }
    },
    [bot.id, loadEntry],
  );

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setSavedNotice(false);
    setConfirmDelete(false);
    setCreateOpen(false);
    setDirty(false);
    dirtyRef.current = false;

    const chatId = activeThread?.feishuChatId?.trim();
    const preferredKey = chatId ? `chat:${chatId}` : "global";
    selectedKeyRef.current = preferredKey;
    setSelectedKey(preferredKey);
    if (chatId) {
      setCreateChatId(chatId);
    }

    void loadList({ silent: false, preferKey: preferredKey });
  }, [activeThread?.feishuChatId, bot.id, loadList, open]);

  useEffect(() => {
    if (!open || typeof window.prospero?.subscribeBots !== "function") return;
    return window.prospero.subscribeBots(() => {
      void loadList({ silent: true });
    });
  }, [loadList, open]);

  const counts = useMemo(() => {
    let global = 0;
    let chat = 0;
    let user = 0;
    let member = 0;
    for (const item of entries) {
      if (item.scope === "global") global += 1;
      else if (item.scope === "chat") chat += 1;
      else if (item.scope === "user") user += 1;
      else if (item.scope === "member") member += 1;
    }
    return { all: entries.length, global, chat, user, member };
  }, [entries]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((item) => {
      if (scopeFilter !== "all" && item.scope !== scopeFilter) return false;
      if (!q) return true;
      return [
        item.label,
        item.key,
        item.chatName ?? "",
        item.chatId ?? "",
        item.userName ?? "",
        item.userId ?? "",
        item.preview,
      ].some((field) => field.toLowerCase().includes(q));
    });
  }, [entries, scopeFilter, searchQuery]);

  const selectedMeta = useMemo(
    () => entries.find((item) => item.key === selectedKey),
    [entries, selectedKey],
  );

  const activeScope: BotMemoryScope =
    selectedMeta?.scope ??
    (selectedKey.startsWith("chat:")
      ? "chat"
      : selectedKey.startsWith("user:")
        ? "user"
        : selectedKey.startsWith("member:")
          ? "member"
          : "global");

  const selectEntry = async (key: string): Promise<void> => {
    if (key === selectedKey && !dirty) return;
    setSelectedKey(key);
    selectedKeyRef.current = key;
    setConfirmDelete(false);
    setSavedNotice(false);
    setError(undefined);
    await loadEntry(bot.id, key, false);
  };

  const saveEntry = async (): Promise<void> => {
    if (saving || loadingEntry) return;
    setSaving(true);
    setError(undefined);
    setSavedNotice(false);
    try {
      const result = await runBotAction({
        kind: "memory.entry.write",
        botId: bot.id,
        key: selectedKey,
        content: contentInput,
        label: selectedKey !== "global" ? labelInput.trim() || null : null,
        chatId: selectedMeta?.chatId ?? null,
        chatName: selectedMeta?.chatName ?? null,
        userId: selectedMeta?.userId ?? null,
        userName: selectedMeta?.userName ?? null,
      });
      if (result.memories) {
        setEntries(result.memories);
      }
      if (result.memory) {
        setLabelInput(result.memory.label);
        setContentInput(result.memory.content);
      }
      setDirty(false);
      dirtyRef.current = false;
      setSavedNotice(true);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setSaving(false);
    }
  };

  const deleteOrClearEntry = async (): Promise<void> => {
    if (deleting) return;
    setDeleting(true);
    setError(undefined);
    setSavedNotice(false);
    try {
      const deletingKey = selectedKey;
      const result = await runBotAction({
        kind: "memory.entry.delete",
        botId: bot.id,
        key: deletingKey,
      });
      const nextEntries = result.memories ?? [];
      setEntries(nextEntries);
      setConfirmDelete(false);
      setDirty(false);
      dirtyRef.current = false;

      if (deletingKey === "global") {
        await loadEntry(bot.id, "global", false);
      } else {
        const fallback = nextEntries[0]?.key ?? "global";
        setSelectedKey(fallback);
        selectedKeyRef.current = fallback;
        await loadEntry(bot.id, fallback, false);
      }
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setDeleting(false);
    }
  };

  const createScopedEntry = async (): Promise<void> => {
    if (creating) return;
    const cleanChat = sanitizeEntityInput(createChatId);
    const cleanUser = sanitizeEntityInput(createUserId);
    if ((createScope === "chat" || createScope === "member") && !cleanChat) {
      setError(t("请填写有效的飞书群聊 ID（如 oc_xxx）。", "Please enter a valid group chat ID."));
      return;
    }
    if ((createScope === "user" || createScope === "member") && !cleanUser) {
      setError(t("请填写有效的飞书成员 Open ID（如 ou_xxx）。", "Please enter a valid user Open ID."));
      return;
    }

    const newKey =
      createScope === "chat"
        ? `chat:${cleanChat}`
        : createScope === "user"
          ? `user:${cleanUser}`
          : `member:${cleanChat}:${cleanUser}`;
    const displayLabel = createLabel.trim();

    setCreating(true);
    setError(undefined);
    setSavedNotice(false);
    try {
      const result = await runBotAction({
        kind: "memory.entry.write",
        botId: bot.id,
        key: newKey,
        content: "",
        label: displayLabel || null,
        chatId: cleanChat || null,
        chatName: createChatName.trim() || null,
        userId: cleanUser || null,
        userName: createUserName.trim() || null,
      });
      if (result.memories) {
        setEntries(result.memories);
      }
      setCreateOpen(false);
      setCreateLabel("");
      setCreateChatName("");
      setCreateUserName("");
      setScopeFilter("all");
      setSelectedKey(newKey);
      selectedKeyRef.current = newKey;
      setLabelInput(result.memory?.label ?? displayLabel);
      setContentInput(result.memory?.content ?? "");
      setDirty(false);
      dirtyRef.current = false;
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setCreating(false);
    }
  };

  const reconnectFeishu = async (): Promise<void> => {
    if (reconnecting) return;
    setReconnecting(true);
    setError(undefined);
    try {
      await runBotAction({ kind: "feishu.reconnect", botId: bot.id });
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setReconnecting(false);
    }
  };

  const knownChats = useMemo(
    () =>
      entries.filter(
        (item): item is BotMemoryEntry & { chatId: string } =>
          item.scope === "chat" && Boolean(item.chatId),
      ),
    [entries],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span>{bot.avatar}</span>
            <span>{bot.name}</span>
          </SheetTitle>
          <SheetDescription>
            {bot.description ||
              t(
                "Bot 运行参数、飞书 IM 状态与群/人分层长期记忆",
                "Runtime profile, Feishu IM status, and scoped long-term memory",
              )}
          </SheetDescription>
        </SheetHeader>

        <div className="grid gap-4 p-4 pt-0">
          {error && (
            <Alert variant="destructive">
              <AlertTitle>{t("操作失败", "Error")}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Profile summary */}
          <div className="bot-editor-section">
            <div className="flex items-center justify-between gap-2">
              <strong className="text-xs font-semibold text-muted-foreground">
                {t("运行参数", "Runtime")}
              </strong>
              <Button variant="outline" size="xs" onClick={onEditBot}>
                <Settings data-icon="inline-start" />
                {t("编辑配置", "Edit Bot")}
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">{bot.agent}</Badge>
              {bot.model && <Badge variant="outline">{bot.model}</Badge>}
              {bot.effort && <Badge variant="outline">{bot.effort}</Badge>}
              {bot.allowCrossWorkspace && (
                <Badge variant="outline">{t("多 Bot 协同", "Multi-Bot")}</Badge>
              )}
            </div>
          </div>

          {/* Feishu Status */}
          <div className="bot-editor-section">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="bot-feishu-dot" data-state={bot.feishuStatus.state} />
                <strong className="text-xs font-semibold">
                  {feishuStateLabel(bot.feishuStatus.state, t)}
                </strong>
              </div>
              {bot.feishu.enabled && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={reconnecting}
                  onClick={() => void reconnectFeishu()}
                >
                  {reconnecting ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RefreshCw data-icon="inline-start" />
                  )}
                  {t("重连", "Reconnect")}
                </Button>
              )}
            </div>
            {bot.feishu.enabled ? (
              <div className="grid gap-1 text-xs text-muted-foreground">
                <div>
                  App ID: <code>{bot.feishu.appId}</code>
                </div>
                {bot.feishuStatus.botName && (
                  <div>
                    {t("识别机器人：", "Bot name: ")}
                    {bot.feishuStatus.botName}
                  </div>
                )}
                {bot.feishuStatus.lastError && (
                  <p className="text-destructive">{bot.feishuStatus.lastError}</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t(
                  "当前未绑定飞书应用。点击上方「编辑配置」即可配置 App ID / Secret 接入飞书长连接。",
                  "Feishu IM is disabled for this Bot. Click Edit Bot to bind a Feishu App ID & Secret.",
                )}
              </p>
            )}
          </div>

          {/* Layered Scoped Long-term Memory Viewer & Editor */}
          <div className="bot-editor-section">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <strong className="text-xs font-semibold text-muted-foreground">
                  {t("分层长期记忆", "Layered Long-Term Memory")}
                </strong>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t(
                    "按「全局 / 群记忆 / 个人记忆 / 群+人记忆」自动隔离存储与检索，绝不跨群串味。",
                    "Isolated automatically across Global, Group, Personal, and Group+Member scopes.",
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  disabled={loadingList}
                  onClick={() => void loadList({ silent: false })}
                >
                  {loadingList ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <RefreshCw data-icon="inline-start" />
                  )}
                  {t("刷新", "Refresh")}
                </Button>
                <Button
                  variant={createOpen ? "secondary" : "outline"}
                  size="xs"
                  onClick={() => setCreateOpen((prev) => !prev)}
                >
                  <Plus data-icon="inline-start" />
                  {t("新建记忆", "New memory")}
                </Button>
              </div>
            </div>

            {/* Scope Filter Tabs */}
            <div className="bot-memory-tabs" role="tablist" aria-label={t("记忆作用域", "Memory scopes")}>
              {(
                [
                  ["all", t("全部", "All"), counts.all],
                  ["global", t("全局", "Global"), counts.global],
                  ["chat", t("群记忆", "Group"), counts.chat],
                  ["user", t("个人记忆", "Personal"), counts.user],
                  ["member", t("群+人记忆", "Member"), counts.member],
                ] as const
              ).map(([scopeId, title, count]) => (
                <button
                  key={scopeId}
                  type="button"
                  role="tab"
                  aria-selected={scopeFilter === scopeId}
                  className="bot-memory-tab"
                  data-active={scopeFilter === scopeId}
                  onClick={() => setScopeFilter(scopeId)}
                >
                  <span>{title}</span>
                  <span className="text-[11px] opacity-75">{count}</span>
                </button>
              ))}
            </div>

            {/* Search Filter */}
            <div className="bot-memory-toolbar">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t(
                    "按群名、成员、ID 或摘要关键词筛选…",
                    "Filter by group, member, ID, or snippet...",
                  )}
                  className="h-8 pl-8 text-xs"
                />
              </div>
            </div>

            {/* Inline Create Form */}
            {createOpen && (
              <div className="bot-memory-create">
                <div className="bot-editor-grid-2">
                  <div className="grid gap-1">
                    <span className="text-xs font-medium">{t("记忆层级", "Scope")}</span>
                    <NativeSelect
                      value={createScope}
                      onChange={(event) => setCreateScope(event.target.value as CreatableScope)}
                    >
                      <NativeSelectOption value="chat">
                        {t("群记忆 (chat)", "Group memory (chat)")}
                      </NativeSelectOption>
                      <NativeSelectOption value="user">
                        {t("个人记忆 (user)", "Personal memory (user)")}
                      </NativeSelectOption>
                      <NativeSelectOption value="member">
                        {t("群+人记忆 (member)", "Group + Member memory")}
                      </NativeSelectOption>
                    </NativeSelect>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-xs font-medium">
                      {t("备注名称（可选）", "Display label (optional)")}
                    </span>
                    <Input
                      value={createLabel}
                      onChange={(event) => setCreateLabel(event.target.value)}
                      placeholder={t("例如：核心研发群 / 张三", "e.g. Core Team / Alice")}
                    />
                  </div>
                </div>

                {(createScope === "chat" || createScope === "member") && (
                  <div className="bot-editor-grid-2">
                    <div className="grid gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">
                          {t("飞书群聊 ID", "Feishu Chat ID")}
                        </span>
                        {knownChats.length > 0 && (
                          <select
                            aria-label={t("选择已有群聊", "Pick existing group")}
                            className="max-w-[140px] truncate rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground"
                            value=""
                            onChange={(event) => {
                              const picked = knownChats.find((c) => c.chatId === event.target.value);
                              if (!picked) return;
                              setCreateChatId(picked.chatId);
                              if (picked.chatName) setCreateChatName(picked.chatName);
                            }}
                          >
                            <option value="">{t("填入已知群…", "Pick group...")}</option>
                            {knownChats.map((c) => (
                              <option key={c.key} value={c.chatId}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                      <Input
                        value={createChatId}
                        onChange={(event) => setCreateChatId(event.target.value)}
                        placeholder="oc_..."
                      />
                    </div>
                    <div className="grid gap-1">
                      <span className="text-xs font-medium">
                        {t("群名称（可选）", "Group name (optional)")}
                      </span>
                      <Input
                        value={createChatName}
                        onChange={(event) => setCreateChatName(event.target.value)}
                        placeholder={t("自动识别或手动备注", "Auto-detected or custom")}
                      />
                    </div>
                  </div>
                )}

                {(createScope === "user" || createScope === "member") && (
                  <div className="bot-editor-grid-2">
                    <div className="grid gap-1">
                      <span className="text-xs font-medium">
                        {t("成员 Open ID", "User Open ID")}
                      </span>
                      <Input
                        value={createUserId}
                        onChange={(event) => setCreateUserId(event.target.value)}
                        placeholder="ou_..."
                      />
                    </div>
                    <div className="grid gap-1">
                      <span className="text-xs font-medium">
                        {t("成员姓名（可选）", "User name (optional)")}
                      </span>
                      <Input
                        value={createUserName}
                        onChange={(event) => setCreateUserName(event.target.value)}
                        placeholder={t("例如：张三", "e.g. Alice")}
                      />
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={creating}
                    onClick={() => setCreateOpen(false)}
                  >
                    {t("取消", "Cancel")}
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    disabled={creating}
                    onClick={() => void createScopedEntry()}
                  >
                    {creating && <Spinner data-icon="inline-start" />}
                    {t("创建并编辑", "Create & edit")}
                  </Button>
                </div>
              </div>
            )}

            {/* Split List + Editor */}
            {loadingList && entries.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Spinner />
              </div>
            ) : (
              <div className="bot-memory-grid">
                <div className="bot-memory-list">
                  {filteredEntries.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                      {t("当前筛选下暂无记忆条目。", "No memory entries match this filter.")}
                    </div>
                  ) : (
                    filteredEntries.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className="bot-memory-item"
                        data-selected={item.key === selectedKey}
                        onClick={() => void selectEntry(item.key)}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="truncate text-xs font-semibold text-foreground">
                            {item.label}
                          </span>
                          <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
                            {scopeBadgeLabel(item.scope, t)}
                          </Badge>
                        </div>
                        {(item.chatId || item.userId) && (
                          <div className="truncate font-mono text-[10px] text-muted-foreground">
                            {item.scope === "member"
                              ? `${item.chatName ?? item.chatId ?? ""} · ${item.userName ?? item.userId ?? ""}`
                              : item.scope === "chat"
                                ? item.chatId
                                : item.userId}
                          </div>
                        )}
                        <div className="line-clamp-2 text-[11px] text-muted-foreground">
                          {item.preview || t("尚无内容", "Empty")}
                        </div>
                      </button>
                    ))
                  )}
                </div>

                <div className="bot-memory-editor">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Badge variant="outline">{scopeBadgeLabel(activeScope, t)}</Badge>
                      {selectedMeta?.chatId && (
                        <code className="truncate text-[11px] text-muted-foreground">
                          {selectedMeta.chatId}
                        </code>
                      )}
                      {selectedMeta?.userId && (
                        <code className="truncate text-[11px] text-muted-foreground">
                          {selectedMeta.userId}
                        </code>
                      )}
                    </div>
                    <Button
                      size="xs"
                      disabled={loadingEntry || saving}
                      onClick={() => void saveEntry()}
                    >
                      {saving ? (
                        <Spinner data-icon="inline-start" />
                      ) : (
                        <Save data-icon="inline-start" />
                      )}
                      {t("保存记忆", "Save")}
                    </Button>
                  </div>

                  {selectedKey !== "global" ? (
                    <div className="grid gap-1">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {t("显示名称", "Display name")}
                      </span>
                      <Input
                        value={labelInput}
                        disabled={loadingEntry || saving}
                        onChange={(event) => {
                          setLabelInput(event.target.value);
                          setDirty(true);
                          dirtyRef.current = true;
                          setSavedNotice(false);
                        }}
                        placeholder={t("输入易于辨识的备注名", "Friendly display label")}
                        className="h-8 text-xs"
                      />
                    </div>
                  ) : (
                    <div className="text-xs font-medium text-foreground">
                      {t("全局长期记忆", "Global Long-Term Memory")}
                    </div>
                  )}

                  <p className="text-[11px] text-muted-foreground">
                    {scopeDescription(activeScope, t)}
                  </p>

                  {loadingEntry ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground">
                      <Spinner />
                    </div>
                  ) : (
                    <Textarea
                      rows={11}
                      value={contentInput}
                      disabled={saving}
                      onChange={(event) => {
                        setContentInput(event.target.value);
                        setDirty(true);
                        dirtyRef.current = true;
                        setSavedNotice(false);
                      }}
                    />
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      {confirmDelete ? (
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            disabled={deleting}
                            onClick={() => void deleteOrClearEntry()}
                          >
                            {deleting && <Spinner data-icon="inline-start" />}
                            {selectedKey === "global"
                              ? t("确认重置", "Confirm clear")
                              : t("确认删除", "Confirm delete")}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={deleting}
                            onClick={() => setConfirmDelete(false)}
                          >
                            {t("取消", "Cancel")}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={loadingEntry || deleting}
                          onClick={() => setConfirmDelete(true)}
                        >
                          <Trash2 data-icon="inline-start" />
                          {selectedKey === "global"
                            ? t("清空全局记忆", "Reset global")
                            : t("删除此记忆", "Delete entry")}
                        </Button>
                      )}
                    </div>

                    {savedNotice && (
                      <span className="text-xs text-emerald-600 dark:text-emerald-400">
                        {t("已保存，后续对话将生效。", "Memory saved.")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
