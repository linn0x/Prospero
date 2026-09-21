import type { ReactNode } from "react";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";
import type { AttentionFilter, AttentionKind } from "./attention-state";
import "./attention.css";

export function AttentionGroup({ id, title, count, compact = false, children }: { id: string; title: string; count: number; compact?: boolean; children: ReactNode }) {
  if (!count) return null;
  return <section className={compact ? "attention-group is-compact" : "attention-group inbox-group"} aria-labelledby={id}>
    <header className="attention-group-heading">
      {compact ? <h3 id={id}>{title}</h3> : <h2 id={id}>{title}</h2>}
      <span className="attention-group-count">{count}</span>
    </header>
    <div className="attention-group-items">{children}</div>
  </section>;
}

export function AttentionFilters({ value, counts, total, onChange }: { value: AttentionFilter; counts: Record<AttentionKind, number>; total: number; onChange: (value: AttentionFilter) => void }) {
  const { t } = useLocale();
  const options: [AttentionFilter, string, number][] = [["all", t("全部", "All"), total], ["approvals", t("待确认", "Needs approval"), counts.approvals], ["questions", t("待回答", "Needs a reply"), counts.questions], ["issues", t("失败与阻塞", "Failures & blockers"), counts.issues]];
  return <nav className="attention-filters" aria-label={t("待办分类", "Attention categories")}>
    {options.map(([id, label, count]) => <Button key={id} size="sm" variant={value === id ? "secondary" : "ghost"} aria-pressed={value === id} onClick={() => onChange(id)}>{label}<span className="tabular-nums text-muted-foreground">{count}</span></Button>)}
  </nav>;
}

export function AttentionDetails({ summary, text, children }: { summary: string; text: string; children?: ReactNode }) {
  return <details className="attention-details">
    <summary>{summary}</summary>
    <p className="attention-full-text">{text}</p>
    {children}
  </details>;
}
