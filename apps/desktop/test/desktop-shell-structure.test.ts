import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../src/renderer/src");
const app = readFileSync(resolve(sourceRoot, "App.tsx"), "utf8");
const workspace = readFileSync(resolve(sourceRoot, "workspace/WorkspacePane.tsx"), "utf8");
const tabs = readFileSync(resolve(sourceRoot, "app-shell/WorkspaceTabs.tsx"), "utf8");
const styles = readFileSync(resolve(sourceRoot, "styles.css"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const sidebar = readFileSync(
  resolve(sourceRoot, "components/ui/sidebar.tsx"),
  "utf8",
);

describe("desktop shell structure", () => {
  it("provides platform chrome while retaining command shortcuts", () => {
    expect(app).not.toContain('className="sidebar-brand"');
    expect(app).not.toContain('className="search-trigger"');
    expect(app).toContain("<WindowsTitlebar");
    expect(app).toContain('setLauncher("command")');
    expect(app).toContain('className="sidebar-new-session"');
    expect(app).toContain('className="sidebar-drawer-trigger"');
  });

  it("keeps the shell sidebar while hiding workspace chrome in focus mode", () => {
    expect(app).toMatch(/<ShellSidebar\s+snapshot=\{sessionSnapshot\}/);
    expect(app).not.toContain("{shellChromeVisible && <ShellSidebar");
    expect(app).toContain('!workspaceFocus && validOpenIds.length > 0 && <WorkspaceTabs');
    expect(app).toContain('className="local-workspace-container"');
    expect(app).toContain('{focus && <Button className="sidebar-exit-focus"');
    expect(workspace).toContain('{chromeVisible && <SessionToolbar');
    expect(workspace).not.toContain('pane-tabbar-static');
    expect(workspace).not.toContain('workspace-tabbar');
    expect(workspace).toContain('const visible = chromeVisible && dock.visible && available > 0;');
    expect(workspace).toContain('<Sheet open={visible && overlay}');
    expect(tabs).toContain('role="tablist"');
  });

  it("keeps the sidebar collapsible and able to switch sessions", () => {
    expect(app).toMatch(
      /<SidebarProvider\s+open=\{sidebarOpen\}\s+onOpenChange=\{changeSidebarOpen\}/,
    );
    expect(app).not.toContain("workspaceFocus ? false : sidebarOpen");
    expect(app).toContain('collapsible="icon"');
    expect(app).toContain('className="sidebar-header-toggle"');
    expect(app).toContain("onOpenSession(id, session);");
    expect(app).toContain("onOpenSession={openSession}");
  });

  it("fills the space beside the sidebar with workspace content", () => {
    expect(app).toContain(
      '<SidebarInset id="main-content" tabIndex={-1} className="prospero-main">',
    );
    expect(sidebar).toContain(
      '"relative flex w-full flex-1 flex-col bg-background',
    );
    expect(styles).toContain(".prospero-main {\n  height: 100%;\n  min-width: 0;");
    expect(styles).toContain('[data-slot="sidebar-container"] { top: 0; height: 100%;');
  });

  it("keeps native control clearance and independent narrow-window navigation", () => {
    expect(sidebar).toContain('window.prospero?.platform === "darwin" ? 88 : 52');
    expect(styles).toContain('.sidebar-shell-header button { -webkit-app-region: no-drag; }');
    expect(styles).toContain('[data-platform="darwin"] .sidebar-shell-header { padding-left: 88px;');
    expect(styles).toContain('[data-state="collapsed"] .sidebar-shell-header { padding: 44px 8px 8px;');
    expect(styles).toContain('@media (max-width: 767px)');
    expect(styles).toContain('.sidebar-drawer-trigger { display: inline-flex; position: fixed;');
  });

  it("copies sessions with their original account binding", () => {
    expect(app).toContain("...(session.accountId ? { accountId: session.accountId } : {}),");
    expect(app).toContain("duplicateSessionAccountState(snapshotRef.current.accounts, session)");
  });
});
