import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookMarked,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type {
  BotFeishuAdmin,
  BotMemoryEntry,
  BotMemoryScope,
  BotThread,
  FeishuAccessPolicy,
  PublicBot,
} from "../../../shared/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useLocale } from "../locale";
import { displayError } from "../state";
import { FeishuAccessControlPanel } from "./FeishuAccessControlPanel";
import { runBotAction } from "./use-bots";

type ScopeFilter = "all" | BotMemoryScope;
type CreatableScope = Exclude<BotMemoryScope, "global">;
export type BotStudioTab = "memory" | "access";

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
  initialTab = "memory",
  onOpenChange,
  onEditBot,
  onBotsUpdated,
}: {
  open: boolean;
  bot: PublicBot;
  activeThread?: BotThread | undefined;
  initialTab?: BotStudioTab;
  onOpenChange: (open: boolean) => void;
  onEditBot: () => void;
  onBotsUpdated?: ((bots: PublicBot[]) => void) | undefined;
}) {
  const { t } = useLocale();
  const [studioTab, setStudioTab] = useState<BotStudioTab>(initialTab);
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
  const [savingAccess, setSavingAccess] = useState(false);
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
    setStudioTab(initialTab);
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
  }, [activeThread?.feishuChatId, bot.id, initialTab, loadList, open]);

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
    setCreateOpen(false);
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

  const updateAccessControl = async (
    nextPolicy: FeishuAccessPolicy,
    nextAdmins: BotFeishuAdmin[],
  ): Promise<void> => {
    if (savingAccess) return;
    setSavingAccess(true);
    setError(undefined);
    try {
      const result = await runBotAction({
        kind: "feishu.access.update",
        botId: bot.id,
        accessPolicy: nextPolicy,
        adminUsers: nextAdmins,
      });
      if (result.bots) {
        onBotsUpdated?.(result.bots);
      }
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setSavingAccess(false);
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(84vh,720px)] w-[min(940px,calc(100vw-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[940px]">
        {/* Studio Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3.5 pr-12 bg-muted/15">
          <div className="flex items-center gap-3 min-w-0">
            <span className="bots-pane-avatar" aria-hidden="true">
              {bot.avatar}
            </span>
            <div className="min-w-0 grid gap-0.5">
              <div className="flex items-center gap-2 min-w-0">
                <DialogTitle className="text-sm font-semibold truncate">{bot.name}</DialogTitle>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {bot.agent}
                </Badge>
                {bot.model && (
                  <code className="hidden sm:inline truncate text-[11px] text-muted-foreground">
                    {bot.model}
                  </code>
                )}
              </div>
              <DialogDescription className="flex items-center gap-2 text-xs text-muted-foreground truncate">
                <span className="inline-flex items-center gap-1.5">
                  <span className="bot-feishu-dot" data-state={bot.feishuStatus.state} />
                  {feishuStateLabel(bot.feishuStatus.state, t)}
                </span>
                {bot.description && (
                  <>
                    <span>·</span>
                    <span className="truncate">{bot.description}</span>
                  </>
                )}
              </DialogDescription>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="bot-studio-tabs" role="tablist" aria-label={t("功能视图切换", "Studio views")}>
              <button
                type="button"
                role="tab"
                aria-selected={studioTab === "memory"}
                className="bot-studio-tab"
                data-active={studioTab === "memory"}
                onClick={() => setStudioTab("memory")}
              >
                <BookMarked className="size-3.5" />
                <span>{t("分层长期记忆", "Memory")}</span>
                <span className="opacity-70 tabular-nums">{entries.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={studioTab === "access"}
                className="bot-studio-tab"
                data-active={studioTab === "access"}
                onClick={() => setStudioTab("access")}
              >
                <ShieldCheck className="size-3.5" />
                <span>{t("飞书与权限", "Feishu & Access")}</span>
                {bot.feishu.adminUsers.length > 0 && (
                  <span className="opacity-70 tabular-nums">{bot.feishu.adminUsers.length}</span>
                )}
              </button>
            </div>
            <Button variant="outline" size="xs" onClick={onEditBot}>
              <Settings data-icon="inline-start" />
              {t("编辑配置", "Edit Bot")}
            </Button>
          </div>
        </div>

        {error && (
          <div className="px-5 pt-3">
            <Alert variant="destructive">
              <AlertTitle>{t("操作失败", "Error")}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        )}

        {/* Body */}
        {studioTab === "memory" ? (
          <div className="bot-studio-memory-layout">
            {/* Left memory list rail */}
            <aside className="bot-studio-memory-rail">
              <div className="flex items-center gap-1.5">
                <div className="relative flex-1 min-w-0">
                  <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-muted-foreground" />
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder={t("搜索群、人或摘要…", "Search group, user...")}
                    className="h-7.5 pl-7.5 text-xs"
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon-xs"
                  title={t("刷新记忆列表", "Refresh")}
                  disabled={loadingList}
                  onClick={() => void loadList({ silent: false })}
                >
                  {loadingList ? <Spinner /> : <RefreshCw />}
                </Button>
                <Button
                  variant={createOpen ? "secondary" : "outline"}
                  size="xs"
                  onClick={() => setCreateOpen((prev) => !prev)}
                >
                  <Plus data-icon="inline-start" />
                  {t("新建", "New")}
                </Button>
              </div>

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
                    <span className="text-[11px] opacity-75 tabular-nums">{count}</span>
                  </button>
                ))}
              </div>

              {loadingList && entries.length === 0 ? (
                <div className="flex flex-1 items-center justify-center py-8 text-muted-foreground">
                  <Spinner />
                </div>
              ) : (
                <div className="bot-studio-memory-list">
                  {filteredEntries.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                      {t("当前筛选下暂无记忆条目。", "No memory entries match this filter.")}
                    </div>
                  ) : (
                    filteredEntries.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className="bot-memory-item"
                        data-selected={!createOpen && item.key === selectedKey}
                        onClick={() => void selectEntry(item.key)}
                      >
                        <div className="flex items-center justify-between gap-1.5 min-w-0">
                          <span className="truncate text-xs font-semibold text-foreground">
                            {item.label}
                          </span>
                          <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
                            {scopeBadgeLabel(item.scope, t)}
                          </Badge>
                        </div>
                        <div className="line-clamp-2 text-[11px] text-muted-foreground">
                          {item.preview || t("尚无内容", "Empty")}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              )}
            </aside>

            {/* Right memory editor / create form */}
            <div className="flex flex-1 min-w-0 min-h-0 flex-col p-5 gap-3.5 overflow-y-auto">
              {createOpen ? (
                <div className="mx-auto w-full max-w-lg grid gap-4 py-2">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">
                      {t("新建作用域记忆", "New Scoped Memory")}
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t(
                        "按飞书群聊、个人或群内成员单独隔离沉淀记忆，绝不跨群串味。",
                        "Create an isolated memory file scoped to a group, user, or group member.",
                      )}
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="grid gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t("记忆层级", "Scope")}
                      </span>
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
                    <div className="grid gap-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
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
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-muted-foreground">
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
                          className="font-mono text-xs"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
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
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          {t("成员 Open ID", "User Open ID")}
                        </span>
                        <Input
                          value={createUserId}
                          onChange={(event) => setCreateUserId(event.target.value)}
                          placeholder="ou_..."
                          className="font-mono text-xs"
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
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

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={creating}
                      onClick={() => setCreateOpen(false)}
                    >
                      {t("取消", "Cancel")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={creating}
                      onClick={() => void createScopedEntry()}
                    >
                      {creating && <Spinner data-icon="inline-start" />}
                      {t("创建并编辑", "Create & edit")}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <Badge variant="outline" className="shrink-0">
                        {scopeBadgeLabel(activeScope, t)}
                      </Badge>
                      {selectedKey !== "global" ? (
                        <Input
                          value={labelInput}
                          disabled={loadingEntry || saving}
                          onChange={(event) => {
                            setLabelInput(event.target.value);
                            setDirty(true);
                            dirtyRef.current = true;
                            setSavedNotice(false);
                          }}
                          placeholder={t("显示名称", "Display name")}
                          className="h-8 max-w-xs text-sm font-medium"
                        />
                      ) : (
                        <strong className="text-sm font-semibold text-foreground">
                          {t("全局长期记忆", "Global Long-Term Memory")}
                        </strong>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      {confirmDelete ? (
                        <>
                          <Button
                            type="button"
                            variant="destructive"
                            size="xs"
                            disabled={deleting}
                            onClick={() => void deleteOrClearEntry()}
                          >
                            {deleting && <Spinner data-icon="inline-start" />}
                            {selectedKey === "global"
                              ? t("确认清空", "Confirm reset")
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
                        </>
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
                            ? t("清空", "Reset")
                            : t("删除", "Delete")}
                        </Button>
                      )}
                      <Button
                        size="sm"
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
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{scopeDescription(activeScope, t)}</span>
                    <div className="flex items-center gap-2 font-mono text-[11px]">
                      {selectedMeta?.chatId && <code>{selectedMeta.chatId}</code>}
                      {selectedMeta?.userId && <code>{selectedMeta.userId}</code>}
                    </div>
                  </div>

                  {loadingEntry ? (
                    <div className="flex flex-1 items-center justify-center py-8 text-muted-foreground">
                      <Spinner />
                    </div>
                  ) : (
                    <Textarea
                      value={contentInput}
                      disabled={saving}
                      className="flex-1 min-h-[260px] resize-none font-mono text-xs leading-relaxed"
                      onChange={(event) => {
                        setContentInput(event.target.value);
                        setDirty(true);
                        dirtyRef.current = true;
                        setSavedNotice(false);
                      }}
                    />
                  )}

                  {savedNotice && (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">
                      {t("已保存，后续对话将自动生效。", "Saved and active for upcoming turns.")}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto p-6">
            <div className="mx-auto max-w-2xl grid gap-6">
              {/* Connection Status Card */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-muted/20 px-4 py-3.5">
                <div className="grid gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="bot-feishu-dot" data-state={bot.feishuStatus.state} />
                    <strong className="text-sm font-semibold text-foreground">
                      {feishuStateLabel(bot.feishuStatus.state, t)}
                    </strong>
                    {bot.feishuStatus.botName && (
                      <Badge variant="secondary" className="text-[11px]">
                        {bot.feishuStatus.botName}
                      </Badge>
                    )}
                  </div>
                  {bot.feishu.enabled ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>App ID: <code>{bot.feishu.appId}</code></span>
                      <span>·</span>
                      <span>
                        {bot.feishu.groupTrigger === "mention"
                          ? t("仅 @提及回复", "@mention in groups")
                          : t("响应群内全量消息", "All group messages")}
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t(
                        "尚未配置飞书应用凭据。点击右侧「修改凭据」即可接入飞书长连接。",
                        "Feishu IM is currently disabled. Click Edit Credentials to bind your Feishu app.",
                      )}
                    </p>
                  )}
                  {bot.feishuStatus.lastError && (
                    <p className="text-xs text-destructive">{bot.feishuStatus.lastError}</p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {bot.feishu.enabled && (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={reconnecting}
                      onClick={() => void reconnectFeishu()}
                    >
                      {reconnecting ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
                      {t("重连", "Reconnect")}
                    </Button>
                  )}
                  <Button variant="outline" size="xs" onClick={onEditBot}>
                    <Settings data-icon="inline-start" />
                    {t("修改凭据", "Edit Credentials")}
                  </Button>
                </div>
              </div>

              {/* Access Control & Admins */}
              <div className="relative rounded-xl border border-border bg-background/60 p-4">
                {savingAccess && (
                  <div className="absolute right-4 top-4">
                    <Spinner />
                  </div>
                )}
                <FeishuAccessControlPanel
                  accessPolicy={bot.feishu.accessPolicy}
                  adminUsers={bot.feishu.adminUsers}
                  recentSenders={bot.feishuStatus.recentSenders}
                  disabled={savingAccess}
                  onChange={(nextPolicy, nextAdmins) => void updateAccessControl(nextPolicy, nextAdmins)}
                />
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
