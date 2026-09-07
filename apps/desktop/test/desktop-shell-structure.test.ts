import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../src/renderer/src");
const app = readFileSync(resolve(sourceRoot, "App.tsx"), "utf8");
const styles = readFileSync(resolve(sourceRoot, "styles.css"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const sidebar = readFileSync(
  resolve(sourceRoot, "components/ui/sidebar.tsx"),
  "utf8",
);

describe("desktop shell structure", () => {
  it("keeps the wordmark without the old workbench icon or search chrome", () => {
    expect(app).not.toContain('className="sidebar-brand"');
    expect(app).not.toContain('className="search-trigger"');
    expect(app).toContain('setLauncher("command")');
  });

  it("keeps the shell sidebar while hiding workspace chrome in focus mode", () => {
    expect(app).toMatch(/<ShellSidebar\s+snapshot=\{sessionSnapshot\}/);
    expect(app).not.toContain("{shellChromeVisible && <ShellSidebar");
    expect(app).toContain('{chromeVisible && <div className="workspace-tabbar">');
    expect(app).toContain('{chromeVisible && <header className="pane-toolbar">');
    expect(app).toContain('{chromeVisible && <div className="pane-tabbar pane-tabbar-static">');
    expect(app).toContain('<Sheet open={chromeVisible && contextSheet}');
    expect(styles).toContain(".pane-workspace.is-focus .primary-pane { grid-template-rows: minmax(0, 1fr); }");
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

  // Native traffic-light clearance and pointer resizing are exercised in
  // scripts/check-window-chrome.cjs, against actual rendered bounds.

  it("copies sessions with their original account binding", () => {
    expect(app).toContain("...(session.accountId ? { accountId: session.accountId } : {}),");
    expect(app).toContain("duplicateSessionAccountState(snapshotRef.current.accounts, session)");
  });
});
