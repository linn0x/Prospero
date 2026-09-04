import { useEffect, useMemo, useRef, useState } from "react";
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

const SKILLS_PAGE_SIZE = 60;

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
  const [visibleLimit, setVisibleLimit] = useState(SKILLS_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [revealBusy, setRevealBusy] = useState<string>();
  const [chooseBusy, setChooseBusy] = useState(false);
  const requestGeneration = useRef(0);
  const loadingProjectRef = useRef<string | undefined>(undefined);
  const actionGeneration = useRef(0);
  const revealBusyRef = useRef(false);
  const chooseBusyRef = useRef(false);

  useEffect(() => {
    if (project && !snapshot.projects.includes(project)) setProject(snapshot.projects[0] ?? "");
    if (!project && snapshot.projects[0]) setProject(snapshot.projects[0]);
  }, [project, snapshot.projects]);

  const refresh = async (): Promise<void> => {
    const selectedProject = snapshot.projects.includes(project) ? project : snapshot.projects[0] ?? "";
    if (!selectedProject || !snapshot.daemon.running) {
      requestGeneration.current += 1;
      loadingProjectRef.current = undefined;
      setSkills([]);
      setLoading(false);
      setLoadError(undefined);
      return;
    }
    if (loadingProjectRef.current === selectedProject) return;
    const generation = ++requestGeneration.current;
    loadingProjectRef.current = selectedProject;
    setLoading(true);
    setLoadError(undefined);
    try {
      const result = await window.prospero.listSkills(selectedProject);
      if (generation !== requestGeneration.current) return;
      setSkills(result);
    } catch (reason) {
      if (generation !== requestGeneration.current) return;
      setSkills([]);
      setLoadError(displayError(reason));
    } finally {
      if (generation === requestGeneration.current) {
        loadingProjectRef.current = undefined;
        setLoading(false);
      }
    }
  };

  const reveal = async (skill: SkillInfo): Promise<void> => {
    if (revealBusyRef.current) return;
    const selectedProject = project;
    const generation = ++actionGeneration.current;
    revealBusyRef.current = true;
    setRevealBusy(skill.path);
    setActionError(undefined);
    setNotice(undefined);
    try {
      const result = await window.prospero.revealSkill(skill.path, selectedProject);
      if (generation !== actionGeneration.current) return;
      if (!result.ok) throw new Error(result.error || t("无法显示 Skill", "Unable to reveal skill"));
      setNotice(t(`已在文件管理器中显示 ${skill.name}`, `Revealed ${skill.name} in the file manager`));
    } catch (reason) {
      if (generation === actionGeneration.current) setActionError(displayError(reason));
    } finally {
      if (generation === actionGeneration.current) {
        revealBusyRef.current = false;
        setRevealBusy(undefined);
      }
    }
  };

  const addWorkspace = async (): Promise<void> => {
    if (chooseBusyRef.current) return;
    chooseBusyRef.current = true;
    setChooseBusy(true);
    setActionError(undefined);
    setNotice(undefined);
    try {
      await window.prospero.chooseProject();
    } catch (reason) {
      setActionError(displayError(reason));
    } finally {
      chooseBusyRef.current = false;
      setChooseBusy(false);
    }
  };

  useEffect(() => {
    actionGeneration.current += 1;
    revealBusyRef.current = false;
    setRevealBusy(undefined);
    void refresh();
    return () => {
      requestGeneration.current += 1;
      actionGeneration.current += 1;
      loadingProjectRef.current = undefined;
    };
  }, [project, snapshot.daemon.running]);

  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) => `${skill.name} ${skill.description} ${skill.path} ${skill.scope}`.toLocaleLowerCase().includes(needle));
  }, [query, skills]);

  useEffect(() => setVisibleLimit(SKILLS_PAGE_SIZE), [project, query]);

  const renderedSkills = visibleSkills.slice(0, visibleLimit);

  return (
    <div className="view-scroll">
      <div className="view-container skills-view">
        <header className="view-heading">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="eyebrow">{t("能力目录", "CAPABILITY CATALOG")}</span>
            <h1>{t("技能", "Skills")}</h1>
            <p>{t("查看当前工作区中可被 Agent 调用的项目、用户与插件 Skills。", "Inspect project, user, and plugin skills available to agents in this workspace.")}</p>
          </div>
          <div className="view-actions">
            <Button variant="outline" disabled={loading || !project || !snapshot.daemon.running} onClick={() => void refresh()}>
              {loading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" aria-hidden="true" />}
              {t("刷新", "Refresh")}
            </Button>
          </div>
        </header>

        <div className="skills-toolbar">
          <NativeSelect aria-label={t("选择工作区", "Choose workspace")} value={project} onChange={(event) => setProject(event.target.value)}>
            <NativeSelectOption value="" disabled>{t("选择工作区", "Choose workspace")}</NativeSelectOption>
            {snapshot.projects.map((item) => <NativeSelectOption key={item} value={item}>{projectName(snapshot, item)}</NativeSelectOption>)}
          </NativeSelect>
          <InputGroup>
            <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
            <InputGroupInput type="search" maxLength={500} aria-label={t("搜索 Skills", "Search skills")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索 Skills…", "Search skills…")} />
          </InputGroup>
          <Badge variant="outline" role="status" aria-live="polite">{visibleSkills.length} {t("个技能", "skills")}</Badge>
        </div>

        {!snapshot.daemon.running && <Alert><CircleAlert aria-hidden="true" /><AlertTitle>{t("本地运行环境离线", "Local runtime is offline")}</AlertTitle><AlertDescription>{t("启动 daemon 后才能扫描 Skills。", "Start the daemon to scan skills.")}</AlertDescription></Alert>}
        {loadError && <Alert variant="destructive"><CircleAlert aria-hidden="true" /><AlertTitle>{t("无法读取 Skills", "Unable to load skills")}</AlertTitle><AlertDescription>{loadError}</AlertDescription></Alert>}
        {actionError && <Alert variant="destructive"><CircleAlert aria-hidden="true" /><AlertTitle>{t("无法完成操作", "Unable to complete action")}</AlertTitle><AlertDescription>{actionError}</AlertDescription></Alert>}
        {notice && <Alert role="status" aria-live="polite"><FolderOpen aria-hidden="true" /><AlertTitle>{t("操作完成", "Action complete")}</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}

        {loading ? (
          <div className="skills-loading" role="status" aria-live="polite"><Spinner /><span>{t("正在扫描技能目录…", "Scanning skill directories…")}</span></div>
        ) : visibleSkills.length > 0 ? (
          <>
            <div className="skills-grid">
              {renderedSkills.map((skill) => (
                <Card key={`${skill.scope}:${skill.path}`} className="skill-card">
                  <CardHeader>
                    <div className="skill-card-heading">
                      <span className="skill-icon" aria-hidden="true"><Sparkles /></span>
                      <div className="min-w-0">
                        <CardTitle className="truncate" title={skill.name} role="heading" aria-level={2}>{skill.name}</CardTitle>
                        <CardDescription title={skill.description}>{skill.description || t("此 Skill 未提供说明。", "This skill has no description.")}</CardDescription>
                      </div>
                      <Badge variant={skill.scope === "project" ? "secondary" : "outline"}>{skill.scope}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent><code title={skill.path}>{shortPath(skill.path)}</code></CardContent>
                  <CardFooter>
                    <Button variant="ghost" size="sm" aria-label={t(`在文件管理器中显示 ${skill.name} 的 SKILL.md`, `Show ${skill.name} SKILL.md in the file manager`)} aria-busy={revealBusy === skill.path} disabled={revealBusy !== undefined} onClick={() => void reveal(skill)}>
                      <FolderOpen data-icon="inline-start" aria-hidden="true" />
                      {revealBusy === skill.path ? t("正在显示…", "Revealing…") : t("显示 SKILL.md", "Show SKILL.md")}
                    </Button>
                  </CardFooter>
                </Card>
              ))}
            </div>
            {renderedSkills.length < visibleSkills.length && <div className="flex justify-center"><Button variant="outline" onClick={() => setVisibleLimit((current) => current + SKILLS_PAGE_SIZE)}>{t(`再显示 ${String(Math.min(SKILLS_PAGE_SIZE, visibleSkills.length - renderedSkills.length))} 个`, `Show ${String(Math.min(SKILLS_PAGE_SIZE, visibleSkills.length - renderedSkills.length))} more`)}</Button></div>}
          </>
        ) : (
          <Empty className="skills-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon"><BookOpen aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{query ? t("没有匹配的 Skills", "No matching skills") : t("未发现 Skills", "No skills found")}</EmptyTitle>
              <EmptyDescription>{query ? t("尝试缩短搜索词或清空筛选。", "Try a shorter query or clear the filter.") : t("可在项目的 .agents/skills 或用户、插件 Skill 目录中添加 SKILL.md。", "Add a SKILL.md under the project, user, or plugin skill directories.")}</EmptyDescription>
            </EmptyHeader>
            {snapshot.projects.length === 0 && <EmptyContent><Button aria-busy={chooseBusy} disabled={chooseBusy} onClick={() => void addWorkspace()}>{chooseBusy ? t("正在打开…", "Opening…") : t("添加工作区", "Add workspace")}</Button></EmptyContent>}
          </Empty>
        )}
      </div>
    </div>
  );
}
