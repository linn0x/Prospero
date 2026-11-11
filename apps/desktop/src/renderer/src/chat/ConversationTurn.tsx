import { memo, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronDown, FileCode2, FileText, GitCompareArrows } from "lucide-react";
import type { JsonObject } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Spinner } from "../components/ui/spinner";
import { useLocale } from "../locale";
import { array, number, record, text } from "../state";
import { openProjectFile } from "../project-tools/tool-state";
import { resolveProjectFileReference } from "./file-references";
import { resultFiles } from "./result-files";

export const INITIAL_DIFF_LINE_LIMIT = 400;
const DIFF_LINE_PAGE_STEP = 1_000;
const COMPLETED_TURN_CONTAINMENT_STYLE: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 180px",
};

export function TurnDiffPatch({ patch }: { patch: string }) {
  const { t } = useLocale();
  const [visibleLines, setVisibleLines] = useState(INITIAL_DIFF_LINE_LIMIT);
  const lines = useMemo(() => patch.split("\n"), [patch]);
  const shown = lines.length > visibleLines ? lines.slice(0, visibleLines) : lines;
  const remaining = Math.max(0, lines.length - shown.length);
  return <>
    <pre>
      {shown.map((line, index) => (
        <span
          key={index}
          data-diff-line={
            line.startsWith("@@")
              ? "hunk"
              : line.startsWith("+") && !line.startsWith("+++")
                ? "added"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "removed"
                  : "context"
          }
        >
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
    {remaining > 0 && (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {remaining > DIFF_LINE_PAGE_STEP && (
          <Button variant="outline" size="xs" onClick={() => setVisibleLines(current => Math.min(lines.length, current + DIFF_LINE_PAGE_STEP))}>
            {t(`继续展开 ${DIFF_LINE_PAGE_STEP} 行（剩余 ${remaining} 行）`, `Show next ${DIFF_LINE_PAGE_STEP} lines (${remaining} remaining)`)}
          </Button>
        )}
        <Button variant="ghost" size="xs" onClick={() => setVisibleLines(lines.length)}>
          {t(`展开全部 ${lines.length} 行`, `Show remaining ${remaining} lines`)}
        </Button>
      </div>
    )}
  </>;
}

function TurnResults({ event, projectRoot }: { event: JsonObject; projectRoot?: string | undefined }) {
  const { t } = useLocale();
  const files = useMemo(() => projectRoot ? resultFiles(text(event.finalText), projectRoot) : [], [event.finalText, projectRoot]);
  const diffs = array(event.diffs).map(record);
  if (!files.length && !diffs.length) return null;
  return <div className="chat-turn-results">
    {files.length > 0 && <section aria-label={t("成果文件", "Result files")} className="chat-result-files">
      <h3><FileText />{t("成果文件", "Result files")}<span>{files.length}</span></h3>
      <div className="flex flex-wrap gap-2">{files.map(file => <Button variant="outline" size="sm" key={file.path} title={file.path} onClick={() => openProjectFile(projectRoot!, file)}><FileText /><span className="truncate">{file.path}</span></Button>)}</div>
    </section>}
    {diffs.length > 0 && <section className="chat-turn-diffs" aria-label={t("本轮改动", "Turn changes")}>
      <h3><GitCompareArrows />{t(`本轮改动 · ${diffs.length} 个文件`, `Turn changes · ${diffs.length} files`)}<span className="chat-diff-added">+{diffs.reduce((sum, diff) => sum + number(diff.additions), 0)}</span><span className="chat-diff-removed">−{diffs.reduce((sum, diff) => sum + number(diff.deletions), 0)}</span></h3>
      {diffs.map(diff => {
        const path = text(diff.path);
        const patch = text(diff.patch);
        const fileRef = projectRoot ? resolveProjectFileReference(path, projectRoot, true) : null;
        return <Collapsible key={path}>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />} className="chat-diff-trigger"><ChevronDown /><FileCode2 /><span className="min-w-0 flex-1 truncate text-left" title={path}>{path}</span><span className="chat-diff-added">+{number(diff.additions)}</span><span className="chat-diff-removed">−{number(diff.deletions)}</span></CollapsibleTrigger>
          <CollapsibleContent><div className="chat-diff-body">
            {patch ? <TurnDiffPatch patch={patch} /> : <p>{t("此记录未包含补丁内容。", "This record has no patch content.")}</p>}
            {projectRoot && fileRef && <Button variant="outline" size="xs" onClick={() => openProjectFile(projectRoot, fileRef)}><FileText />{t("打开文件", "Open file")}</Button>}
          </div></CollapsibleContent>
        </Collapsible>;
      })}
    </section>}
  </div>;
}

export const ConversationTurn = memo(function ConversationTurn({ event, projectRoot, renderEvent }: { event: JsonObject; projectRoot?: string | undefined; renderEvent: (event: JsonObject, activity?: boolean) => ReactNode }) {
  const { t } = useLocale();
  const completed = event.completed === true;
  // Completing a running turn automatically folds it, even if its process was open.
  // Subsequent toggles belong only to this turn and lifecycle phase.
  const [expansion, setExpansion] = useState<{ running?: boolean; completed?: boolean }>({});
  const [limit, setLimit] = useState(120);
  const phase = completed ? "completed" : "running";
  const open = expansion[phase] ?? !completed;
  const activity = array(event.activity).map(record);
  const outcomes = array(event.outcomes).map(record);
  const finish = text(event.finish);
  const failed = ["failed", "error"].includes(finish);
  const stopped = ["interrupted", "cancelled", "canceled"].includes(finish);
  return <article className="chat-turn" data-completed={completed} style={completed ? COMPLETED_TURN_CONTAINMENT_STYLE : undefined}>
    {array(event.users).map(record).map(user => <div key={text(user.displayKey)}>{renderEvent(user)}</div>)}
    {activity.length > 0 && <Collapsible open={open} onOpenChange={value => setExpansion(current => ({ ...current, [phase]: value }))} className="chat-turn-process">
      <CollapsibleTrigger render={<Button variant="outline" size="sm" />} className="chat-process-pill">
        {completed ? <Check /> : <Spinner />}<span>{completed ? t("查看过程", "View process") : t("执行过程", "In progress")}</span><span>{activity.length}</span><ChevronDown className="chat-process-chevron" />
      </CollapsibleTrigger>
      <CollapsibleContent><div className="chat-process-trace">
        {activity.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit(value => value + 120)}>{t("查看更早过程", "Show earlier activity")}</Button>}
        {activity.slice(-limit).map(entry => <div className="chat-process-entry" key={text(entry.displayKey)}>{renderEvent(entry, true)}</div>)}
      </div></CollapsibleContent>
    </Collapsible>}
    {outcomes.map(outcome => <div className="chat-turn-outcome" key={text(outcome.displayKey)}>{renderEvent(outcome)}</div>)}
    {completed && !text(event.finalText) && <p className="chat-turn-status" data-failed={failed || undefined}>{failed ? t("本轮失败，未生成最终答复。", "This turn failed without a final answer.") : stopped ? t("本轮已停止，未生成最终答复。", "This turn stopped without a final answer.") : t("本轮已完成，未生成最终答复。", "This turn completed without a final answer.")}</p>}
    <TurnResults event={event} projectRoot={projectRoot} />
    {completed && text(event.finalText) && <p className="chat-turn-status" data-failed={failed || undefined}>{failed ? t("本轮失败", "Turn failed") : stopped ? t("本轮已停止", "Turn stopped") : t("本轮完成", "Turn complete")}{number(event.outputTokens) > 0 && ` · ${number(event.outputTokens)} tokens`}</p>}
  </article>;
});
