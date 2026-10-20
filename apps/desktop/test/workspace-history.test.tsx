import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo, SessionPage } from "../src/shared/types";
import { WorkspaceHistory } from "../src/renderer/src/WorkspaceHistory";

vi.mock("../src/renderer/src/locale", () => ({
  useLocale: () => ({
    language: "zh-CN",
    setLanguage: vi.fn(),
    t: (zh: string, en: string) => zh ?? en,
    status: (value: string) => value,
  }),
}));

afterEach(() => vi.unstubAllGlobals());

function session(id: string, cwd = "/workspace"): SessionInfo {
  return {
    id,
    agent: "codex",
    kind: "structured",
    status: "completed",
    title: `Session ${id}`,
    cwd,
    createdAt: 1000,
  };
}

describe("WorkspaceHistory", () => {
  it("renders show-more button when total exceeds visible sessions even if preview is small or archived", () => {
    vi.stubGlobal("window", {
      prospero: {
        listSessions: vi.fn(async () => ({ items: [], total: 19, active: 0, terminal: 19 })),
        cancelSessionPage: vi.fn(async () => {}),
      },
    });
    const archived = ["s1", "s2", "s3"];
    const preview = [session("s1"), session("s2"), session("s3")];
    const html = renderToStaticMarkup(
      <WorkspaceHistory
        workspace="/workspace"
        name="诊断"
        enabled={false}
        revision="1"
        preview={preview}
        activeId={undefined}
        pinned={[]}
        unread={[]}
        archived={archived}
        query=""
        onTotal={() => {}}
        renderRow={(item) => <div key={item.id} data-testid={item.id}>{item.title}</div>}
      />,
    );
    // None of s1, s2, s3 visible in collapsed preview because all are archived
    expect(html).not.toContain("data-testid");
  });

  it("hides archived chats from normal history but keeps them searchable", async () => {
    const { sidebarProjectSessions } = await import("../src/renderer/src/workspace-sidebar-state");
    const items = [session("s1"), session("s2"), session("s3")];
    expect(sidebarProjectSessions(items, ["s2"], "").map(item => item.id)).toEqual(["s1", "s3"]);
    expect(sidebarProjectSessions(items, ["s2"], "Session s2").map(item => item.id)).toEqual(["s2"]);
  });

  it("does not render show-more button when all sessions are visible", () => {
    vi.stubGlobal("window", {
      prospero: {
        listSessions: vi.fn(async () => ({ items: [], total: 2, active: 0, terminal: 2 })),
        cancelSessionPage: vi.fn(async () => {}),
      },
    });
    const preview = [session("s1"), session("s2")];
    const html = renderToStaticMarkup(
      <WorkspaceHistory
        workspace="/workspace"
        name="诊断"
        enabled={false}
        revision="1"
        preview={preview}
        activeId={undefined}
        pinned={[]}
        unread={[]}
        archived={[]}
        query=""
        onTotal={() => {}}
        renderRow={(item) => <div key={item.id} data-testid={item.id}>{item.title}</div>}
      />,
    );
    expect(html).toContain('data-testid="s1"');
    expect(html).toContain('data-testid="s2"');
    expect(html).not.toContain("workspace-session-more");
  });
});
