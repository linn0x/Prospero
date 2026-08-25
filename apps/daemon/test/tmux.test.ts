import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  configureSession,
  defaultTerminal,
  resetTmuxPathCache,
  sessionName,
  tmuxPath,
  wrapSpawn,
  writeConfig,
} from "../src/tmux.js";

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
      "/usr/bin/env",
      "-u", "NO_COLOR",
      "-u", "FORCE_COLOR",
      "COLORTERM=truecolor",
      "CLICOLOR=1",
      "TERM_PROGRAM=Prospero",
      "/bin/zsh", "-il",
    ]);
  });

  it("清理 tmux server 的禁色环境后，原命令参数仍原样透传", () => {
    const wrapped = wrapSpawn(
      { file: "/bin/zsh", args: ["-c", "sleep 600"] },
      { id: "s2", cwd: "/tmp", cols: 80, rows: 24, configFile: "/cfg", tmux: "/opt/tmux" },
    );
    const afterSeparator = wrapped.args.slice(wrapped.args.indexOf("--") + 1);
    expect(afterSeparator).toEqual([
      "/usr/bin/env",
      "-u", "NO_COLOR",
      "-u", "FORCE_COLOR",
      "COLORTERM=truecolor",
      "CLICOLOR=1",
      "TERM_PROGRAM=Prospero",
      "/bin/zsh", "-c", "sleep 600",
    ]);
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

  it("server 配置只声明安全终端能力，不污染用户其他 tmux 会话", () => {
    const home = tempHome();
    const conf = readFileSync(writeConfig(home), "utf8");
    expect(conf).toContain(`default-terminal '${defaultTerminal()}'`);
    expect(conf).toContain("xterm-256color:RGB");
    expect(conf).toContain("escape-time 10");
    expect(conf).not.toContain("status off");
    expect(conf).not.toContain("prefix None");
    expect(conf).not.toContain("mouse on");
  });

  it("只给目标 Prospero session 配置 UI 与可滚动历史", () => {
    const tmux = tmuxPath();
    if (!tmux) return;
    const id = `optiontest-${String(Date.now())}`;
    const name = sessionName(id);
    const created = spawnSync(tmux, ["new-session", "-d", "-s", name, "sleep", "10"]);
    expect(created.status).toBe(0);
    try {
      expect(configureSession(id, tmux)).toBe(true);
      const option = (scope: "session" | "window", name: string): string => {
        const command = scope === "window" ? "show-window-options" : "show-options";
        return spawnSync(tmux, [command, "-v", "-t", sessionName(id), name], {
          encoding: "utf8",
        }).stdout.trim();
      };
      expect(option("session", "status")).toBe("off");
      expect(option("session", "prefix")).toBe("None");
      expect(option("session", "mouse")).toBe("on");
      expect(option("session", "destroy-unattached")).toBe("off");
      expect(option("session", "xterm-keys")).toBe("on");
      expect(option("window", "history-limit")).toBe("10000");
      expect(option("window", "window-size")).toBe("latest");
    } finally {
      spawnSync(tmux, ["kill-session", "-t", name], { stdio: "ignore" });
    }
  });
});
