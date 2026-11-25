import { memo, useMemo, useState, type ReactNode, type RefObject, type UIEvent } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FileImage,
  Search,
  ShieldCheck,
  UserRound,
  Users,
  Wrench,
} from "lucide-react";
import type { JsonObject } from "../../../shared/types";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import {
  CHAT_TIMELINE_WINDOW_SIZE,
  getChatTimelineItemWindow,
  hasChatResolution,
  type ChatHistoryCursor,
  type ChatTimelineItem,
} from "../chat-events";
import { MarkdownContent } from "../chat/MarkdownContent";
import { useLocale } from "../locale";
import { array, number, record, text } from "../state";

const FEISHU_GROUP_HEADER_RE =
  /^\[飞书群聊:\s*(.+?)\s*\|\s*发言人:\s*(.+?)(?:\s*\(([^()]+)\))?\]\s*(?:\n([\s\S]*))?$/;
const FEISHU_DM_HEADER_RE =
  /^\[飞书私聊\s*\|\s*发言人:\s*(.+?)(?:\s*\(([^()]+)\))?\]\s*(?:\n([\s\S]*))?$/;

export function stripInjectedMemoryContext(raw: string): string {
  return raw.replace(/\n*<prospero_memory_context>[\s\S]*?(?:<\/prospero_memory_context>|$)\s*/g, "").trim();
}

export type ParsedBotQuestion = {
  channel: "feishu_group" | "feishu_p2p" | "desktop";
  chatName?: string | undefined;
  speaker?: string | undefined;
  roleLabel?: string | undefined;
  isAdmin: boolean;
  body: string;
};

export function parseBotQuestionMessage(raw: string): ParsedBotQuestion {
  const stripped = stripInjectedMemoryContext(raw);
  const groupMatch = FEISHU_GROUP_HEADER_RE.exec(stripped);
  if (groupMatch) {
    const roleLabel = groupMatch[3]?.trim() || undefined;
    return {
      channel: "feishu_group",
      chatName: groupMatch[1]?.trim() || undefined,
      speaker: groupMatch[2]?.trim() || undefined,
      roleLabel,
      isAdmin: roleLabel === "管理员",
      body: (groupMatch[4] ?? "").trim(),
    };
  }
  const dmMatch = FEISHU_DM_HEADER_RE.exec(stripped);
  if (dmMatch) {
    const roleLabel = dmMatch[2]?.trim() || undefined;
    return {
      channel: "feishu_p2p",
      speaker: dmMatch[1]?.trim() || undefined,
      roleLabel,
      isAdmin: roleLabel === "管理员",
      body: (dmMatch[3] ?? "").trim(),
    };
  }
  return {
    channel: "desktop",
    isAdmin: false,
    body: stripped,
  };
}

export function formatBotSpeakerDisplay(
  rawSpeaker: string | undefined,
  isAdmin: boolean,
  speakerNames?: Readonly<Record<string, string>>,
  t?: (zh: string, en: string) => string,
): { label: string; title?: string; showAdminBadge: boolean } {
  const translate = t ?? ((zh: string) => zh);
  const clean = rawSpeaker?.trim();
  if (!clean) {
    return { label: translate("你", "You"), showAdminBadge: isAdmin };
  }
  const resolved = speakerNames?.[clean]?.trim();
  if (resolved) {
    return { label: resolved, title: clean, showAdminBadge: isAdmin };
  }
  if (clean.startsWith("ou_") && clean.length > 14) {
    const shortId = `${clean.slice(0, 7)}…${clean.slice(-4)}`;
    if (isAdmin) {
      return {
        label: translate("管理员", "Admin"),
        title: `${shortId} (${clean})`,
        showAdminBadge: false,
      };
    }
    return { label: shortId, title: clean, showAdminBadge: false };
  }
  return { label: clean, showAdminBadge: isAdmin };
}

export type BotQaEntry = {
  key: string;
  index: number;
  ordinal: number;
  question: ParsedBotQuestion;
  followUpUsers: Array<{ key: string; parsed: ParsedBotQuestion; attachments: JsonObject[] }>;
  attachments: JsonObject[];
  questionHasMore: boolean;
  questionBodyRecordId: string;
  hasUserPrompt: boolean;
  answers: JsonObject[];
  answerIsFallback: boolean;
  extraOutcomes: JsonObject[];
  activity: JsonObject[];
  reasoningCount: number;
  toolCount: number;
  completed: boolean;
  finish: string;
  outputTokens: number;
  liveStatus: string;
};

