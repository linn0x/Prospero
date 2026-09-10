import { X } from "lucide-react";
import { TabStrip } from "../components/TabStrip";
import { ProjectFileIcon } from "./ProjectFileIcon";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";
import { cn } from "../lib/utils";
import { fileName, type PreviewTab } from "./tool-state";

export function ProjectFileTabs({ tabs, selected, active, dirty, prefix, onSelect, onClose, onReorder, embedded = false }: {
  tabs: PreviewTab[]; selected: string; active: boolean; dirty: Set<string>; prefix: string;
  onSelect: (id: string) => void; onClose: (id: string) => void; onReorder: (ids: string[]) => void; embedded?: boolean;
}) {
  const { t } = useLocale();
  const children = tabs.map((tab, index) => <div data-tab-id={`document:${tab.id}`} className={cn("project-preview-tab", active && tab.id === selected && "is-active")} key={tab.id}>
      <button type="button" data-tab-handle data-slot="project-file-tab" role="tab" id={`${prefix}-file-tab-${index}`} aria-controls={`${prefix}-file-panel-${index}`} aria-selected={active && tab.id === selected} tabIndex={active && tab.id === selected ? 0 : -1} title={tab.path} onClick={() => onSelect(tab.id)} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}><ProjectFileIcon path={tab.path} /><span>{fileName(tab.path)}</span>{tab.kind === "diff" && <small>{tab.staged ? t("暂存", "Staged") : "Diff"}</small>}{dirty.has(tab.id) && <span className="project-tab-dirty" aria-label={t("未保存", "Unsaved")}>●</span>}</button>
      <Button variant="ghost" size="icon-xs" aria-label={t(`关闭 ${fileName(tab.path)}`, `Close ${fileName(tab.path)}`)} onClick={() => onClose(tab.id)}><X data-icon="inline-start" /></Button>
    </div>);
  return embedded ? <div className="project-preview-tabs is-embedded">{children}</div> : <TabStrip className="project-file-tabstrip" listClassName="project-preview-tabs" label={t("打开的文件", "Open files")} activeId={active ? `document:${selected}` : undefined} items={tabs.map(tab => ({ id: `document:${tab.id}`, label: tab.path, onSelect: () => onSelect(tab.id), onClose: () => onClose(tab.id) }))} onReorder={ids => onReorder(ids.map(id => id.slice(9)))}>{children}</TabStrip>;
}
