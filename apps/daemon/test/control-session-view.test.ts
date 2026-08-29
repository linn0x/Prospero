import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";
import { createDaemonServer, type DaemonServer } from "../src/ws-server.js";

interface StructuredView {
  kind: "structured";
  mode: "snapshot" | "delta";
  evSeq: number;
  baseSeq?: number;
  seq?: number;
  events: Array<{ kind: string }>;
}

class ControlViewAdapter implements AgentAdapter {
  private context: AdapterContext | null = null;

  async start(context: AdapterContext): Promise<void> {
    this.context = context;
  }

  async send(text: string): Promise<void> {
    const context = this.context;
    if (!context) throw new Error("adapter is not started");
    if (text === "overflow") {
      // StructuredSession only retains 4,000 events. This deliberately
      // crosses that boundary so the HTTP endpoint must return a snapshot.
      for (let index = 0; index < 4_001; index++) {
        context.emit({
          kind: "text.delta",
          msgId: "overflow",
          textId: "overflow",
          delta: String(index),
        });
      }
    } else {
      const callId = text === "large" ? "tool-large" : "tool-alpha";
      const output = text === "large" ? "x".repeat(200_001) : `full:${text}`;
      context.recordOutput?.(callId, output);
      context.emit({
        kind: "text.delta",
        msgId: text,
        textId: text,
        delta: `echo:${text}`,
      });
    }
    context.emit({ kind: "turn.end", msgId: text, inputTokens: 1, outputTokens: 1 });
  }

  async respondPermission(): Promise<void> {}
  async usage() {
    return { inputTokens: 12, outputTokens: 7, windows: [{ label: "5 小时", utilization: 25 }] };
  }
  async listModels() {
    return {
      models: [
        { id: "gpt-alpha", label: "GPT Alpha", supportedEfforts: ["low", "high"], defaultEffort: "high", isDefault: true },
        { id: "gpt-beta", label: "GPT Beta", supportedEfforts: ["medium"] },
      ],
      currentModel: "gpt-alpha",
      currentEffort: "high",
    };
  }
  async setModel(model: string, effort?: string) {
    if (!model.startsWith("gpt-")) throw new Error("invalid model");
    return { currentModel: model, ...(effort ? { currentEffort: effort } : {}) };
  }
  async listModes() {
    return { modes: [{ id: "default", label: "执行" }, { id: "plan", label: "Plan" }], currentMode: "default" };
  }
  async setMode(mode: string) {
    if (mode !== "default" && mode !== "plan") throw new Error("invalid mode");
    return { currentMode: mode };
  }
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {
    this.context = null;
  }
}

