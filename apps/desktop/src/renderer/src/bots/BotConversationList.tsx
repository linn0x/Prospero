import { useMemo, useState } from "react";
import {
  MessageSquare,
  MessageSquarePlus,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react";
import type {
  BotFeishuAdmin,
  BotThread,
  BotThreadChannel,
  SessionInfo,
} from "../../../shared/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { stripInjectedMemoryContext } from "../ChatPane";
import { useLocale } from "../locale";

type ChannelFilter = "all" | BotThreadChannel;

function formatRelativeTime(
  ts: number,
  t: (zh: string, en: string) => string,
): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 60) return t("刚刚", "Just now");
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return t(`${deltaMin}分钟前`, `${deltaMin}m`);
  const date = new Date(ts);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function channelTagLabel(
  channel: BotThreadChannel,
  t: (zh: string, en: string) => string,
): string {
  switch (channel) {
    case "feishu_group":
      return t("飞书群", "Group");
    case "feishu_p2p":
      return t("飞书私聊", "DM");
    case "desktop":
      return t("桌面", "Desktop");
  }
}

function ChannelAvatar({
  channel,
  running,
}: {
  channel: BotThreadChannel;
  running: boolean;
}) {
  return (
    <div className="bot-conv-avatar" data-channel={channel}>
      {channel === "feishu_group" ? (
        <Users className="size-4" />
      ) : channel === "feishu_p2p" ? (
        <UserRound className="size-4" />
      ) : (
        <MessageSquare className="size-4" />
      )}
      {running && <span className="bot-conv-dot-running" aria-hidden="true" />}
    </div>
  );
}

