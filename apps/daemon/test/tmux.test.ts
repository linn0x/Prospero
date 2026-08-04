import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionName, wrapSpawn, writeConfig } from "../src/tmux.js";

const temps: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-tmux-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tmux 托管", () => {
  it("会话名带前缀,避免误伤用户自己的 tmux 会话", () => {
    expect(sessionName("abc-123")).toBe("prospero-abc-123");
  });

  it("wrapSpawn 用 new-session -A —— 建与恢复是同一条命令", () => {
    const wrapped = wrapSpawn(
      { file: "/bin/zsh", args: ["-il"] },
      { id: "s1", cwd: "/tmp/x", cols: 100, rows: 30, configFile: "/cfg", tmux: "/opt/tmux" },
    );
    expect(wrapped.file).toBe("/opt/tmux");
    expect(wrapped.args).toEqual([
      "-f", "/cfg",
      "new-session",
      "-A",
      "-s", "prospero-s1",
      "-c", "/tmp/x",
      "-x", "100",
      "-y", "30",
      "--",
      "/bin/zsh", "-il",
    ]);
  });

  it("原命令的参数原样透传,不被 tmux 吞掉", () => {
    const wrapped = wrapSpawn(
      { file: "/bin/zsh", args: ["-c", "sleep 600"] },
      { id: "s2", cwd: "/tmp", cols: 80, rows: 24, configFile: "/cfg", tmux: "/opt/tmux" },
    );
    const afterSeparator = wrapped.args.slice(wrapped.args.indexOf("--") + 1);
    expect(afterSeparator).toEqual(["/bin/zsh", "-c", "sleep 600"]);
  });

  it("配置关掉状态栏、让出 Ctrl-B、且不销毁未接管的会话", () => {
    const home = tempHome();
    const conf = readFileSync(writeConfig(home), "utf8");
    // 状态栏在手机上是纯噪音,还占一行
    expect(conf).toContain("status off");
    // Ctrl-B 要传给 agent(readline 后退一字符),不能被 tmux 当前缀吃掉
    expect(conf).toContain("unbind C-b");
    // 这条错了整个托管就失去意义:daemon 断开即销毁会话
    expect(conf).toContain("destroy-unattached off");
  });
});