function deriveLiveStatus(activity: readonly JsonObject[], t?: (zh: string, en: string) => string): string {
  const translate = t ?? ((zh: string) => zh);
  const last = activity.at(-1);
  if (!last) return translate("正在思考与生成回答…", "Thinking and drafting answer…");
  const kind = text(last.kind);
  if (kind === "tool.start") {
    const toolName = text(last.tool, translate("工具", "tool"));
    return translate(`正在调用工具：${toolName}`, `Running tool: ${toolName}`);
  }
  if (kind === "reasoning") {
    return translate("正在深度思考…", "Reasoning…");
  }
  if (kind.startsWith("subagent.")) {
    return translate("正在协调子任务…", "Coordinating subtask…");
  }
  return translate("正在生成回答…", "Drafting answer…");
}

export function extractBotQaEntries(displayItems: readonly ChatTimelineItem[]): BotQaEntry[] {
  return displayItems.map((item, idx) => {
    const event = item.event;
    const kind = text(event.kind);

    if (kind === "conversation.turn") {
      const users = array(event.users).map(record);
      const activity = array(event.activity).map(record);
      const outcomes = array(event.outcomes).map(record);

      const primaryUser = users[0];
      const rawPrimaryText = text(primaryUser?.text);
      const question = parseBotQuestionMessage(rawPrimaryText);
      const attachments = array(primaryUser?.attachments).map(record);
      const followUpUsers = users.slice(1).map((u, fIdx) => ({
        key: text(u.displayKey, `${item.key}:follow:${String(fIdx)}`),
        parsed: parseBotQuestionMessage(text(u.text)),
        attachments: array(u.attachments).map(record),
      }));

      const outcomeAnswers = outcomes.filter(
        (entry) => text(entry.kind) === "assistant.text" && text(entry.text).trim().length > 0,
      );
      const fallbackAnswer =
        outcomeAnswers.length === 0
          ? activity.findLast(
              (entry) => text(entry.kind) === "assistant.text" && text(entry.text).trim().length > 0,
            )
          : undefined;
      const answers = outcomeAnswers.length > 0 ? outcomeAnswers : fallbackAnswer ? [fallbackAnswer] : [];
      const answerIsFallback = outcomeAnswers.length === 0 && Boolean(fallbackAnswer);
      const extraOutcomes = outcomes.filter((entry) => text(entry.kind) !== "assistant.text");

      let reasoningCount = 0;
      let toolCount = 0;
      for (const act of activity) {
        const actKind = text(act.kind);
        if (actKind === "reasoning") reasoningCount += 1;
        else if (actKind === "tool.start" || actKind === "tool.end") toolCount += 1;
      }

      const completed = event.completed === true;
      return {
        key: item.key,
        index: idx + 1,
        ordinal: item.ordinal,
        question,
        followUpUsers,
        attachments,
        questionHasMore:
          primaryUser?.hasMore === true && !rawPrimaryText.includes("<prospero_memory_context>"),
        questionBodyRecordId: text(primaryUser?.bodyRecordId),
        hasUserPrompt: users.length > 0,
        answers,
        answerIsFallback,
        extraOutcomes,
        activity,
        reasoningCount,
        toolCount,
        completed,
        finish: text(event.finish),
        outputTokens: number(event.outputTokens),
        liveStatus: completed ? "" : deriveLiveStatus(activity),
      };
    }

    if (kind === "user.message") {
      const rawUserText = text(event.text);
      return {
        key: item.key,
        index: idx + 1,
        ordinal: item.ordinal,
        question: parseBotQuestionMessage(rawUserText),
        followUpUsers: [],
        attachments: array(event.attachments).map(record),
        questionHasMore:
          event.hasMore === true && !rawUserText.includes("<prospero_memory_context>"),
        questionBodyRecordId: text(event.bodyRecordId),
        hasUserPrompt: true,
        answers: [],
        answerIsFallback: false,
        extraOutcomes: [],
        activity: [],
        reasoningCount: 0,
        toolCount: 0,
        completed: true,
        finish: "",
        outputTokens: 0,
        liveStatus: "",
      };
    }

    if (kind === "assistant.text") {
      return {
        key: item.key,
        index: idx + 1,
        ordinal: item.ordinal,
        question: { channel: "desktop", isAdmin: false, body: "" },
        followUpUsers: [],
        attachments: [],
        questionHasMore: false,
        questionBodyRecordId: "",
        hasUserPrompt: false,
        answers: [event],
        answerIsFallback: false,
        extraOutcomes: [],
        activity: [],
        reasoningCount: 0,
        toolCount: 0,
        completed: true,
        finish: "completed",
        outputTokens: 0,
        liveStatus: "",
      };
    }

    return {
      key: item.key,
      index: idx + 1,
      ordinal: item.ordinal,
      question: { channel: "desktop", isAdmin: false, body: "" },
      followUpUsers: [],
      attachments: [],
      questionHasMore: false,
      questionBodyRecordId: "",
      hasUserPrompt: false,
      answers: [],
      answerIsFallback: false,
      extraOutcomes: kind === "turn.end" ? [] : [event],
      activity: [],
      reasoningCount: 0,
      toolCount: 0,
      completed: true,
      finish: text(event.finish),
      outputTokens: number(event.outputTokens),
      liveStatus: "",
    };
  });
}