export function BotConversationList({
  botId,
  threads,
  sessions,
  adminUsers,
  activeThreadId,
  creatingThread,
  onSelectThread,
  onNewThread,
  onArchiveThread,
}: {
  botId: string;
  threads: BotThread[];
  sessions: SessionInfo[];
  adminUsers: BotFeishuAdmin[];
  activeThreadId: string | undefined;
  creatingThread: boolean;
  onSelectThread: (botId: string, threadId: string) => void;
  onNewThread: () => void;
  onArchiveThread: (botId: string, threadId: string) => void;
}) {
  const { t } = useLocale();
  const [filter, setFilter] = useState<ChannelFilter>("all");
  const [query, setQuery] = useState("");

  const sessionMap = useMemo(() => {
    const map = new Map<string, SessionInfo>();
    for (const s of sessions) map.set(s.id, s);
    return map;
  }, [sessions]);

  const adminSet = useMemo(
    () => new Set(adminUsers.map((admin) => admin.openId)),
    [adminUsers],
  );

  const counts = useMemo(() => {
    let feishuGroup = 0;
    let feishuP2p = 0;
    let desktop = 0;
    for (const thread of threads) {
      if (thread.channel === "feishu_group") feishuGroup += 1;
      else if (thread.channel === "feishu_p2p") feishuP2p += 1;
      else desktop += 1;
    }
    return {
      all: threads.length,
      feishu_group: feishuGroup,
      feishu_p2p: feishuP2p,
      desktop,
    };
  }, [threads]);

  const sortedAndFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...threads]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((thread) => {
        if (filter !== "all" && thread.channel !== filter) return false;
        if (!q) return true;
        return [
          thread.chatName ?? "",
          thread.title,
          thread.lastSenderName ?? "",
          thread.lastSenderId ?? "",
          thread.lastMessagePreview ?? "",
          thread.feishuChatId ?? "",
        ].some((field) => field.toLowerCase().includes(q));
      });
  }, [filter, query, threads]);

  return (
    <aside className="bot-conv-sidebar" aria-label={t("IM 会话列表", "IM Conversations")}>
      <div className="bot-conv-header">
        <div className="flex items-center gap-1.5 min-w-0">
          <strong className="text-xs font-semibold text-foreground truncate">
            {t("会话列表", "Conversations")}
          </strong>
          <span className="bot-conv-count-pill">{threads.length}</span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          disabled={creatingThread}
          onClick={onNewThread}
        >
          {creatingThread ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <MessageSquarePlus data-icon="inline-start" />
          )}
          {t("新话题", "New")}
        </Button>
      </div>

      <div className="px-2.5 pb-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("搜索群名、成员或消息…", "Search group, sender, message...")}
            className="bot-conv-search-input h-7.5 pl-7.5 pr-7 text-xs"
          />
          {query && (
            <button
              type="button"
              data-slot="bot-control"
              className="bot-conv-search-clear"
              aria-label={t("清空搜索", "Clear search")}
              onClick={() => setQuery("")}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      <div className="bot-conv-filters" role="tablist" aria-label={t("会话渠道筛选", "Channel filter")}>
        {(
          [
            ["all", t("全部", "All"), counts.all],
            ["feishu_group", t("飞书群", "Groups"), counts.feishu_group],
            ["feishu_p2p", t("飞书私聊", "DMs"), counts.feishu_p2p],
            ["desktop", t("桌面", "Desktop"), counts.desktop],
          ] as const
        ).map(([channelId, label, count]) => (
          <button
            key={channelId}
            type="button"
            role="tab"
            data-slot="bot-control"
            aria-selected={filter === channelId}
            className="bot-conv-filter-btn"
            data-active={filter === channelId}
            onClick={() => setFilter(channelId)}
          >
            <span>{label}</span>
            <span className="opacity-70 tabular-nums">{count}</span>
          </button>
        ))}
      </div>

      <div className="bot-conv-list">
        {sortedAndFiltered.length === 0 ? (
          <div className="m-2 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground leading-relaxed">
            {threads.length === 0
              ? t(
                  "暂无对话。在右侧发送消息或从飞书发起对话，将自动出现在此列表中。",
                  "No conversations yet. Start chatting here or via Feishu.",
                )
              : t("当前筛选下暂无匹配会话。", "No conversations match your filter.")}
          </div>
        ) : (
          sortedAndFiltered.map((thread) => {
            const liveSession = sessionMap.get(thread.sessionId);
            const running = liveSession?.status === "running";
            const primaryTitle = thread.chatName?.trim() || thread.title;
            const speaker = thread.lastSenderName?.trim() || thread.lastSenderId?.trim() || "";
            const isSpeakerAdmin = Boolean(thread.lastSenderId && adminSet.has(thread.lastSenderId));
            const rawPreview =
              thread.lastMessagePreview?.trim() ||
              (liveSession?.preview ? stripInjectedMemoryContext(liveSession.preview) : "") ||
              thread.title;
            const timeLabel = formatRelativeTime(thread.updatedAt, t);
            const active = thread.id === activeThreadId;

            return (
              <div
                key={thread.id}
                className="bot-conv-item group/conv"
                data-selected={active}
              >
                <button
                  type="button"
                  data-slot="bot-control"
                  className="bot-conv-item-btn"
                  aria-current={active ? "page" : undefined}
                  onClick={() => onSelectThread(botId, thread.id)}
                >
                  <ChannelAvatar channel={thread.channel} running={running} />
                  <div className="min-w-0 flex-1 grid gap-0.5">
                    <div className="flex items-center justify-between gap-1.5 min-w-0">
                      <span className="truncate text-xs font-semibold text-foreground">
                        {primaryTitle}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                        {timeLabel}
                      </span>
                    </div>

                    <div className="flex items-center gap-1 min-w-0 text-[11px] text-muted-foreground">
                      <span
                        className="bot-thread-channel"
                        data-channel={thread.channel}
                      >
                        {channelTagLabel(thread.channel, t)}
                      </span>
                      {speaker && (
                        <span className="inline-flex items-center gap-0.5 truncate text-foreground/80">
                          {isSpeakerAdmin && (
                            <ShieldCheck
                              className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400"
                              aria-label={t("管理员", "Admin")}
                            />
                          )}
                          <span className="truncate">{speaker}</span>
                        </span>
                      )}
                      {thread.messageCount > 0 && (
                        <span className="bot-conv-msg-count ml-auto shrink-0 text-[10px] tabular-nums">
                          {t(`${thread.messageCount}条`, `${thread.messageCount}`)}
                        </span>
                      )}
                    </div>

                    <div className="line-clamp-1 text-[11px] text-muted-foreground/90">
                      {rawPreview}
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  data-slot="bot-control"
                  className="bot-conv-delete"
                  aria-label={t("删除对话", "Delete conversation")}
                  title={t("删除对话", "Delete conversation")}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onArchiveThread(botId, thread.id);
                  }}
                >
                  <Trash2 className="size-3" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
