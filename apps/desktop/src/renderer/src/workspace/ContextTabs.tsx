import { Files, GitBranch, Search, ListChecks, PanelRightClose, Play, Plus, Route, SquareTerminal, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useLocale } from "../locale";
import { TabStrip, type DocumentTabs } from "../components/TabStrip";
import { orderedTabIds } from "../components/tab-strip-state";
import { DOCK_TOOLS, closeDockTool, openDockTool, type DockState, type DockTool } from "./dock-state";

export function ContextTabs({ state, onChange, onHide, onDocumentTabsHost, documents, trajectory = false }: { state: DockState; onChange: (value: DockState) => void; onHide: () => void; onDocumentTabsHost?: (host: HTMLDivElement | null) => void; documents: DocumentTabs | undefined; trajectory?: boolean }) {
  const { t } = useLocale();
  const labels: Record<DockTool, string> = { files: t("文件", "Files"), search: t("搜索", "Search"), task: t("任务", "Task"), diff: "Git", execution: t("执行", "Execution"), terminal: t("终端", "Terminal"), trajectory: t("轨迹", "Trajectory") };
  const icons = { files: Files, search: Search, task: ListChecks, diff: GitBranch, execution: Play, terminal: SquareTerminal, trajectory: Route };
  const focus = (tool: DockTool | undefined): void => { if (tool) window.requestAnimationFrame(() => document.getElementById(`dock-tab-${tool}`)?.focus()); };
  const close = (tool: DockTool): void => { const next = closeDockTool(state, tool); onChange(next); focus(next.active); };
  const entries = [...(documents?.items ?? []), ...state.tabs.map(tool => ({ id: `tool:${tool}`, label: labels[tool], onSelect: () => onChange({ ...state, active: tool }), onClose: () => close(tool) }))];
  const ids = orderedTabIds(state.tabOrder ?? [], entries.map(item => item.id));
  const items = ids.map(id => entries.find(item => item.id === id)!);
  return <div className="context-dock-tabbar">
    <TabStrip className="context-tabstrip" listClassName="context-dock-tabs" label={t("文件与会话工具", "Files and session tools")} items={items} activeId={documents?.activeId ?? (state.active ? `tool:${state.active}` : undefined)} onReorder={tabOrder => onChange({ ...state, tabOrder })}>
    <div className="context-document-tabs" ref={onDocumentTabsHost} />
      {state.tabs.map(tool => {
        const Icon = icons[tool];
        return <div className="context-dock-tab" data-tab-id={`tool:${tool}`} data-tool={tool} data-active={!documents?.activeId && tool === state.active || undefined} key={tool}>
          <button type="button" data-tab-handle data-slot="context-tool-tab" role="tab" id={`dock-tab-${tool}`} aria-controls={`dock-panel-${tool}`} aria-label={labels[tool]} title={labels[tool]} aria-selected={!documents?.activeId && tool === state.active} tabIndex={!documents?.activeId && tool === state.active ? 0 : -1} onClick={() => onChange({ ...state, active: tool })} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); close(tool); } }}><Icon /><span>{labels[tool]}</span></button>
          <button type="button" data-slot="context-tool-close" className="context-tab-close" aria-label={t(`关闭${labels[tool]}`, `Close ${labels[tool]}`)} title={t("仅隐藏工具，不会结束任务或终端", "Hide this tool without ending tasks or terminals")} onClick={() => close(tool)}><X /></button>
        </div>;
      })}
    </TabStrip>
    <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={t("打开工具标签", "Open tool tab")} />}><Plus /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>{DOCK_TOOLS.filter((tool) => tool !== "trajectory" || trajectory).map((tool) => { const Icon = icons[tool]; return <DropdownMenuItem key={tool} onClick={() => { onChange(openDockTool(state, tool)); focus(tool); }}><Icon />{labels[tool]}</DropdownMenuItem>; })}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
    <Button size="icon-xs" variant="ghost" aria-label={t("隐藏工具栏", "Hide tools")} title={t("隐藏工具栏", "Hide tools")} onClick={onHide}><PanelRightClose data-icon="inline-start" /></Button>
  </div>;
}