export function filterBotQaEntries(entries: readonly BotQaEntry[], query: string): BotQaEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter((entry) => {
    const fields = [
      entry.question.speaker ?? "",
      entry.question.chatName ?? "",
      entry.question.body,
      ...entry.followUpUsers.map((u) => u.parsed.body),
      ...entry.answers.map((ans) => text(ans.text)),
    ];
    return fields.some((field) => field.toLowerCase().includes(needle));
  });
}

function AttachmentList({
  attachments,
  t,
}: {
  attachments: readonly JsonObject[];
  t: (zh: string, en: string) => string;
}) {
  if (!attachments.length) return null;
  return (
    <AttachmentGroup className="mt-2">
      {attachments.map((attachment, index) => (
        <Attachment state="done" size="sm" key={text(attachment.id, String(index))}>
          <AttachmentMedia>
            <FileImage />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>
              {text(attachment.name, t(`图片 ${String(index + 1)}`, `Image ${String(index + 1)}`))}
            </AttachmentTitle>
            <AttachmentDescription>{text(attachment.mimeType, t("图片", "Image"))}</AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      ))}
    </AttachmentGroup>
  );
}

const PROCESS_HISTORY_LIMIT = 120;

const BotQaTableRow = memo(function BotQaTableRow({
  entry,
  speakerNames,
  resolutions,
  onError,
  openOutput,
  renderActivityEvent,
  renderOutcomeEvent,
}: {
  entry: BotQaEntry;
  speakerNames?: Readonly<Record<string, string>> | undefined;
  resolutions: ReadonlySet<string>;
  onError: (message?: string) => void;
  openOutput: (id: string, tool: string) => void;
  renderActivityEvent: (entry: JsonObject, completed: boolean) => ReactNode;
  renderOutcomeEvent: (entry: JsonObject, completed: boolean, isResolved: boolean) => ReactNode;
}) {
  const { t } = useLocale();
  const [processOpen, setProcessOpen] = useState(false);
  const [activityLimit, setActivityLimit] = useState(PROCESS_HISTORY_LIMIT);
  const [copied, setCopied] = useState(false);

  const failed = ["failed", "error"].includes(entry.finish);
  const stopped = ["interrupted", "cancelled", "canceled"].includes(entry.finish);
  const combinedAnswerText = useMemo(
    () =>
      entry.answers
        .map((ans) => text(ans.text).trim())
        .filter(Boolean)
        .join("\n\n"),
    [entry.answers],
  );

  const copyAnswer = async (): Promise<void> => {
    if (!combinedAnswerText) return;
    try {
      await window.prospero?.writeClipboard(combinedAnswerText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  const processSummaryParts: string[] = [];
  if (entry.reasoningCount > 0) {
    processSummaryParts.push(t(`思考 ${entry.reasoningCount}`, `${entry.reasoningCount} reasoning`));
  }
  if (entry.toolCount > 0) {
    processSummaryParts.push(t(`工具 ${entry.toolCount}`, `${entry.toolCount} tools`));
  }
  const otherActivity = Math.max(0, entry.activity.length - entry.reasoningCount - entry.toolCount);
  if (otherActivity > 0 && processSummaryParts.length === 0) {
    processSummaryParts.push(t(`${entry.activity.length} 步`, `${entry.activity.length} steps`));
  }
  const processSummary =
    processSummaryParts.length > 0
      ? processSummaryParts.join(" · ")
      : t(`${entry.activity.length} 步`, `${entry.activity.length} steps`);

  const liveHint = entry.completed ? "" : deriveLiveStatus(entry.activity, t);
  const speakerDisplay = formatBotSpeakerDisplay(
    entry.question.speaker,
    entry.question.isAdmin,
    speakerNames,
    t,
  );
  const channelBadgeText =
    entry.question.channel === "feishu_group"
      ? entry.question.chatName
        ? t(`飞书群 · ${entry.question.chatName}`, `Group · ${entry.question.chatName}`)
        : t("飞书群", "Feishu Group")
      : entry.question.channel === "feishu_p2p"
        ? t("飞书私聊", "Feishu DM")
        : t("桌面端", "Desktop");

  return (
    <article
      className="bot-qa-row-wrapper"
      data-completed={entry.completed ? "true" : "false"}
      data-failed={failed ? "true" : undefined}
      data-testid="bot-qa-item"
    >
      <div className="bot-qa-table-row" role="row">
        <div className="bot-qa-cell" role="cell" data-col="index">
          <span className="bot-qa-index">#{entry.index}</span>
          <span
            className="bot-qa-row-dot"
            data-state={!entry.completed ? "running" : failed ? "failed" : stopped ? "stopped" : "done"}
            aria-hidden="true"
          />
        </div>

        <div className="bot-qa-cell" role="cell" data-col="question">
          <div className="bot-qa-cell-speaker">
            <span className="bot-qa-speaker-icon" aria-hidden="true">
              {entry.question.channel === "feishu_group" ? (
                <Users className="size-3" />
              ) : (
                <UserRound className="size-3" />
              )}
            </span>
            <span className="truncate font-medium text-foreground/85" title={speakerDisplay.title}>
              {speakerDisplay.label}
            </span>
            {speakerDisplay.showAdminBadge && (
              <Badge
                variant="secondary"
                className="h-4 shrink-0 gap-0.5 border border-emerald-500/25 bg-emerald-500/12 px-1.5 text-[10px] text-emerald-700 dark:text-emerald-300"
              >
                <ShieldCheck className="size-2.5" />
                {t("管理员", "Admin")}
              </Badge>
            )}
          </div>

          <div className="bot-qa-body">
            {entry.question.body ? (
              <MarkdownContent value={entry.question.body} onError={onError} streaming={false} />
            ) : entry.attachments.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">
                {entry.hasUserPrompt ? t("（空消息）", "(Empty message)") : t("（系统续接回复）", "(Continued turn)")}
              </p>
            ) : null}

            <AttachmentList attachments={entry.attachments} t={t} />

            {entry.followUpUsers.length > 0 && (
              <div className="mt-2.5 grid gap-2 border-t border-border/60 pt-2">
                {entry.followUpUsers.map((followUp) => {
                  const followSpeaker = formatBotSpeakerDisplay(
                    followUp.parsed.speaker,
                    followUp.parsed.isAdmin,
                    speakerNames,
                    t,
                  );
                  return (
                    <div key={followUp.key} className="grid gap-1">
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
                          {t("补充", "Follow-up")}
                        </Badge>
                        {followUp.parsed.speaker && (
                          <span className="truncate" title={followSpeaker.title}>
                            {followSpeaker.label}
                          </span>
                        )}
                      </div>
                      {followUp.parsed.body && (
                        <MarkdownContent value={followUp.parsed.body} onError={onError} streaming={false} />
                      )}
                      <AttachmentList attachments={followUp.attachments} t={t} />
                    </div>
                  );
                })}
              </div>
            )}

            {entry.questionHasMore && entry.questionBodyRecordId && (
              <div className="mt-2">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => openOutput(entry.questionBodyRecordId, t("完整提问", "Full question"))}
                >
                  <ExternalLink data-icon="inline-start" />
                  {t("查看完整提问", "Read full question")}
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="bot-qa-cell" role="cell" data-col="answer">
          <div className="bot-qa-body">
            {entry.answerIsFallback && !entry.completed && (
              <div className="mb-1.5">
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                  {t("实时回复", "Live")}
                </Badge>
              </div>
            )}
            {entry.answers.length > 0 ? (
              <div className="grid gap-3">
                {entry.answers.map((ans, ansIdx) => {
                  const ansBodyId = text(ans.bodyRecordId);
                  return (
                    <div key={text(ans.displayKey, `${entry.key}:ans:${String(ansIdx)}`)} className="grid gap-2">
                      <MarkdownContent
                        value={text(ans.text)}
                        onError={onError}
                        streaming={!entry.completed}
                      />
                      {ans.hasMore === true && ansBodyId && (
                        <div>
                          <Button
                            variant="outline"
                            size="xs"
                            onClick={() => openOutput(ansBodyId, t("完整答复", "Full answer"))}
                          >
                            <ExternalLink data-icon="inline-start" />
                            {t("查看完整答复", "Read full answer")}
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : !entry.completed ? (
              <div className="bot-qa-live-status" role="status">
                <Spinner className="size-3.5" />
                <span>{liveHint || entry.liveStatus}</span>
              </div>
            ) : entry.extraOutcomes.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {failed
                  ? t("本轮运行失败，未生成文本答复。", "This turn failed without a text answer.")
                  : stopped
                    ? t("本轮已停止，未生成文本答复。", "This turn stopped without a text answer.")
                    : t("本轮已完成，未生成文本答复。", "This turn completed without a text answer.")}
              </p>
            ) : null}

            {entry.extraOutcomes.length > 0 && (
              <div className="mt-2.5 grid gap-2">
                {entry.extraOutcomes.map((outcome, outIdx) => {
                  const outcomeKind = text(outcome.kind);
                  const isResolved =
                    outcomeKind === "permission.request"
                      ? hasChatResolution(resolutions, "permission.resolved", text(outcome.reqId))
                      : outcomeKind === "question.request"
                        ? hasChatResolution(resolutions, "question.resolved", text(outcome.reqId))
                        : false;
                  return (
                    <div key={text(outcome.displayKey, `${entry.key}:out:${String(outIdx)}`)}>
                      {renderOutcomeEvent(outcome, entry.completed, isResolved)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="bot-qa-cell" role="cell" data-col="meta">
          <div className="bot-qa-meta-stack">
            <div className="bot-qa-meta-status">
              {!entry.completed ? (
                <span className="bot-qa-status-pill" data-state="running">
                  <Spinner className="size-3" />
                  <span>{t("处理中", "Running")}</span>
                </span>
              ) : failed ? (
                <span className="bot-qa-status-pill" data-state="failed">
                  <span className="bot-qa-row-dot" data-state="failed" aria-hidden="true" />
                  <span>{t("失败", "Failed")}</span>
                </span>
              ) : stopped ? (
                <span className="bot-qa-status-pill" data-state="stopped">
                  <span className="bot-qa-row-dot" data-state="stopped" aria-hidden="true" />
                  <span>{t("已停止", "Stopped")}</span>
                </span>
              ) : (
                <span className="bot-qa-status-pill" data-state="done">
                  <span className="bot-qa-row-dot" data-state="done" aria-hidden="true" />
                  <span>{t("已完成", "Done")}</span>
                </span>
              )}
              <span className="bot-qa-meta-channel truncate" title={channelBadgeText}>
                {channelBadgeText}
              </span>
            </div>

            {(entry.activity.length > 0 || entry.outputTokens > 0) && (
              <div className="bot-qa-meta-stats">
                {entry.activity.length > 0 && <span>{processSummary}</span>}
                {entry.outputTokens > 0 && (
                  <span className="font-mono">{String(entry.outputTokens)} tokens</span>
                )}
              </div>
            )}

            {(entry.activity.length > 0 || combinedAnswerText) && (
              <div className="bot-qa-meta-actions">
                {entry.activity.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="h-6 px-2 text-[11px]"
                    aria-expanded={processOpen}
                    onClick={() => setProcessOpen((prev) => !prev)}
                  >
                    <Wrench className="size-3 text-muted-foreground" />
                    <span>{processOpen ? t("收起过程", "Hide") : t("过程", "Process")}</span>
                    <ChevronDown
                      className={`size-3 transition-transform duration-150 ${processOpen ? "rotate-180" : ""}`}
                    />
                  </Button>
                )}
                {combinedAnswerText && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                    onClick={() => void copyAnswer()}
                  >
                    {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                    <span>{copied ? t("已复制", "Copied") : t("复制", "Copy")}</span>
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {processOpen && entry.activity.length > 0 && (
        <div className="bot-qa-row-process-drawer">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t(`思考与执行过程 (${processSummary})`, `Reasoning & tool trace (${processSummary})`)}
            </span>
            <Button type="button" variant="ghost" size="xs" onClick={() => setProcessOpen(false)}>
              {t("收起", "Collapse")}
            </Button>
          </div>
          <div className="bot-qa-process-body">
            {entry.activity.length > activityLimit && (
              <Button
                variant="ghost"
                size="xs"
                className="w-fit"
                onClick={() => setActivityLimit((prev) => prev + PROCESS_HISTORY_LIMIT)}
              >
                {t("查看更早过程", "Show earlier activity")}
              </Button>
            )}
            {entry.activity.slice(-activityLimit).map((act, actIdx) => (
              <div
                key={text(act.displayKey, `${entry.key}:act:${String(actIdx)}`)}
                className="bot-qa-process-entry"
              >
                {renderActivityEvent(act, entry.completed)}
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
});

export type BotQaListViewProps = {
  botName: string;
  botAvatar: string;
  botDescription?: string | undefined;
  speakerNames?: Readonly<Record<string, string>> | undefined;
  displayItems: readonly ChatTimelineItem[];
  resolutions: ReadonlySet<string>;
  nextOrdinal: number;
  pagedEnabled: boolean;
  pagedLive: boolean;
  historyCursor: ChatHistoryCursor | null;
  selectHistoryCursor: (cursor: ChatHistoryCursor | null) => void;
  jumpToLatest: () => void;
  handleTimelineScroll: (event: UIEvent<HTMLDivElement>) => void;
  timelineViewport: RefObject<HTMLDivElement | null>;
  searchQuery: string;
  onClearSearch: () => void;
  onError: (message?: string) => void;
  openOutput: (id: string, tool: string) => void;
  renderActivityEvent: (entry: JsonObject, completed: boolean) => ReactNode;
  renderOutcomeEvent: (entry: JsonObject, completed: boolean, isResolved: boolean) => ReactNode;
};

export const BotQaListView = memo(function BotQaListView({
  botName,
  botAvatar,
  botDescription,
  speakerNames,
  displayItems,
  resolutions,
  nextOrdinal,
  pagedEnabled,
  pagedLive,
  historyCursor,
  selectHistoryCursor,
  jumpToLatest,
  handleTimelineScroll,
  timelineViewport,
  searchQuery,
  onClearSearch,
  onError,
  openOutput,
  renderActivityEvent,
  renderOutcomeEvent,
}: BotQaListViewProps) {
  const { t } = useLocale();
  const normalizedQuery = searchQuery.trim();

  const allEntries = useMemo(() => extractBotQaEntries(displayItems), [displayItems]);
  const historyWindow = useMemo(
    () => getChatTimelineItemWindow(displayItems, nextOrdinal, historyCursor?.end ?? null),
    [displayItems, historyCursor?.end, nextOrdinal],
  );
  const visibleEntries = useMemo(() => {
    if (normalizedQuery) return filterBotQaEntries(allEntries, normalizedQuery);
    return allEntries.slice(historyWindow.start, historyWindow.end);
  }, [allEntries, historyWindow.end, historyWindow.start, normalizedQuery]);

  return (
    <MessageScrollerProvider autoScroll={historyCursor === null && (!pagedEnabled || pagedLive) && !normalizedQuery}>
      <MessageScroller>
        <MessageScrollerViewport
          ref={timelineViewport}
          onScroll={handleTimelineScroll}
          aria-label={t("问答列表", "Q&A table")}
        >
          <MessageScrollerContent className="w-full px-4 py-4">
            {!displayItems.length && (
              <Empty className="my-auto">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <span className="text-xl leading-none" aria-hidden="true">
                      {botAvatar || <Bot className="size-5" />}
                    </span>
                  </EmptyMedia>
                  <EmptyTitle>{botName}</EmptyTitle>
                  <EmptyDescription>
                    {botDescription ||
                      t(
                        "随时开始对话，重要偏好与长期信息会自动记住；每轮提问与回答会按问答列表清晰归档。",
                        "Start chatting anytime; each turn is organized here as a clean Q&A list.",
                      )}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}

            {displayItems.length > 0 && visibleEntries.length === 0 && normalizedQuery && (
              <Empty className="my-auto py-12">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Search className="size-4" />
                  </EmptyMedia>
                  <EmptyTitle>{t("没有匹配的问答记录", "No matching Q&A turns")}</EmptyTitle>
                  <EmptyDescription>
                    {t(`未在当前问答中找到包含 “${normalizedQuery}” 的提问或回答`, `No matches for "${normalizedQuery}".`)}
                  </EmptyDescription>
                </EmptyHeader>
                <Button variant="outline" size="sm" onClick={onClearSearch}>
                  {t("清空筛选", "Clear search")}
                </Button>
              </Empty>
            )}

            {!normalizedQuery && historyWindow.start > 0 && (
              <div className="flex justify-center">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => selectHistoryCursor({ end: historyWindow.cursorStart, mode: "page" })}
                >
                  <ChevronDown className="rotate-180" data-icon="inline-start" />
                  {t(
                    `查看更早的 ${String(Math.min(CHAT_TIMELINE_WINDOW_SIZE, historyWindow.start))} 组问答`,
                    `View ${String(Math.min(CHAT_TIMELINE_WINDOW_SIZE, historyWindow.start))} earlier turns`,
                  )}
                </Button>
              </div>
            )}

            {visibleEntries.length > 0 && (
              <div className="bot-qa-table" role="table" aria-label={t("问答表格", "Q&A table")} data-testid="bot-qa-list">
                <div className="bot-qa-table-head" role="rowgroup">
                  <div className="bot-qa-table-row bot-qa-table-header-row" role="row">
                    <div className="bot-qa-cell bot-qa-head-cell" role="columnheader" data-col="index">
                      #
                    </div>
                    <div className="bot-qa-cell bot-qa-head-cell" role="columnheader" data-col="question">
                      <span className="bot-qa-badge" data-role="question">
                        {t("问", "Q")}
                      </span>
                      <span>{t("提问", "Question")}</span>
                    </div>
                    <div className="bot-qa-cell bot-qa-head-cell" role="columnheader" data-col="answer">
                      <span className="bot-qa-badge" data-role="answer">
                        {t("答", "A")}
                      </span>
                      {botAvatar && <span aria-hidden="true">{botAvatar}</span>}
                      <span className="truncate">{botName}</span>
                    </div>
                    <div className="bot-qa-cell bot-qa-head-cell" role="columnheader" data-col="meta">
                      {t("补充信息", "Details")}
                    </div>
                  </div>
                </div>
                <div className="bot-qa-table-body" role="rowgroup">
                  {visibleEntries.map((entry) => (
                    <MessageScrollerItem key={entry.key} messageId={entry.key} data-chat-key={entry.key} scrollAnchor>
                      <BotQaTableRow
                        entry={entry}
                        speakerNames={speakerNames}
                        resolutions={resolutions}
                        onError={onError}
                        openOutput={openOutput}
                        renderActivityEvent={renderActivityEvent}
                        renderOutcomeEvent={renderOutcomeEvent}
                      />
                    </MessageScrollerItem>
                  ))}
                </div>
              </div>
            )}

            {!normalizedQuery && !historyWindow.isLatest && (
              <div className="flex flex-wrap items-center justify-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                <span>
                  {t(
                    `当前显示第 ${String(historyWindow.start + 1)}–${String(historyWindow.end)} 组，另有 ${String(historyWindow.newerCount)} 组较新问答`,
                    `Showing ${String(historyWindow.start + 1)}–${String(historyWindow.end)} with ${String(historyWindow.newerCount)} newer turns`,
                  )}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const nextEnd = Math.min(displayItems.length, historyWindow.end + CHAT_TIMELINE_WINDOW_SIZE);
                    if (nextEnd >= displayItems.length) jumpToLatest();
                    else selectHistoryCursor({ end: displayItems[nextEnd]?.ordinal ?? nextOrdinal, mode: "page" });
                  }}
                >
                  {t("查看较新问答", "View newer turns")}
                  <ChevronDown data-icon="inline-end" />
                </Button>
                <Button size="sm" onClick={jumpToLatest}>
                  {t("回到最新", "Jump to latest")}
                </Button>
              </div>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton onClick={jumpToLatest} className="inset-s-auto right-5 bottom-5 translate-x-0" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
});
