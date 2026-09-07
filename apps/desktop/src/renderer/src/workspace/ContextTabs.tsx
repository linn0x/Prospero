import { FileDiff, ListChecks, Play, Plus, SquareTerminal, X } from "lucide-react";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { useLocale } from "../locale";
import { DOCK_TOOLS, closeDockTool, openDockTool, type DockState, type DockTool } from "./dock-state";

export function ContextTabs({ state, onChange, onHide }: { state: DockState; onChange: (value: DockState) => void; onHide: () => void }) {
  const { t } = useLocale();
  const labels: Record<DockTool, string> = { task: t("任务", "Task"), diff: "Diff", execution: t("执行", "Execution"), terminal: t("终端", "Terminal") };
  const icons = { task: ListChecks, diff: FileDiff, execution: Play, terminal: SquareTerminal };
  const focus = (tool: DockTool | undefined): void => { if (tool) window.requestAnimationFrame(() => document.getElementById(`dock-tab-${tool}`)?.focus()); };
  const close = (tool: DockTool): void => { const next = closeDockTool(state, tool); onChange(next); focus(next.active); };
  return <div className="context-dock-tabbar">
    <div className="context-dock-tabs" role="tablist" aria-label={t("会话工具", "Session tools")}>
      {state.tabs.map((tool, index) => {
        const Icon = icons[tool];
        return <div className="context-dock-tab" data-active={tool === state.active || undefined} key={tool}>
          <button type="button" data-slot="context-tool-tab" role="tab" id={`dock-tab-${tool}`} aria-controls={`dock-panel-${tool}`} aria-selected={tool === state.active} tabIndex={tool === state.active ? 0 : -1} onClick={() => onChange({ ...state, active: tool })} onKeyDown={(event) => {
            if (event.key === "Delete") { event.preventDefault(); close(tool); return; }
            const next = event.key === "Home" ? state.tabs[0] : event.key === "End" ? state.tabs.at(-1) : event.key === "ArrowRight" ? state.tabs[(index + 1) % state.tabs.length] : event.key === "ArrowLeft" ? state.tabs[(index - 1 + state.tabs.length) % state.tabs.length] : undefined;
            if (next) { event.preventDefault(); onChange({ ...state, active: next }); focus(next); }
          }}><Icon /><span>{labels[tool]}</span></button>
          <button type="button" data-slot="context-tool-close" className="context-tab-close" aria-label={t(`关闭${labels[tool]}`, `Close ${labels[tool]}`)} title={t("仅隐藏工具，不会结束任务或终端", "Hide this tool without ending tasks or terminals")} onClick={() => close(tool)}><X /></button>
        </div>;
      })}
    </div>
    <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-xs" variant="ghost" aria-label={t("打开工具标签", "Open tool tab")} />}><Plus /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>{DOCK_TOOLS.map((tool) => { const Icon = icons[tool]; return <DropdownMenuItem key={tool} onClick={() => { onChange(openDockTool(state, tool)); focus(tool); }}><Icon />{labels[tool]}</DropdownMenuItem>; })}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
    <Button size="icon-xs" variant="ghost" aria-label={t("隐藏工具栏", "Hide tools")} onClick={onHide}><X /></Button>
  </div>;
}
