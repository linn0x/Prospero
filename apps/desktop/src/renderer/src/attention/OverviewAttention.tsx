import { useMemo, type ComponentType, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, CircleAlert, ListChecks, MessageSquare, WifiOff } from "lucide-react";
import type { DesktopSnapshot } from "../../../shared/types";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { useLocale } from "../locale";
import { sessionLabel } from "../workspace/session-presentation";
import { text } from "../state";
import { AttentionGroup } from "./AttentionGroups";
import { attentionSummary, pendingRequests } from "./attention-state";

function Row({ icon: Icon, title, description, tone, action }: { icon: ComponentType; title: string; description: string; tone: string; action: ReactNode }) {
  return <div className="attention-row"><span className={`attention-icon tone-${tone}`} aria-hidden="true"><Icon /></span><div className="min-w-0 flex-1"><strong title={title}>{title}</strong><p>{description}</p></div>{action}</div>;
}

export function OverviewAttention({ snapshot, onOpenSession, onOpenRuns, onOpenInbox }: { snapshot: DesktopSnapshot; onOpenSession: (id: string) => void; onOpenRuns: (runId?: string, taskId?: string) => void; onOpenInbox: () => void }) {
  const { t, status } = useLocale();
  const attention = useMemo(() => attentionSummary(snapshot), [snapshot]);
  return <Card className="attention-card-shell" data-liquid-glass="panel" role="region" aria-labelledby="overview-attention-title">
    <CardHeader><div className="flex items-center justify-between gap-3"><div><CardTitle id="overview-attention-title" role="heading" aria-level={2}>{t("需要你处理", "Needs your attention")}</CardTitle><CardDescription>{t("先确认或回复，再检查失败与阻塞。", "Review requests and replies before failures and blockers.")}</CardDescription></div><Badge variant={attention.total ? "secondary" : "outline"} aria-label={t(`${attention.total} 项需要处理`, `${attention.total} items need attention`)}>{attention.total}</Badge></div></CardHeader>
    <CardContent className="flex flex-col gap-1">
      {attention.offline && <Row icon={WifiOff} title={t("本地服务离线", "Local service is offline")} description={snapshot.daemon.lastError || t("连接后才能继续本地工作。", "Reconnect to continue local work.")} tone="danger" action={<Button size="sm" disabled={snapshot.daemon.starting} onClick={() => void window.prospero.startDaemon()}>{snapshot.daemon.starting ? t("连接中…", "Connecting…") : t("连接", "Connect")}</Button>} />}
      <AttentionGroup id="overview-approvals" compact title={t("待确认", "Needs approval")} count={attention.counts.approvals}>
        {attention.gates.slice(0, attention.approvalSessions.length ? 1 : 2).map(gate => { const context = attention.context(gate); return <Row key={text(gate.id)} icon={ListChecks} title={context.title || t("任务需要确认", "Task needs a decision")} description={[context.project, t("等待你的决定", "Waiting for your decision")].filter(Boolean).join(" · ")} tone="warning" action={<Button variant="outline" size="sm" onClick={onOpenInbox}>{t("处理", "Review")}</Button>} />; })}
        {attention.approvalSessions.slice(0, attention.gates.length ? 1 : 2).map(session => <Row key={session.id} icon={ListChecks} title={sessionLabel(session)} description={t(`${pendingRequests(session,"approvals")} 项操作等待确认`, `${pendingRequests(session,"approvals")} operations await approval`)} tone="warning" action={<Button variant="outline" size="sm" onClick={() => onOpenSession(session.id)}>{t("确认", "Review")}</Button>} />)}
      </AttentionGroup>
      <AttentionGroup id="overview-questions" compact title={t("待回答", "Needs a reply")} count={attention.counts.questions}>
        {attention.questionSessions.slice(0,2).map(session => <Row key={session.id} icon={MessageSquare} title={sessionLabel(session)} description={t(`${pendingRequests(session,"questions")} 个问题等待回复`, `${pendingRequests(session,"questions")} questions await a reply`)} tone="warning" action={<Button variant="outline" size="sm" onClick={() => onOpenSession(session.id)}>{t("回答", "Reply")}</Button>} />)}
      </AttentionGroup>
      <AttentionGroup id="overview-issues" compact title={t("失败与阻塞", "Failures & blockers")} count={attention.counts.issues}>
        {attention.tasks.slice(0,2).map(task => { const context = attention.context(task); return <Row key={text(task.id)} icon={CircleAlert} title={context.title || t("任务需要检查", "Task needs review")} description={[context.project,status(text(task.status))].filter(Boolean).join(" · ")} tone="danger" action={<Button variant="outline" size="sm" onClick={() => onOpenRuns(text(task.runId),text(task.id))}>{t("查看", "View")}</Button>} />; })}
      </AttentionGroup>
      {!attention.total && <div className="calm-empty"><CheckCircle2 /><div><strong>{t("一切顺利", "All clear")}</strong><p>{t("当前没有需要处理的事项。", "Nothing needs your attention.")}</p></div></div>}
    </CardContent>
    <CardFooter><Button variant="ghost" size="sm" onClick={onOpenInbox}>{t("查看全部事项", "View all items")}<ArrowRight data-icon="inline-end" /></Button></CardFooter>
  </Card>;
}
