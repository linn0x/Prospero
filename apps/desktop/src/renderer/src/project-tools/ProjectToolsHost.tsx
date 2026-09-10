import { createContext, lazy, Suspense, useCallback, useContext, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProjectTool } from "../../../shared/project-tools";
import type { DocumentTabs } from "../components/TabStrip";

const ProjectToolsPane = lazy(() => import("./ProjectToolsPane").then(module => ({ default: module.ProjectToolsPane })));
type Location = { host: HTMLDivElement; root: string; mode: ProjectTool; active: boolean; tabsHost?: HTMLDivElement | null | undefined; onActivate?: (() => void) | undefined; onDocumentTabs?: ((tabs: DocumentTabs | undefined) => void) | undefined };
type Mount = (location: Location) => () => void;
const HostContext = createContext<Mount | undefined>(undefined);

// Keep editors alive across session navigation and inline / overlay dock changes.
// The portal always uses this same container; only its DOM parent changes.
export function ProjectToolsProvider({ children }: { children: ReactNode }) {
  const [container] = useState(() => { const element = document.createElement("div"); element.className = "project-tools-host"; return element; });
  const [location, setLocation] = useState<Location>();
  const [projects, setProjects] = useState<Array<{ root: string; mode: ProjectTool }>>([]);
  const mount = useCallback<Mount>(next => {
    setProjects(current => current.some(project => project.root === next.root)
      ? current.map(project => project.root === next.root ? { root: next.root, mode: next.mode } : project)
      : [...current, { root: next.root, mode: next.mode }]);
    setLocation(next);
    return () => setLocation(current => current === next ? undefined : current);
  }, []);
  useLayoutEffect(() => {
    if (location) location.host.appendChild(container);
    else container.remove();
    return () => { container.remove(); };
  }, [container, location]);
  return <HostContext.Provider value={mount}>{children}{createPortal(<Suspense fallback={<div className="project-preview-loading" role="status">…</div>}>
    {projects.map(project => <div className="project-tools-instance" key={project.root} hidden={location?.root !== project.root}>
      <ProjectToolsPane root={project.root} mode={project.mode} active={location?.root === project.root && location.active} tabsHost={location?.root === project.root ? location.tabsHost : null} onActivate={location?.root === project.root ? location.onActivate : undefined} onDocumentTabs={location?.root === project.root ? location.onDocumentTabs : undefined} />
    </div>)}
  </Suspense>, container)}</HostContext.Provider>;
}

export function ProjectToolsSlot({ root, mode, active, tabsHost, onActivate, onDocumentTabs }: Omit<Location, "host">) {
  const mount = useContext(HostContext);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => { if (host && mount) return mount({ host, root, mode, active, tabsHost, onActivate, onDocumentTabs }); }, [host, mount, root, mode, active, tabsHost, onActivate, onDocumentTabs]);
  return <div className="project-tools-slot" ref={setHost} />;
}
