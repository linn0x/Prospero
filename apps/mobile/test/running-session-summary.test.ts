import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@prospero/protocol";

import type { StoredHost } from "../src/lib/hosts";
import { runningSessionProgress } from "../src/lib/running-session-summary";
import type { HostRuntime } from "../src/lib/store";

function session(
  id: string,
  status: SessionInfo["status"],
  createdAt: number,
): SessionInfo {
  return {
    id,
    agent: "codex",
    kind: "structured",
    title: id,
    cwd: "D:\\projects\\secret-workspace",
    status,
    createdAt,
    cols: 80,
    rows: 24,
    preview: "不应出现在系统通知中的 Agent 回复",
  };
}

function runtime(sessions: SessionInfo[]): HostRuntime {
  return {
    status: "connected",
    hostInfo: null,
    activeAddr: null,
    activePath: "direct",
    lastError: null,
    rttMs: 10,
    sessions: Object.fromEntries(sessions.map((item) => [item.id, item])),
  };
}

const host = {
  id: "pc/id",
  name: "工作电脑",
  addrs: ["127.0.0.1"],
  port: 7788,
  token: "token",
  daemonPub: "pub",
  pairedAt: 1,
  connectionMode: "direct",
} satisfies StoredHost;

describe("Android 后台会话摘要", () => {
  it("忽略空闲会话，并优先显示等待用户处理的对话", () => {
    const progress = runningSessionProgress(
      [host],
      {
        [host.id]: runtime([
          session("running", "running", 10),
          session("approval", "waiting_approval", 1),
          session("idle", "idle", 20),
        ]),
      },
    );

    expect(progress).toMatchObject({
      runningCount: 2,
      waitingCount: 1,
      title: "approval",
    });
    expect(progress?.detail).toContain("等待审批");
    expect(progress?.detail).toContain("secret-workspace");
    expect(progress?.detail).not.toContain("D:\\projects");
    expect(progress?.detail).not.toContain("Agent 回复");
    expect(progress?.deepLink).toBe("prospero://host/pc%2Fid/session/approval");
  });

  it("没有运行或待处理会话时停止显示", () => {
    expect(
      runningSessionProgress(
        [host],
        { [host.id]: runtime([session("done", "done", 1)]) },
      ),
    ).toBeNull();
  });
});