describe("Mac control session views", () => {
  it("serves structured events and a snapshot-then-delta PTY stream", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "prospero-control-view-"));
    let server: DaemonServer | undefined;
    try {
      server = await createDaemonServer({
        home,
        port: 0,
        workspaceRoot: home,
        structuredSupervisor: false,
        ptySupervisor: false,
        adapterFactory: () => new ControlViewAdapter(),
      });
      const status = JSON.parse(readFileSync(path.join(home, "status.json"), "utf8")) as {
        controlToken: string;
      };
      const base = `http://127.0.0.1:${String(server.port)}`;
      const headers = { authorization: `Bearer ${status.controlToken}` };
      const request = (pathname: string, init: RequestInit = {}): Promise<Response> =>
        fetch(`${base}${pathname}`, {
          ...init,
          headers: { ...headers, ...(init.headers ?? {}) },
        });
      const create = async (body: Record<string, unknown>): Promise<{ id: string }> => {
        const response = await request("/_prospero/control/session/create", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(201);
        return response.json() as Promise<{ id: string }>;
      };
      const interact = async (sid: string, text: string): Promise<void> => {
        const response = await request(`/_prospero/control/session/${sid}/interact`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "chat.send", text }),
        });
        expect(response.status).toBe(204);
      };

      // Skill 补全扫的是文件系统:项目目录逐级向上,再加上用户家目录下的
      // ~/.claude/skills 之类。home 是空的临时目录,所以断言"有建议"实际断言的是
      // 【跑测试这台机器的家目录里恰好装了 Skill】—— 作者机器上过,CI 上必挂。
      // 在会话 cwd 里放一个项目级 Skill,补全结果才由用例自己决定。
      const skillDir = path.join(home, ".claude", "skills", "control-view-probe");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        path.join(skillDir, "SKILL.md"),
        "---\nname: control-view-probe\ndescription: 控制面板补全用例的固定 Skill\n---\n",
      );

      const structured = await create({ agent: "codex", kind: "structured", cwd: home });
      const viewPath = `/_prospero/control/session/${structured.id}/view`;
      const toolPath = `/_prospero/control/session/${structured.id}/tool-output`;
      const usagePath = `/_prospero/control/usage?sid=${structured.id}`;
      const modesPath = `/_prospero/control/session/${structured.id}/modes`;
      const modelsPath = `/_prospero/control/session/${structured.id}/models`;
      const suggestionsPath = `/_prospero/control/session/${structured.id}/suggestions?kind=skill&query=`;

      // Control-token authorization applies to the newly added read endpoints.
      expect((await fetch(`${base}${viewPath}`)).status).toBe(401);
      expect((await fetch(`${base}${toolPath}?callId=tool-alpha`)).status).toBe(401);
      expect((await fetch(`${base}${usagePath}`)).status).toBe(401);
      expect((await fetch(`${base}/_prospero/control/launch/models?agent=codex`)).status).toBe(401);

      const usage = await request(usagePath);
      expect(usage.status).toBe(200);
      expect(await usage.json()).toMatchObject({ available: true, inputTokens: 12, outputTokens: 7, windows: [{ label: "5 小时", utilization: 25 }] });
      const modes = await request(modesPath);
      expect(await modes.json()).toMatchObject({ currentMode: "default", modes: [{ id: "default" }, { id: "plan" }] });
      const setPlan = await request(modesPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "plan" }) });
      expect(await setPlan.json()).toEqual({ currentMode: "plan" });
      const launchModels = await request("/_prospero/control/launch/models?agent=codex");
      expect(await launchModels.json()).toMatchObject({ currentModel: "gpt-alpha", models: [{ id: "gpt-alpha" }, { id: "gpt-beta" }] });
      const models = await request(modelsPath);
      expect(await models.json()).toMatchObject({ currentModel: "gpt-alpha", currentEffort: "high" });
      const setModel = await request(modelsPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-beta", effort: "medium" }) });
      expect(await setModel.json()).toEqual({ currentModel: "gpt-beta", currentEffort: "medium" });
      const suggestions = await request(suggestionsPath);
      expect(suggestions.status).toBe(200);
      const suggestionBody = await suggestions.json() as { items: Array<{ kind: string; value: string }> };
      // 项目级 Skill 优先级高于用户级,所以哪怕开发机上另有一堆 Skill,它也排在最前。
      expect(suggestionBody.items[0]).toMatchObject({ kind: "skill", value: "control-view-probe" });

      const initial = await request(viewPath);
      expect(initial.status).toBe(200);
      expect(await initial.json()).toEqual({
        kind: "structured",
        mode: "snapshot",
        seq: 0,
        evSeq: 0,
        events: [],
      });
      // knownSeq remains the legacy no-change probe.
      expect((await request(`${viewPath}?knownSeq=0`)).status).toBe(204);
      expect((await request(`${viewPath}?afterSeq=not-a-sequence`)).status).toBe(400);

      const ahead = await request(`${viewPath}?afterSeq=1`);
      expect(ahead.status).toBe(200);
      expect(await ahead.json()).toMatchObject({
        kind: "structured",
        mode: "snapshot",
        evSeq: 0,
        events: [],
      });
      expect((await request(`${viewPath}?afterSeq=0`)).status).toBe(204);

      await interact(structured.id, "alpha");
      const deltaResponse = await request(`${viewPath}?afterSeq=0`);
      expect(deltaResponse.status).toBe(200);
      const delta = await deltaResponse.json() as StructuredView;
      expect(delta).toMatchObject({
        kind: "structured",
        mode: "delta",
        baseSeq: 0,
      });
      expect(delta.evSeq).toBeGreaterThan(0);
      expect(delta.events).toHaveLength(delta.evSeq);
      expect((await request(`${viewPath}?afterSeq=${String(delta.evSeq)}`)).status).toBe(204);

      const output = await request(`${toolPath}?callId=tool-alpha`);
      expect(output.status).toBe(200);
      expect(await output.json()).toEqual({ output: "full:alpha", truncated: false });
      const missing = await request(`${toolPath}?callId=no-such-call`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe("tool output not found");
      expect((await request(toolPath)).status).toBe(400);

      await interact(structured.id, "large");
      const large = await request(`${toolPath}?callId=tool-large`);
      expect(large.status).toBe(200);
      const largeOutput = await large.json() as { output: string; truncated: boolean };
      expect(largeOutput).toMatchObject({ truncated: true });
      expect(largeOutput.output).toHaveLength(200_000);

      await interact(structured.id, "overflow");
      const gapResponse = await request(`${viewPath}?afterSeq=0`);
      expect(gapResponse.status).toBe(200);
      const gap = await gapResponse.json() as StructuredView;
      expect(gap).toMatchObject({ kind: "structured", mode: "snapshot" });
      expect(gap.events).toHaveLength(4_000);
      const latest = await request(`${viewPath}?afterSeq=${String(gap.evSeq - 1)}`);
      expect(latest.status).toBe(200);
      expect(await latest.json()).toMatchObject({
        kind: "structured",
        mode: "delta",
        baseSeq: gap.evSeq - 1,
        evSeq: gap.evSeq,
        events: [{ kind: "turn.end" }],
      });

      // afterSeq is structured-only and remains ignored for PTY compatibility.
      // The Mac-specific outputAfterSeq cursor upgrades PTY rendering without
      // changing knownSeq clients.
      const pty = await create({
        agent: "custom",
        kind: "pty",
        // 刻意不放在 home 下：Windows 会锁住任何进程的当前工作目录，而
        // PtySession.dispose() 只发 kill、不等子进程退出，于是 finally 里删 home
        // 时会撞 EBUSY。cwd 与本用例要断言的东西无关，指到 home 之外即可从根上
        // 消除这把锁，不必去赌 kill 与 rmdir 的时序。
        cwd: os.tmpdir(),
        // Keep the process stable across both view requests. An immediate
        // exit can legitimately advance the PTY sequence between snapshots,
        // turning the no-change probe into a racy 200 response on Windows.
        command: process.platform === "win32"
          ? "ping -n 31 127.0.0.1 >NUL"
          : "sleep 30",
      });
      const ptyViewPath = `/_prospero/control/session/${pty.id}/view`;
      const terminal = server.manager.requirePty(pty.id);
      // ConPTY 自己会在启动时写入 win32-input-mode / focus-tracking 之类的模式
      // 序列(ESC[?9001h、ESC[?1004h),这些字节同样要占掉 ring 的序号。若在它们
      // 落地之前取快照，下面“delta 只应包含刚 push 的字节”的断言就会连带收到
      // 它们，Windows 上因此长期失败。ping 的输出重定向到 NUL，所以启动序列写完
      // PTY 就彻底安静；等 lastSeq 稳定下来再取快照，整条 delta 链才是确定的。
      for (let quiet = 0, seen = terminal.ring.lastSeq, deadline = Date.now() + 5_000;
        quiet < 3 && Date.now() < deadline;) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (terminal.ring.lastSeq === seen) quiet++;
        else { quiet = 0; seen = terminal.ring.lastSeq; }
      }
      const ptyView = await request(`${ptyViewPath}?afterSeq=not-a-sequence`);
      expect(ptyView.status).toBe(200);
      const ptySnapshot = await ptyView.json() as { kind: string; seq: number };
      expect(ptySnapshot.kind).toBe("pty");
      expect((await request(`${ptyViewPath}?knownSeq=${String(ptySnapshot.seq)}`)).status).toBe(204);
      expect((await request(`${ptyViewPath}?outputAfterSeq=nope`)).status).toBe(400);
      expect((await request(`${ptyViewPath}?outputAfterSeq=0&waitMs=25001`)).status).toBe(400);

      const firstBytes = new TextEncoder().encode("first-delta");
      const firstSeq = terminal.ring.push(firstBytes);
      const firstDeltaResponse = await request(
        `${ptyViewPath}?outputAfterSeq=${String(ptySnapshot.seq)}`,
      );
      expect(firstDeltaResponse.status).toBe(200);
      expect(await firstDeltaResponse.json()).toEqual({
        kind: "pty",
        mode: "delta",
        baseSeq: ptySnapshot.seq,
        seq: firstSeq,
        dataB64: Buffer.from(firstBytes).toString("base64"),
      });

      // A long poll registers before rechecking the ring, then wakes as soon
      // as SessionManager publishes output instead of adding a fixed UI poll.
      const waiting = request(`${ptyViewPath}?outputAfterSeq=${String(firstSeq)}&waitMs=2000`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondBytes = new TextEncoder().encode("second-delta");
      const secondSeq = terminal.ring.push(secondBytes);
      server.manager.emit("output", pty.id, Buffer.from(secondBytes).toString("base64"), secondSeq);
      const secondDeltaResponse = await waiting;
      expect(secondDeltaResponse.status).toBe(200);
      expect(await secondDeltaResponse.json()).toMatchObject({
        mode: "delta",
        baseSeq: firstSeq,
        seq: secondSeq,
        dataB64: Buffer.from(secondBytes).toString("base64"),
      });

      expect((await request(
        `${ptyViewPath}?outputAfterSeq=${String(secondSeq)}&waitMs=5`,
      )).status).toBe(204);
      const repaired = await request(`${ptyViewPath}?outputAfterSeq=${String(secondSeq + 100)}`);
      expect(repaired.status).toBe(200);
      expect(await repaired.json()).toMatchObject({ kind: "pty", mode: "snapshot", seq: secondSeq });
    } finally {
      await server?.close();
      // PtySession.dispose() 是同步的：proc.kill() 之后并不等子进程真正退出。
      // 这个用例的 PTY 又把 cwd 设在 home 上，而 Windows 会锁住任何进程的 cwd
      // 目录（POSIX 允许直接 unlink），于是 rmdir 撞上 EBUSY。重试等内核把已被
      // kill 的进程回收完，避免清理时序把用例判负。
      rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
