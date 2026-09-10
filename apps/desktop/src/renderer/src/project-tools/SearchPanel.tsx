import { useEffect, useId, useRef, useState } from "react";
import { CaseSensitive, Search, WholeWord } from "lucide-react";
import type { SearchResult } from "../../../shared/project-tools";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Spinner } from "../components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { useLocale } from "../locale";
import { reportError } from "../state";

export function SearchPanel({ root, revision, active, onOpen }: { root: string; revision: number; active: boolean; onOpen: (path: string, line: number) => void }) {
  const { t } = useLocale();
  const prefix = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [options, setOptions] = useState<string[]>([]);
  const [result, setResult] = useState<SearchResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const caseSensitive = options.includes("case"), wholeWord = options.includes("word");
  useEffect(() => { if (active) input.current?.focus(); }, [active]);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setResult(undefined); setError(undefined); setLoading(Boolean(query.trim()));
    const timer = setTimeout(() => {
      if (!query.trim()) return;
      void window.prospero.searchProject(root, query, { caseSensitive, wholeWord, pathFilter: filter }).then(value => { if (current) setResult(value); }).catch(reason => { if (current) setError(reportError(reason)); }).finally(() => { if (current) setLoading(false); });
    }, 300);
    return () => { current = false; clearTimeout(timer); void window.prospero.cancelProjectSearch().catch(() => {}); };
  }, [root, query, filter, caseSensitive, wholeWord, revision, retry, active]);
  const groups = new Map<string, NonNullable<SearchResult>["matches"]>();
  for (const match of result?.matches ?? []) groups.set(match.path, [...groups.get(match.path) ?? [], match]);
  return <>
    <div className="project-search-form"><FieldGroup><Field><FieldLabel htmlFor={`${prefix}-project-search`}>{t("搜索项目内容", "Search project contents")}</FieldLabel><Input id={`${prefix}-project-search`} data-slot="project-search" ref={input} value={query} maxLength={256} placeholder={t("搜索文件中的文本…", "Search text in files…")} onChange={event => setQuery(event.target.value)} /></Field>
      <Field><FieldLabel className="sr-only" htmlFor={`${prefix}-project-search-filter`}>{t("文件路径包含", "File path contains")}</FieldLabel><Input id={`${prefix}-project-search-filter`} data-slot="project-search-filter" value={filter} maxLength={256} placeholder={t("文件路径包含，例如 src/ 或 .tsx", "Path contains, e.g. src/ or .tsx")} onChange={event => setFilter(event.target.value)} /></Field></FieldGroup>
      <ToggleGroup multiple value={options} onValueChange={value => setOptions(value as string[])} size="sm" aria-label={t("搜索选项", "Search options")}><ToggleGroupItem value="case" aria-label={t("区分大小写", "Match case")} title={t("区分大小写", "Match case")}><CaseSensitive /></ToggleGroupItem><ToggleGroupItem value="word" aria-label={t("全字匹配", "Whole word")} title={t("全字匹配", "Whole word")}><WholeWord /></ToggleGroupItem></ToggleGroup>
    </div>
    <div className="project-search-summary" role="status">{loading ? <><Spinner />{t("正在搜索…", "Searching…")}</> : result ? t(`${result.matches.length} 条结果 · ${groups.size} 个文件`, `${result.matches.length} results in ${groups.size} files`) : t("自动忽略依赖、构建产物和二进制文件", "Skips dependencies, build outputs and binary files")}</div>
    {error && <div className="project-tree-message" role="alert">{error}<Button size="xs" variant="outline" onClick={() => setRetry(value => value + 1)}>{t("重试", "Retry")}</Button></div>}
    {result?.truncated && <p className="project-tree-message">{t("搜索达到限制，请缩小关键词或路径范围。", "Search limit reached. Refine your query or path filter.")}</p>}
    {result && result.skipped > 0 && <p className="project-tree-message">{t(`已跳过 ${result.skipped} 个过大、二进制或无法读取的文件`, `Skipped ${result.skipped} large, binary or unreadable files`)}</p>}
    <div className="project-panel-scroll">
      {[...groups].map(([path, matches]) => <section className="project-search-group" key={path}><h3 title={path}>{path}</h3>{matches.map(match => <button data-slot="project-search-result" className="project-search-result" key={`${match.line}:${match.column}`} title={`${path}:${match.line}:${match.column}`} onClick={() => onOpen(path, match.line)}><span>{match.line}</span><code>{match.text}</code></button>)}</section>)}
      {!loading && !groups.size && !error && <Empty><EmptyHeader><EmptyMedia variant="icon"><Search /></EmptyMedia><EmptyTitle>{query ? t("没有匹配结果", "No matches") : t("查找每一处细节", "Find every detail")}</EmptyTitle><EmptyDescription>{query ? t("试试其他关键词，或调整搜索选项。", "Try another query or adjust the search options.") : t("搜索当前项目的所有文本文件，点击结果跳转到对应行。", "Search text files throughout this project. Select a result to jump to its line.")}</EmptyDescription></EmptyHeader></Empty>}
    </div>
  </>;
}
