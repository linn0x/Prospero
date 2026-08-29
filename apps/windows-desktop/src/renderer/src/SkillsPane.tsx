import { useEffect, useMemo, useState } from "react";
import { BookOpen, CircleAlert, FolderOpen, RefreshCw, Search, Sparkles } from "lucide-react";
import type { DesktopSnapshot, SkillInfo } from "../../shared/types";
import { displayError, shortPath } from "./state";
import { useLocale } from "./locale";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";

function projectName(snapshot: DesktopSnapshot, project: string): string {
  return snapshot.projectAliases[project.toLocaleLowerCase()]
    || project.split(/[\\/]/).filter(Boolean).at(-1)
    || project;
}

export function SkillsPane({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { t } = useLocale();
  const [project, setProject] = useState(snapshot.projects[0] ?? "");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (project && !snapshot.projects.includes(project)) setProject(snapshot.projects[0] ?? "");
    if (!project && snapshot.projects[0]) setProject(snapshot.projects[0]);
  }, [project, snapshot.projects]);

  const refresh = async (): Promise<void> => {
    if (!project) { setSkills([]); return; }
    setLoading(true);
    setError(undefined);
    try { setSkills(await window.prospero.listSkills(project)); }
    catch (reason) { setSkills([]); setError(displayError(reason)); }
    finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, [project, snapshot.daemon.running]);

  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.description} ${skill.path} ${skill.scope}`.toLocaleLowerCase().includes(needle));
  }, [query, skills]);

  return <div className="view-scroll"><div className="view-container skills-view">
    <header className="view-heading"><div className="flex min-w-0 flex-col gap-1"><span className="eyebrow">{t("能力目录", "CAPABILITY CATALOG")}</span><h1>Skills</h1><p>{t("查看当前工作区中可被 Agent 调用的项目、用户与插件 Skills。", "Inspect project, user, and plugin skills available to agents in this workspace.")}</p></div><div className="view-actions"><Button variant="outline" disabled={loading || !project || !snapshot.daemon.running} onClick={() => void refresh()}>{loading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}{t("刷新", "Refresh")}</Button></div></header>

    <div className="skills-toolbar">
      <NativeSelect aria-label={t("选择工作区", "Choose workspace")} value={project} onChange={(event) => setProject(event.target.value)}><NativeSelectOption value="" disabled>{t("选择工作区", "Choose workspace")}</NativeSelectOption>{snapshot.projects.map((item) => <NativeSelectOption key={item} value={item}>{projectName(snapshot, item)}</NativeSelectOption>)}</NativeSelect>
      <InputGroup><InputGroupAddon><Search /></InputGroupAddon><InputGroupInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索 Skills…", "Search skills…")} /></InputGroup>
      <Badge variant="outline">{visibleSkills.length} {t("个技能", "skills")}</Badge>
    </div>

    {!snapshot.daemon.running && <Alert><CircleAlert /><AlertTitle>{t("本地运行环境离线", "Local runtime is offline")}</AlertTitle><AlertDescription>{t("启动 daemon 后才能扫描 Skills。", "Start the daemon to scan skills.")}</AlertDescription></Alert>}
    {error && <Alert variant="destructive"><CircleAlert /><AlertTitle>{t("无法读取 Skills", "Unable to load skills")}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}

    {loading ? <div className="skills-loading"><Spinner /><span>{t("正在扫描技能目录…", "Scanning skill directories…")}</span></div> : visibleSkills.length > 0 ? <div className="skills-grid">{visibleSkills.map((skill) => <Card key={`${skill.scope}:${skill.path}`} className="skill-card"><CardHeader><div className="skill-card-heading"><span className="skill-icon"><Sparkles /></span><div className="min-w-0"><CardTitle className="truncate">{skill.name}</CardTitle><CardDescription>{skill.description || t("此 Skill 未提供说明。", "This skill has no description.")}</CardDescription></div><Badge variant={skill.scope === "project" ? "secondary" : "outline"}>{skill.scope}</Badge></div></CardHeader><CardContent><code title={skill.path}>{shortPath(skill.path)}</code></CardContent><CardFooter><Button variant="ghost" size="sm" onClick={() => void window.prospero.revealSkill(skill.path, project)}><FolderOpen data-icon="inline-start" />{t("显示 SKILL.md", "Show SKILL.md")}</Button></CardFooter></Card>)}</div> : <Empty className="skills-empty"><EmptyHeader><EmptyMedia variant="icon"><BookOpen /></EmptyMedia><EmptyTitle>{query ? t("没有匹配的 Skills", "No matching skills") : t("未发现 Skills", "No skills found")}</EmptyTitle><EmptyDescription>{query ? t("尝试缩短搜索词或清空筛选。", "Try a shorter query or clear the filter.") : t("可在项目的 .agents/skills 或用户、插件 Skill 目录中添加 SKILL.md。", "Add a SKILL.md under the project, user, or plugin skill directories.")}</EmptyDescription></EmptyHeader>{snapshot.projects.length === 0 && <EmptyContent><Button onClick={() => void window.prospero.chooseProject()}>{t("添加工作区", "Add workspace")}</Button></EmptyContent>}</Empty>}
  </div></div>;
}
