import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]): string =>
  readFileSync(join(import.meta.dirname, "..", "src", ...parts), "utf8");

const sessionScreen = read("app", "host", "[hostId]", "session", "[sid].tsx");
const hostScreen = read("app", "host", "[hostId]", "index.tsx");
const quickPanel = read("components", "SessionQuickPanel.tsx");

describe("会话页动线", () => {
  it("文件与项目改动从标题栏打开的右侧快捷面板直达", () => {
    expect(sessionScreen).toContain('accessibilityLabel="打开会话工具"');
    expect(sessionScreen).toContain("drawerPosition={DrawerPosition.RIGHT}");
    expect(sessionScreen).toContain("onOpenGit={() => leaveQuickPanel");
    expect(sessionScreen).toContain("onOpenFiles={() => leaveQuickPanel");
    expect(quickPanel).toContain("onPress={onOpenGit}");
    expect(quickPanel).toContain('label="项目文件"');
    expect(quickPanel).toContain("onPress={onOpenFiles}");
  });

  it("移到标题栏之后菜单里不再重复同两项", () => {
    expect(sessionScreen).not.toContain('label="浏览项目文件"');
    expect(sessionScreen).not.toContain('label="查看项目改动"');
  });

  it("切换会话用 replace，来回切不堆积返回栈", () => {
    const switcher = sessionScreen.slice(
      sessionScreen.indexOf("function SessionSwitcherSheet"),
      sessionScreen.indexOf("export default function SessionScreen"),
    );
    expect(switcher).toContain("router.replace({");
    expect(switcher).not.toContain("router.push(");
  });

  it("侧栏常驻或子 Agent 视图下不提供标题切换器", () => {
    expect(sessionScreen).toContain(
      "const canSwitchSession = !showSessionRail && !isSubagent && orderedSessions.length > 1;",
    );
  });

  it("切换器与折叠屏侧栏用同一份排序后的会话", () => {
    expect(sessionScreen).toContain("sessions={orderedSessions}");
    expect(sessionScreen).toContain("const orderedSessions = useMemo(");
  });
});

describe("主机页动线", () => {
  it("账号与编排收进标题栏菜单", () => {
    expect(hostScreen).toContain('accessibilityLabel="更多主机功能"');
    expect(hostScreen).toContain("setToolsOpen(true)");
    expect(hostScreen).toContain('label="Agent 账号"');
    expect(hostScreen).toContain('label="Agent 编排"');
  });

  it("列表上方不再有这两个入口占位", () => {
    expect(hostScreen).not.toContain("styles.entryChips");
    expect(hostScreen).not.toContain("styles.orchestrationEntry");
  });

  it("说明文字在菜单里完整保留", () => {
    expect(hostScreen).toContain("Codex 与 Claude Code 独立登录环境，可共享同一项目目录");
    expect(hostScreen).toContain("手工创建 Run、任务依赖并指定 worker");
    expect(hostScreen).toContain("查看 Run、worker 与人工 Gate");
  });

  it("两个能力都不支持时不显示菜单按钮", () => {
    expect(hostScreen).toContain(
      "conn?.supportsAgentAccounts || conn?.supportsOrchestrationSnapshot,",
    );
    expect(hostScreen).toContain("{hasHostTools && (");
  });

  it("新建会话仍留在标题栏，不被菜单吞掉", () => {
    expect(hostScreen).toContain('accessibilityLabel="新建会话"');
    expect(hostScreen).toContain('<Icon name="plus" size={19}');
  });
});
