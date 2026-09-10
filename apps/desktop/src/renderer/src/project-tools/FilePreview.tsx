import { useEffect, useMemo, useRef, useState } from "react";
import { Code2, Copy, Eye, FileQuestion, Pencil, RefreshCw, Save, WrapText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import type { FilePreview as Preview } from "../../../shared/project-tools";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty";
import { Spinner } from "../components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { MarkdownContent } from "../chat/MarkdownContent";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { reportError } from "../state";
import { codeLanguage, formatSize, type PreviewTab } from "./tool-state";

function SourceView({ value, path, line, diff, wrap }: { value: string; path: string; line: number; diff: boolean; wrap: boolean }) {
  const { t } = useLocale();
  const lines = useMemo(() => value.split("\n"), [value]);
  const [page, setPage] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => { setPage(Math.floor(Math.max(0, line - 1) / 2000)); }, [line]);
  const start = page * 2000, section = lines.slice(start, start + 2000);
  useEffect(() => { if (line) host.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" }); }, [line, page, value]);
  const source = section.join("\n");
  const fence = "`".repeat([...source.matchAll(/`+/g)].reduce((length, match) => Math.max(length, match[0].length + 1), 3));
  return <>
    {lines.length > 2000 && <div className="project-code-pagination"><Button variant="ghost" size="xs" disabled={!page} onClick={() => setPage(value => value - 1)}>{t("上一段", "Previous")}</Button><span>{t(`第 ${start + 1}–${Math.min(start + 2000, lines.length)} 行，共 ${lines.length} 行`, `Lines ${start + 1}–${Math.min(start + 2000, lines.length)} of ${lines.length}`)}</span><Button variant="ghost" size="xs" disabled={start + 2000 >= lines.length} onClick={() => setPage(value => value + 1)}>{t("下一段", "Next")}</Button></div>}
    <div ref={host} className={cn("project-source-scroll", wrap && "is-wrapped")}>
      {diff || wrap ? <div className="project-source-lines">{section.map((text, index) => <div data-line={start + index + 1} key={start + index} className={cn("project-source-line", line === start + index + 1 && "is-target", diff && (text.startsWith("@@") ? "is-hunk" : text.startsWith("+") && !text.startsWith("+++") ? "is-added" : text.startsWith("-") && !text.startsWith("---") ? "is-removed" : ""))}><span aria-hidden="true">{start + index + 1}</span><code>{text || " "}</code></div>)}</div> : <div className="project-code-source chat-markdown"><div className="project-line-numbers" aria-hidden="true">{section.map((_, index) => <span key={start + index} data-line={start + index + 1} className={cn(line === start + index + 1 && "is-target")}>{start + index + 1}</span>)}</div><ReactMarkdown rehypePlugins={source.length < 100_000 ? [rehypeHighlight] : []}>{`${fence}${codeLanguage(path)}\n${source}\n${fence}`}</ReactMarkdown></div>}
    </div>
  </>;
}

export function FilePreview({ root, tab, active, revision, onDirty, onRefresh, explorerToggle }: { root: string; tab: PreviewTab; active: boolean; revision: number; onDirty: (id: string, dirty: boolean) => void; onRefresh: () => void; explorerToggle?: import("react").ReactNode }) {
  const { t } = useLocale();
  const [preview, setPreview] = useState<Preview>();
  const [diff, setDiff] = useState("");
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState("preview");
  const [wrap, setWrap] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const savingRef = useRef(false);
  const dirty = preview?.kind === "text" && draft !== preview.content;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  useEffect(() => { if (tab.line > 0) setMode("source"); }, [tab]);
  useEffect(() => { onDirty(tab.id, dirty); }, [tab.id, dirty, onDirty]);
  useEffect(() => {
    if (tab.kind === "file" && dirtyRef.current) return;
    let current = true;
    setLoading(true); setError(undefined);
    const read = tab.kind === "diff" ? window.prospero.getProjectDiff(root, tab.path, tab.staged).then(value => { if (current) setDiff(value); }) : window.prospero.readProjectFile(root, tab.path).then(value => { if (current) { setPreview(value); setDraft(value.content); } });
    void read.catch(reason => { if (current) setError(reportError(reason)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [root, tab.id, reload, revision]);
  const save = async (): Promise<void> => {
    if (!preview || !dirty || savingRef.current) return;
    savingRef.current = true; setSaving(true); setError(undefined); setNotice("");
    const content = draft;
    try {
      await window.prospero.mutateProjectFile(root, { kind: "save", path: tab.path, content, version: preview.version });
      const value = await window.prospero.readProjectFile(root, tab.path);
      setPreview(value); setDraft(content); setNotice(t("已保存", "Saved")); onRefresh();
    } catch (reason) { setError(reportError(reason)); }
    finally { savingRef.current = false; setSaving(false); }
  };
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if ((window.prospero.platform === "darwin" ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key);
  });
  const markdown = /\.(md|mdx|markdown)$/i.test(tab.path);
  const content = tab.kind === "diff" ? diff : preview?.content ?? "";
  return <div className="project-preview-pane">
    <div className="project-preview-toolbar"><span className="project-breadcrumb" title={tab.path}>{tab.path.split("/").join("  /  ")}{tab.kind === "diff" && ` · ${tab.staged ? t("已暂存", "Staged") : t("工作区", "Working tree")}`}</span>
      <div className="project-preview-actions">
        {explorerToggle}
        {preview?.kind === "text" && <ToggleGroup size="sm" value={[mode]} onValueChange={value => { if (value[0]) setMode(String(value[0])); }} aria-label={t("预览模式", "Preview mode")}>
          <ToggleGroupItem value="preview" aria-label={t("预览", "Preview")} title={t("预览", "Preview")}><Eye /></ToggleGroupItem>
          {markdown && <ToggleGroupItem value="source" aria-label={t("源代码", "Source")} title={t("源代码", "Source")}><Code2 /></ToggleGroupItem>}
          <ToggleGroupItem value="edit" disabled={preview.truncated} aria-label={t("编辑", "Edit")} title={t("编辑", "Edit")}><Pencil /></ToggleGroupItem>
        </ToggleGroup>}
        {mode !== "edit" && preview?.kind !== "image" && <Button variant="ghost" size="icon-xs" aria-pressed={wrap} aria-label={t("自动换行", "Word wrap")} title={t("自动换行", "Word wrap")} onClick={() => setWrap(value => !value)}><WrapText /></Button>}
        <Button variant="ghost" size="icon-xs" disabled={loading || dirty || saving} aria-label={t("重新读取文件", "Reload file")} title={dirty ? t("请先保存修改", "Save changes first") : t("重新读取文件", "Reload file")} onClick={() => setReload(value => value + 1)}><RefreshCw /></Button>
        <Button variant="ghost" size="icon-xs" disabled={loading || preview?.kind === "binary" || preview?.kind === "image"} aria-label={t("复制内容", "Copy contents")} title={t("复制内容", "Copy contents")} onClick={() => void window.prospero.writeClipboard(mode === "edit" ? draft : content).then(() => setNotice(t("已复制", "Copied"))).catch(reason => setError(reportError(reason)))}><Copy /></Button>
        {mode === "edit" && <Button size="xs" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <Spinner data-icon="inline-start" /> : <Save data-icon="inline-start" />}{t("保存", "Save")}</Button>}
      </div>
    </div>
    {error && <Alert variant="destructive" className="m-3 w-auto"><AlertDescription>{error}</AlertDescription></Alert>}
    {preview?.truncated && <p className="project-tree-message">{t("大文件只读预览：仅显示前 1 MB。", "Large file preview: read-only, showing the first 1 MB.")}</p>}
    {loading ? <div className="project-preview-loading" role="status"><Spinner />{t("正在打开文件…", "Opening file…")}</div> : preview?.kind === "image" ? <div className="project-image-preview"><img src={preview.content} alt={tab.path} onError={() => setError(t("图片无法解码", "Unable to decode this image"))} /></div> : preview?.kind === "binary" ? <Empty><EmptyHeader><EmptyMedia variant="icon"><FileQuestion /></EmptyMedia><EmptyTitle>{t("二进制文件", "Binary file")}</EmptyTitle><EmptyDescription>{t("此文件不支持文本预览。", "Text preview is not available for this file.")}</EmptyDescription></EmptyHeader></Empty> : !error || preview || diff ? mode === "edit" ? <textarea data-slot="project-code-editor" className="project-code-editor" spellCheck={false} aria-label={t(`编辑 ${tab.path}`, `Edit ${tab.path}`)} value={draft} disabled={saving} onChange={event => setDraft(event.target.value)} /> : markdown && mode === "preview" && tab.kind === "file" && !tab.line ? <div className="project-markdown-preview"><MarkdownContent value={content} onError={setError} /></div> : <SourceView value={content} path={tab.path} line={active ? tab.line : 0} diff={tab.kind === "diff"} wrap={wrap} /> : null}
    <footer className="project-preview-status"><span>{notice || (dirty ? t("尚未保存", "Unsaved changes") : tab.kind === "diff" ? "Diff" : codeLanguage(tab.path) || "Text")}</span><span>{tab.line > 0 && `${t("行", "Ln")} ${tab.line} · `}{preview ? formatSize(preview.size) : ""}{preview?.kind === "text" && " · UTF-8"}</span></footer>
  </div>;
}
