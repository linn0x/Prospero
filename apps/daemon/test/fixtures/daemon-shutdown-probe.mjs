import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { SessionManager } from "../../dist/session-manager.js";

const [mode, marker] = process.argv.slice(2);
const home = process.env.PROSPERO_TEST_HOME;
const repo = process.env.PROSPERO_TEST_REPO;
if (!home || !repo || !marker || (mode !== "pty" && mode !== "structured" && mode !== "fake-agent")) {
  throw new Error("invalid shutdown probe arguments");
}

if (mode === "fake-agent") {
  // This small stdio agent treats its transport closing as fatal, which models
  // the daemon-owned SDK/stdio boundary without contacting a real provider.
  let armed = false;
  process.stdin.once("data", () => {
    armed = true;
    setTimeout(() => {
      if (armed) writeFileSync(marker, "structured survived");
      process.exit(0);
    }, 350);
  });
  process.stdin.once("end", () => {
    armed = false;
    process.exit(0);
  });
  process.stdin.resume();
} else {
  let manager;
  if (mode === "pty") {
    manager = new SessionManager({ home, tmux: { home } });
    if (!manager.tmuxEnabled) throw new Error("tmux is required for PTY shutdown probe");
    const info = await manager.create({
      agent: "custom",
      command: `sleep 0.35; printf survived > ${JSON.stringify(marker)}`,
      cwd: repo,
      cols: 80,
      rows: 24,
      allowShell: true,
    });
    process.stdout.write(`${JSON.stringify({ ready: true, sessionId: info.id })}\n`);
  } else {
    class PipeBoundFakeAdapter {
      child = null;

      async start() {
        this.child = spawn(process.execPath, [new URL(import.meta.url).pathname, "fake-agent", marker], {
          env: { ...process.env, PROSPERO_TEST_HOME: home, PROSPERO_TEST_REPO: repo },
          stdio: ["pipe", "ignore", "ignore"],
        });
        this.child.stdin.write("start\n");
      }

      async send() {}
      async respondPermission() {}
      async interrupt() {}

      async dispose() {
        this.child?.kill();
        this.child = null;
      }
    }
    manager = new SessionManager({ home, adapterFactory: () => new PipeBoundFakeAdapter() });
    const info = await manager.create({
      agent: "codex",
      kind: "structured",
      cwd: repo,
      cols: 80,
      rows: 24,
      allowShell: false,
    });
    process.stdout.write(`${JSON.stringify({ ready: true, sessionId: info.id })}\n`);
  }

  const graceful = () => {
    void manager.disposeAll().finally(() => process.exit(0));
  };
  process.on("SIGTERM", graceful);
  process.on("SIGINT", graceful);
  setInterval(() => {}, 1_000);
}
