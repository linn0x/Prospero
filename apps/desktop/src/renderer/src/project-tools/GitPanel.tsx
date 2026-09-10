import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, GitBranch, GitCommitHorizontal, Minus, Plus } from "lucide-react";
import type { GitHistoryEntry, GitMutation, ProjectGitFile, ProjectGitStatus } from "../../../shared/project-tools";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import { useLocale } from "../locale";
import { reportError } from "../state";
import { fileName } from "./tool-state";

export function GitPanel({ root, revision, active, onOpen, onRefresh }: { root: string; revision: number; active: boolean; onOpen: (path: string, staged: boolean) => void; onRefresh: () => void }) {
  const { t } = useLocale();
  const prefix = useId();
  const [status, setStatus] = useState<ProjectGitStatus>();
  const [history, setHistory] = useState<GitHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  useEffect(() => {
    if (!active) return;
    let current = true; setLoading(true); setError(undefined);
    void Promise.all([window.prospero.getProjectGitStatus(root), window.prospero.getProjectGitHistory(root)]).then(([status, history]) => { if (current) { setStatus(status); setHistory(history); } }).catch(reason => { if (current) { setStatus(undefined); setError(reportError(reason)); } }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [root, revision, active]);
  const mutate = async (operation: GitMutation): Promise<void> => {
    if (pending.current) return; pending.current = true;
    setBusy(true); setError(undefined); setNotice("");
    try { await window.prospero.mutateProjectGit(root, operation); if (operation.kind === "commit") { setMessage(""); setNotice(t("提交成功", "Commit created")); } onRefresh(); }
    catch (reason) { setError(reportError(reason)); }
    finally { pending.current = false; setBusy(false); }
  };
  const staged = status?.files.filter(file => !file.untracked && file.index !== " ") ?? [];
  const changes = status?.files.filter(file => file.untracked || file.worktree !== " ") ?? [];
  const group = (files: ProjectGitFile[], isStaged: boolean) => <section className="project-git-group"><header><strong>{isStaged ? t("已暂存", "Staged changes") : t("工作区变更", "Changes")}</strong><Badge variant="secondary">{files.length}</Badge><Button className="ml-auto" size="icon-xs" variant="ghost" disabled={busy || loading || !files.length} aria-label={isStaged ? t("取消全部暂存", "Unstage all") : t("暂存全部", "Stage all")} title={isStaged ? t("取消全部暂存", "Unstage all") : t("暂存全部", "Stage all")} onClick={() => void mutate({ kind: isStaged ? "unstage" : "stage", paths: files.flatMap(file => [file.path, ...(file.originalPath ? [file.originalPath] : [])]) })}>{isStaged ? <Minus /> : <Plus />}</Button></header>
    {files.map(file => <div className="project-git-file" key={file.path}><button data-slot="project-git-file" title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path} onClick={() => onOpen(file.path, isStaged)}><span className="truncate">{fileName(file.path)}<small>{file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}</small></span><Badge variant="outline">{file.untracked ? "U" : isStaged ? file.index : file.worktree}</Badge></button><Button size="icon-xs" variant="ghost" disabled={busy || loading} aria-label={`${isStaged ? t("取消暂存", "Unstage") : t("暂存", "Stage")} ${file.path}`} onClick={() => void mutate({ kind: isStaged ? "unstage" : "stage", paths: [file.path, ...(file.originalPath ? [file.originalPath] : [])] })}>{isStaged ? <Minus /> : <Plus />}</Button></div>)}
    {!files.length && <p className="project-tree-message">{isStaged ? t("暂无暂存的文件", "No staged files") : t("工作区干净", "Working tree clean")}</p>}
  </section>;
  return <>
    {loading && <div className="project-tree-message" role="status"><Spinner />{t("正在读取仓库…", "Loading repository…")}</div>}
    {error && <div className="project-tree-message" role="alert"><p>{error}</p><Button variant="outline" size="xs" disabled={busy || loading} onClick={onRefresh}>{t("重试", "Retry")}</Button></div>}
    {notice && <p className="project-tree-message" role="status">{notice}</p>}
    {status?.branch && <><div className="project-git-branch"><GitBranch /><strong className="truncate">{status.branch}</strong><span><ArrowUp />{status.ahead}<ArrowDown />{status.behind}</span></div>
      <form className="project-commit-form" onSubmit={event => { event.preventDefault(); void mutate({ kind: "commit", message }); }}><FieldGroup><Field><FieldLabel htmlFor={`${prefix}-project-commit`}>{t("提交说明", "Commit message")}</FieldLabel><Textarea id={`${prefix}-project-commit`} data-slot="project-commit" value={message} maxLength={4000} rows={3} placeholder={t("描述本次更改…", "Describe your changes…")} disabled={busy} onChange={event => setMessage(event.target.value)} /></Field></FieldGroup><Button type="submit" disabled={busy || loading || !message.trim() || !status.staged}>{busy ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" />}{t("提交已暂存的更改", "Commit staged changes")}</Button></form>
      <div className="project-panel-scroll">{group(staged, true)}{group(changes, false)}<section className="project-git-history"><header><GitCommitHorizontal /><strong>{t("最近提交", "Recent commits")}</strong><Badge variant="secondary">{history.length}</Badge></header>{history.map(entry => <div key={entry.hash} title={`${entry.hash} · ${entry.author} · ${entry.date}`}><GitCommitHorizontal /><span><strong>{entry.subject}</strong><small>{entry.author} · {new Date(entry.date).toLocaleDateString()}</small></span><code>{entry.hash}</code></div>)}{!history.length && <p className="project-tree-message">{t("尚无提交", "No commits yet")}</p>}</section></div>
    </>}
    {!loading && !error && status && !status.branch && <Empty><EmptyHeader><EmptyMedia variant="icon"><GitBranch /></EmptyMedia><EmptyTitle>{t("不是 Git 仓库", "No Git repository")}</EmptyTitle><EmptyDescription>{t("选择一个 Git 项目，即可查看变更和提交历史。", "Select a Git project to review changes and commit history.")}</EmptyDescription></EmptyHeader></Empty>}
  </>;
}
