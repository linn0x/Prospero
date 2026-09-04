import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../src/renderer/src");
const app = readFileSync(resolve(sourceRoot, "App.tsx"), "utf8");
const styles = readFileSync(resolve(sourceRoot, "styles.css"), "utf8");
const sidebar = readFileSync(
  resolve(sourceRoot, "components/ui/sidebar.tsx"),
  "utf8",
);

describe("desktop shell structure", () => {
  it("removes persistent brand and search chrome", () => {
    expect(app).not.toContain('className="sidebar-brand"');
    expect(app).not.toContain('className="search-trigger"');
    expect(app).toContain('setLauncher("command")');
  });

  it("keeps the shell sidebar while hiding workspace chrome in focus mode", () => {
    expect(app).toMatch(/<ShellSidebar\s+snapshot=\{sessionSnapshot\}/);
    expect(app).not.toContain("{shellChromeVisible && <ShellSidebar");
    expect(app).toContain('{!workspaceFocus && <header className="desktop-topbar">');
    expect(app).toContain('className="focus-exit-overlay"');
    expect(app).toContain('className="focus-drag-region"');
    expect(app).toContain('{chromeVisible && <div className="workspace-tabbar">');
    expect(app).toContain('{chromeVisible && <header className="pane-toolbar">');
    expect(app).toContain('{chromeVisible && <div className="pane-tabbar pane-tabbar-static">');
    expect(app).toContain('<Sheet open={chromeVisible && contextSheet}');
    expect(styles).toContain(".pane-workspace.is-focus .primary-pane { grid-template-rows: minmax(0, 1fr); }");
    expect(styles).toContain(".focus-exit-overlay { position: absolute;");
    expect(styles).toContain(".focus-drag-region { position: absolute;");
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
  });

  it("keeps macOS traffic-light space separate from sidebar controls", () => {
    expect(styles).toContain(':root[data-platform="darwin"] .sidebar-shell-header { min-height: 56px; padding-left: 78px; }');
    expect(styles).toContain('padding: 40px 0 8px;');
    expect(styles).toContain(':root[data-platform="darwin"] .focus-drag-region { right: 12px; left: 12px; }');
  });

  it("copies sessions with their original account binding", () => {
    expect(app).toContain("...(session.accountId ? { accountId: session.accountId } : {}),");
    expect(app).toContain("duplicateSessionAccountState(snapshotRef.current.accounts, session)");
  });
});
