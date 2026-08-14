import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resetTmuxPathCache, sessionName, tmuxPath, wrapSpawn, writeConfig } from "../src/tmux.js";

const temps: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-tmux-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tmux platform support", () => {
  it("treats tmux as unavailable on Windows", () => {
    resetTmuxPathCache();
    expect(tmuxPath("win32")).toBeNull();
    resetTmuxPathCache();
  });
});

describe("tmux 托管", () => {
  it("用 new-session -e 显式传入 worker 身份，避免 tmux server 吞掉 client 环境", () => {
    const wrapped = wrapSpawn({ file: "codex", args: [] }, {
      id: "worker-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      configFile: "/tmp/tmux.conf",
      tmux: "tmux",
      environment: {
        PROSPERO_SESSION_ID: "worker-1",
        PROSPERO_CONTROL_SOCK: "/tmp/control.sock",
      },
    });
    expect(wrapped.args).toContain("PROSPERO_SESSION_ID=worker-1");
    expect(wrapped.args).toContain("PROSPERO_CONTROL_SOCK=/tmp/control.sock");
  });

  it("已安装的 tmux 接受 -e 并把身份放进新 session 环境", () => {
    const tmux = tmuxPath();
    if (!tmux) return;
    const home = tempHome();
    const conf = writeConfig(home);
    const name = `prospero-envtest-${String(Date.now())}`;
    const created = spawnSync(
      tmux,
      ["-f", conf, "new-session", "-d", "-e", "PROSPERO_SESSION_ID=worker-env", "-s", name, "sleep", "10"],
      { encoding: "utf8" },
    );
    const value = spawnSync(tmux, ["show-environment", "-t", name, "PROSPERO_SESSION_ID"], {
      encoding: "utf8",
    });
    spawnSync(tmux, ["kill-session", "-t", name], { stdio: "ignore" });
    expect(created.status).toBe(0);
    expect(value.stdout.trim()).toBe("PROSPERO_SESSION_ID=worker-env");
  });

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

  it("tmux 自己认这份配置 —— 断言字符串存在抓不到语法错", () => {
    // 之前 prefix 的转义多写了一层,生成出 'C-\\\\',tmux 每次启动都在终端顶上
    // 打一行 "bad key"。原有的测试只检查"配置里有没有这行字",tmux 认不认
    // 它一无所知,所以那个 bug 一路活到了模拟器上肉眼看见。
    const tmux = tmuxPath();
    if (!tmux) return; // 没装 tmux 就跳过,不让环境差异变成红灯
    const home = tempHome();
    const conf = writeConfig(home);
    const name = `prospero-conftest-${String(Date.now())}`;
    const r = spawnSync(tmux, ["-f", conf, "new-session", "-d", "-s", name, "true"], {
      encoding: "utf8",
    });
    spawnSync(tmux, ["kill-session", "-t", name], { stdio: "ignore" });
    const noise = `${r.stderr ?? ""}${r.stdout ?? ""}`;
    expect(noise).not.toMatch(/bad key|unknown option|invalid|error/i);
  });

  it("配置关掉状态栏、不占用任何前缀键、且不销毁未接管的会话", () => {
    const home = tempHome();
    const conf = readFileSync(writeConfig(home), "utf8");
    // 状态栏在手机上是纯噪音,还占一行
    expect(conf).toContain("status off");
    // 前缀整个去掉:手机上没人管理 tmux 窗口,留着只会从 agent 手里偷键
    expect(conf).toContain("unbind C-b");
    expect(conf).toContain("prefix None");
    // 这条错了整个托管就失去意义:daemon 断开即销毁会话
    expect(conf).toContain("destroy-unattached off");
  });
});
