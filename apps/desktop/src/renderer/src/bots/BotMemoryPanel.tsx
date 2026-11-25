import { useMemo, useState } from "react";
import {
  Brain,
  Check,
  FileText,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  BotMemoryCategory,
  BotMemoryItem,
  BotThread,
  PublicBot,
} from "../../../shared/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useLocale } from "../locale";
import { displayError } from "../state";
import {
  MEMORY_CATEGORY_OPTIONS,
  memoryCategoryLabel,
  splitMemoryItems,
} from "./bot-helpers";
import { runBotAction } from "./use-bots";

type CategoryFilter = "all" | BotMemoryCategory;

export function BotMemoryPanel({
  bot,
  activeThread,
  onBotsUpdated,
  onOpenMarkdownInspector,
}: {
  bot: PublicBot;
  activeThread?: BotThread | undefined;
  onBotsUpdated: (bots: PublicBot[]) => void;
  onOpenMarkdownInspector: () => void;
}) {
  const { t } = useLocale();
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [newCategory, setNewCategory] = useState<BotMemoryCategory>("preference");
  const [newContent, setNewContent] = useState("");
  const [newPinned, setNewPinned] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [editCategory, setEditCategory] = useState<BotMemoryCategory>("fact");
  const [editContent, setEditContent] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);

  const { active, archived } = useMemo(
    () => splitMemoryItems(bot.memoryItems),
    [bot.memoryItems],
  );

  const filteredActive = useMemo(() => {
    const q = query.trim().toLowerCase();
    return active.filter((item) => {
      if (categoryFilter !== "all" && item.category !== categoryFilter) return false;
      if (!q) return true;
      return item.content.toLowerCase().includes(q);
    });
  }, [active, categoryFilter, query]);

  const handleAdd = async () => {
    const clean = newContent.trim();
    if (!clean || adding) return;
    setAdding(true);
    setError(undefined);
    try {
      const res = await runBotAction({
        kind: "memory.item.add",
        botId: bot.id,
        category: newCategory,
        content: clean,
        scope: "global",
        pinned: newPinned,
        source: "manual",
      });
      if (res.bots) onBotsUpdated(res.bots);
      setNewContent("");
      setNewPinned(false);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setAdding(false);
    }
  };

  const togglePin = async (item: BotMemoryItem) => {
    if (busyId) return;
    setBusyId(item.id);
    setError(undefined);
    try {
      const res = await runBotAction({
        kind: "memory.item.update",
        botId: bot.id,
        itemId: item.id,
        category: null,
        content: null,
        pinned: !item.pinned,
      });
      if (res.bots) onBotsUpdated(res.bots);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusyId(undefined);
    }
  };

  const saveEdit = async (item: BotMemoryItem) => {
    const clean = editContent.trim();
    if (!clean || busyId) return;
    setBusyId(item.id);
    setError(undefined);
    try {
      const res = await runBotAction({
        kind: "memory.item.update",
        botId: bot.id,
        itemId: item.id,
        category: editCategory,
        content: clean,
        pinned: null,
      });
      if (res.bots) onBotsUpdated(res.bots);
      setEditingId(undefined);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusyId(undefined);
    }
  };

  const softDelete = async (itemId: string) => {
    if (busyId) return;
    setBusyId(itemId);
    setError(undefined);
    try {
      const res = await runBotAction({
        kind: "memory.item.delete",
        botId: bot.id,
        itemId,
      });
      if (res.bots) onBotsUpdated(res.bots);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusyId(undefined);
    }
  };

  const restoreItem = async (itemId: string) => {
    if (busyId) return;
    setBusyId(itemId);
    setError(undefined);
    try {
      const res = await runBotAction({
        kind: "memory.item.restore",
        botId: bot.id,
        itemId,
      });
      if (res.bots) onBotsUpdated(res.bots);
    } catch (reason) {
      setError(displayError(reason));
    } finally {
      setBusyId(undefined);
    }
  };

  return (
    <div className="bot-panel-scroll" data-testid="bot-memory-panel">
      <div className="bot-panel-header">
        <div className="grid gap-1">
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
            <Brain className="size-4 text-primary" />
            <span>{t("关于你 · 主动长期记忆", "About You · Active Memory")}</span>
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Bot 在桌面与手机 App 每次对话都会自动注入以下记忆卡片，并可在对话中主动记住你的偏好（支持随时编辑与撤销）。",
              "Automatically injected into Desktop & Mobile chats. Pin, edit, or undo anytime.",
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onOpenMarkdownInspector}>
          <FileText data-icon="inline-start" />
          {activeThread?.feishuChatId
            ? t("分层 Markdown 文档", "Scoped Markdown")
            : t("高级文档视图 (Markdown)", "Markdown View")}
        </Button>
      </div>

      {/* Quick Add Bar */}
      <div className="bot-memory-add-box">
        <div className="flex flex-wrap items-center gap-2">
          <NativeSelect
            aria-label={t("记忆分类", "Memory category")}
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value as BotMemoryCategory)}
            className="w-32"
          >
            {MEMORY_CATEGORY_OPTIONS.map((opt) => (
              <NativeSelectOption key={opt.value} value={opt.value}>
                {t(opt.zh, opt.en)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Input
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void handleAdd();
              }
            }}
            placeholder={t(
              "添加一条想让 Bot 永远记住的事实或偏好，例如：回答先给结论…",
              "Add a durable fact or preference for the Bot to remember…",
            )}
            className="flex-1 min-w-52"
          />
          <Button
            variant={newPinned ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={newPinned}
            onClick={() => setNewPinned((prev) => !prev)}
          >
            <Pin data-icon="inline-start" />
            {t("置顶", "Pin")}
          </Button>
          <Button size="sm" disabled={adding || !newContent.trim()} onClick={() => void handleAdd()}>
            {adding ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
            {t("记住", "Save")}
          </Button>
        </div>
      </div>

      {/* Filter & Search */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label={t("记忆分类筛选", "Filter memories")}>
          <button
            type="button"
            data-slot="bot-control"
            className="bot-conv-filter-btn"
            data-active={categoryFilter === "all"}
            onClick={() => setCategoryFilter("all")}
          >
            {t("全部", "All")} ({active.length})
          </button>
          {MEMORY_CATEGORY_OPTIONS.map((opt) => {
            const count = active.filter((it) => it.category === opt.value).length;
            return (
              <button
                key={opt.value}
                type="button"
                data-slot="bot-control"
                className="bot-conv-filter-btn"
                data-active={categoryFilter === opt.value}
                onClick={() => setCategoryFilter(opt.value)}
              >
                {t(opt.zh, opt.en)} ({count})
              </button>
            );
          })}
        </div>

        <div className="relative w-56">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("搜索记忆内容…", "Search memories…")}
            className="h-8 pl-7.5 text-xs"
          />
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {filteredActive.length === 0 ? (
        <div className="bot-panel-empty">
          <Brain className="size-7 text-muted-foreground/60" />
          <div className="grid gap-1 text-center max-w-md">
            <strong className="text-sm">
              {active.length === 0
                ? t("还没有结构化记忆卡片", "No memory cards yet")
                : t("当前筛选下没有匹配记忆", "No matching memories")}
            </strong>
            <span className="text-xs text-muted-foreground">
              {t(
                "在上方输入框添加你的个人偏好或规则，或直接与 Bot 对话让它自动沉淀。",
                "Add preferences above, or chat naturally so your Bot remembers them automatically.",
              )}
            </span>
          </div>
        </div>
      ) : (
        <div className="bot-card-grid">
          {filteredActive.map((item) => {
            const busy = busyId === item.id;
            const isEditing = editingId === item.id;
            return (
              <article key={item.id} className="bot-memory-card" data-pinned={item.pinned}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" className="h-4.5 px-1.5 text-[10px]">
                      {memoryCategoryLabel(item.category, t)}
                    </Badge>
                    <Badge variant="outline" className="h-4.5 px-1.5 text-[10px]">
                      {item.source === "auto" ? t("自动记住", "Auto") : t("手动", "Manual")}
                    </Badge>
                    {item.pinned && (
                      <Badge className="h-4.5 px-1.5 text-[10px]">
                        {t("置顶", "Pinned")}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={busy}
                      title={item.pinned ? t("取消置顶", "Unpin") : t("置顶优先注入", "Pin")}
                      onClick={() => void togglePin(item)}
                    >
                      {item.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={busy}
                      title={t("编辑", "Edit")}
                      onClick={() => {
                        setEditingId(item.id);
                        setEditCategory(item.category);
                        setEditContent(item.content);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-destructive hover:text-destructive"
                      disabled={busy}
                      title={t("移除（可撤销）", "Delete (undoable)")}
                      onClick={() => void softDelete(item.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>

                {isEditing ? (
                  <div className="grid gap-2 pt-1">
                    <NativeSelect
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value as BotMemoryCategory)}
                    >
                      {MEMORY_CATEGORY_OPTIONS.map((opt) => (
                        <NativeSelectOption key={opt.value} value={opt.value}>
                          {t(opt.zh, opt.en)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    <Textarea
                      rows={2}
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                    />
                    <div className="flex justify-end gap-1.5">
                      <Button variant="ghost" size="xs" onClick={() => setEditingId(undefined)}>
                        <X className="size-3" />
                        {t("取消", "Cancel")}
                      </Button>
                      <Button size="xs" disabled={busy || !editContent.trim()} onClick={() => void saveEdit(item)}>
                        <Check className="size-3" />
                        {t("保存", "Save")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs leading-relaxed text-foreground">{item.content}</p>
                )}
              </article>
            );
          })}
        </div>
      )}

      {archived.length > 0 && (
        <div className="bot-memory-archived-strip">
          <div className="flex items-center justify-between">
            <strong className="text-xs text-muted-foreground">
              {t(`最近移除的记忆 (${archived.length} · 支持撤销恢复)`, `Recently removed (${archived.length})`)}
            </strong>
          </div>
          <div className="grid gap-1.5">
            {archived.slice(0, 5).map((item) => (
              <div key={item.id} className="bot-memory-archived-row">
                <span className="truncate text-xs text-muted-foreground">
                  [{memoryCategoryLabel(item.category, t)}] {item.content}
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={busyId === item.id}
                  onClick={() => void restoreItem(item.id)}
                >
                  <RotateCcw className="size-3" />
                  {t("恢复", "Restore")}
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
