import { describe, expect, it } from "vitest";
import {
  AgentEventBodySchema,
  ProtocolError,
  parseC2S,
  parseS2C,
  type AgentEventBody,
} from "../src/index.js";

describe("结构化轨协议", () => {
  it("接受 chat.send 与 permission.respond", () => {
    expect(parseC2S({ type: "chat.send", sid: "s1", text: "hi" })).toMatchObject({
      text: "hi",
    });
    expect(
      parseC2S({ type: "chat.send", sid: "s1", text: "先别改", delivery: "steer" }),
    ).toMatchObject({ delivery: "steer" });
    expect(
      parseC2S({ type: "chat.queue.remove", sid: "s1", queueId: "q1" }),
    ).toMatchObject({ queueId: "q1" });
    expect(
      parseC2S({ type: "chat.queue.guide", sid: "s1", queueId: "q1" }),
    ).toMatchObject({ queueId: "q1" });
    expect(() =>
      parseC2S({ type: "chat.send", sid: "s1", text: "x", delivery: "now" }),
    ).toThrowError(ProtocolError);
    expect(
      parseC2S({ type: "permission.respond", sid: "s1", reqId: "p1", reply: "always" }),
    ).toMatchObject({ reply: "always" });
    // reply 必须是三选一
    expect(() =>
      parseC2S({ type: "permission.respond", sid: "s1", reqId: "p1", reply: "yes" }),
    ).toThrowError(ProtocolError);
    // 既没字也没图 —— 拒绝
    expect(() => parseC2S({ type: "chat.send", sid: "s1", text: "" })).toThrowError(
      ProtocolError,
    );
    expect(() => parseC2S({ type: "chat.send", sid: "s1", text: "   " })).toThrowError(
      ProtocolError,
    );
    // 只发图不带字是合理的:一张报错截图本身就是问题
    expect(
      parseC2S({
        type: "chat.send",
        sid: "s1",
        text: "",
        attachments: [{ mimeType: "image/jpeg", dataB64: "AAAA" }],
      }),
    ).toMatchObject({ attachments: [{ mimeType: "image/jpeg" }] });
    // 不认的图片格式被拒(iOS 的 HEIC 必须在客户端先转)
    expect(() =>
      parseC2S({
        type: "chat.send",
        sid: "s1",
        text: "x",
        attachments: [{ mimeType: "image/heic", dataB64: "AAAA" }],
      }),
    ).toThrowError(ProtocolError);
  });

  it("session.create 可指定 kind,省略则由 daemon 决定", () => {
    expect(
      parseC2S({ type: "session.create", agent: "opencode", kind: "structured", cols: 80, rows: 24 }),
    ).toMatchObject({ kind: "structured" });
    expect(
      parseC2S({ type: "session.create", agent: "opencode", cols: 80, rows: 24 }),
    ).not.toHaveProperty("kind");
    expect(() =>
      parseC2S({ type: "session.create", agent: "opencode", kind: "chat", cols: 80, rows: 24 }),
    ).toThrowError(ProtocolError);
    expect(
      parseC2S({
        type: "session.create",
        agent: "codex",
        kind: "structured",
        mode: "plan",
        model: "gpt-5.6-sol",
        effort: "high",
        resume: { id: "thread-1", title: "已有对话" },
        cols: 80,
        rows: 24,
      }),
    ).toMatchObject({
      mode: "plan",
      model: "gpt-5.6-sol",
      effort: "high",
      resume: { id: "thread-1" },
    });
    expect(() =>
      parseC2S({
        type: "session.create",
        agent: "codex",
        kind: "structured",
        effort: "high",
        cols: 80,
        rows: 24,
      }),
    ).toThrowError(ProtocolError);
    expect(() =>
      parseC2S({
        type: "session.create",
        agent: "codex",
        kind: "pty",
        model: "gpt-5.6-sol",
        cols: 80,
        rows: 24,
      }),
    ).toThrowError(ProtocolError);
    expect(() =>
      parseC2S({
        type: "session.create",
        agent: "codex",
        mode: "ask",
        cols: 80,
        rows: 24,
      }),
    ).toThrowError(ProtocolError);
    expect(
      parseC2S({
        type: "session.create",
        agent: "codex",
        kind: "structured",
        goal: "把手机端做成可验收的编排面板",
        cols: 80,
        rows: 24,
      }),
    ).toMatchObject({ goal: "把手机端做成可验收的编排面板" });
    expect(() =>
      parseC2S({
        type: "session.create",
        agent: "codex",
        goal: "不该创建 PTY Goal",
        cols: 80,
        rows: 24,
      }),
    ).toThrowError(ProtocolError);
    expect(() =>
      parseC2S({
        type: "session.create",
        agent: "codex",
        kind: "structured",
        goal: "不能接回旧会话",
        resume: { id: "old-thread" },
        cols: 80,
        rows: 24,
      }),
    ).toThrowError(ProtocolError);
    expect(
      parseC2S({
        type: "session.create",
        agent: "codex",
        accountId: "account-work",
        cwd: "/tmp/same-project",
        cols: 80,
        rows: 24,
      }),
    ).toMatchObject({ accountId: "account-work", cwd: "/tmp/same-project" });
  });

  it("Code Agent 账号管理与受限凭据导入消息可校验", () => {
    expect(parseC2S({
      type: "agent.account.create",
      requestId: "account-create-1",
      agent: "claude",
      name: "工作账号",
    })).toMatchObject({ agent: "claude", name: "工作账号" });
    expect(parseC2S({
      type: "agent.account.login",
      requestId: "account-login-1",
      accountId: "account-1",
      cols: 80,
      rows: 24,
    })).toMatchObject({ accountId: "account-1" });
    expect(parseC2S({
      type: "agent.account.credential.set",
      requestId: "account-credential-1",
      accountId: "account-1",
      credentialKind: "oauth_token",
      credential: "sk-ant-oat01-example-token-long-enough",
    })).toMatchObject({ accountId: "account-1", credentialKind: "oauth_token" });
    expect(() => parseC2S({
      type: "agent.account.credential.set",
      requestId: "account-credential-short",
      accountId: "account-1",
      credentialKind: "oauth_token",
      credential: "too-short",
    })).toThrowError(ProtocolError);
    expect(() => parseC2S({
      type: "agent.account.create",
      requestId: "account-create-2",
      agent: "opencode",
      name: "不支持",
    })).toThrowError(ProtocolError);

    expect(parseS2C({
      type: "agent.accounts.result",
      requestId: "account-list-1",
      action: "list",
      ok: true,
      accounts: [{
        id: "native-codex",
        agent: "codex",
        name: "本机默认",
        managed: false,
        isDefault: true,
        status: "signed_in",
        authMethod: "ChatGPT",
        createdAt: 0,
        updatedAt: 0,
        activeSessions: 0,
      }],
    })).toMatchObject({ accounts: [{ id: "native-codex", status: "signed_in" }] });
  });

  it("编排快照与手机 Gate 决策可往返校验", () => {
    expect(
      parseC2S({ type: "orchestration.gate.resolve", gateId: "gate-1", decision: "继续" }),
    ).toMatchObject({ gateId: "gate-1" });
    expect(
      parseS2C({
        type: "orchestration.snapshot",
        snapshot: {
          runs: [{
            id: "run-1",
            objective: "发布移动端",
            status: "active",
            coordinatorSessionId: "session-1",
            automation: {
              state: "running",
              agent: "codex",
              approvalPolicy: "standard",
              workspace: "run",
              cwd: "/tmp/project",
              workspacePath: "/tmp/worktrees/run-1",
              branch: "prospero/run-1/auto",
              startedAt: 1,
              updatedAt: 1,
              lastError: null,
            },
            createdAt: 1,
            updatedAt: 1,
          }],
          tasks: [],
          dispatches: [],
          gates: [],
        },
      }),
    ).toMatchObject({ type: "orchestration.snapshot", snapshot: { runs: [{ id: "run-1" }] } });
  });

  it("人工 Run、任务与 worker 派发消息可校验", () => {
    expect(parseC2S({
      type: "orchestration.run.create",
      objective: "滚动升级兼容",
    })).toMatchObject({ objective: "滚动升级兼容" });
    expect(parseC2S({
      type: "orchestration.task.create",
      runId: "run-1",
      title: "握手回退",
      spec: "支持 v9/v8/v7/v5",
      deps: ["task-0"],
    })).toMatchObject({ deps: ["task-0"] });
    expect(parseC2S({
      type: "orchestration.worker.start",
      taskId: "task-1",
      agent: "codex",
      worktree: "new",
      cwd: "/tmp/project",
      approvalPolicy: "standard",
    })).toMatchObject({ agent: "codex", worktree: "new" });
    expect(parseC2S({
      type: "orchestration.worker.stop",
      taskId: "task-1",
      reason: "先停下来检查",
      operationId: "stop-1",
    })).toMatchObject({ taskId: "task-1", reason: "先停下来检查" });
    expect(parseC2S({
      type: "orchestration.task.cancel",
      taskId: "task-2",
      operationId: "cancel-1",
    })).toMatchObject({ taskId: "task-2" });
    expect(parseC2S({
      type: "orchestration.task.retry",
      taskId: "task-3",
      operationId: "retry-1",
    })).toMatchObject({ taskId: "task-3" });
  });

  it("可视化任务图支持原子新建、revision 编辑与 operationId", () => {
    const created = parseC2S({
      type: "orchestration.graph.create",
      operationId: "op-create",
      objective: "发布",
      nodes: [
        { clientId: "design", title: "设计", spec: "定协议", deps: [] },
        { clientId: "ship", title: "发布", spec: "发版本", deps: ["design"] },
      ],
    });
    expect(created).toMatchObject({ operationId: "op-create" });
    expect(created).toHaveProperty("nodes.0.clientId", "design");
    expect(parseC2S({
      type: "orchestration.graph.apply",
      operationId: "op-apply",
      runId: "run-1",
      baseRevision: 3,
      nodes: [],
      deleteTaskIds: ["task-1"],
    })).toMatchObject({ runId: "run-1", baseRevision: 3, deleteTaskIds: ["task-1"] });
    expect(parseC2S({
      type: "orchestration.run.delete",
      operationId: "op-delete-run",
      runId: "run-1",
    })).toMatchObject({ runId: "run-1" });
    expect(() => parseC2S({
      type: "orchestration.graph.create",
      objective: "缺少幂等键",
      nodes: [{ clientId: "a", title: "A", spec: "A", deps: [] }],
    })).toThrowError(ProtocolError);
  });

  it("静态任务图可启动、恢复或暂停自动执行", () => {
    expect(parseC2S({
      type: "orchestration.automation.start",
      operationId: "auto-start",
      runId: "run-1",
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "run",
      cwd: "/tmp/project",
    })).toMatchObject({ runId: "run-1", workspace: "run" });
    expect(parseC2S({
      type: "orchestration.automation.pause",
      operationId: "auto-pause",
      runId: "run-1",
    })).toMatchObject({ runId: "run-1" });
    expect(() => parseC2S({
      type: "orchestration.automation.start",
      operationId: "bad-auto",
      runId: "run-1",
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "per-task",
      cwd: "/tmp/project",
    })).toThrowError(ProtocolError);
  });

  it("本机可恢复对话搜索与完成态可往返校验", () => {
    expect(
      parseC2S({
        type: "conversation.search",
        requestId: "search-1",
        agent: "claude",
        query: "Prospero",
        limit: 12,
      }),
    ).toMatchObject({ requestId: "search-1", agent: "claude" });
    expect(
      parseS2C({
        type: "conversation.results",
        requestId: "search-1",
        agent: "claude",
        conversations: [{
          id: "session-1",
          agent: "claude",
          title: "修复手机端",
          cwd: "/tmp/prospero",
          updatedAt: 123,
        }],
      }),
    ).toMatchObject({ conversations: [{ id: "session-1" }] });
    expect(
      parseS2C({
        type: "session.state",
        session: {
          id: "s1",
          agent: "codex",
          kind: "structured",
          title: "Codex",
          cwd: "/tmp",
          status: "completed",
          createdAt: 1,
          cols: 80,
          rows: 24,
        },
      }),
    ).toMatchObject({ session: { status: "completed" } });
  });

  it("每种 agent 事件体都能往返校验", () => {
    const bodies: AgentEventBody[] = [
      { kind: "user.message", msgId: "m1", text: "hello" },
      { kind: "text.delta", msgId: "m2", textId: "t1", delta: "PON" },
      { kind: "reasoning.delta", msgId: "m2", delta: "thinking…" },
      { kind: "tool.start", msgId: "m2", callId: "c1", tool: "bash", summary: "ls -la" },
      { kind: "tool.end", callId: "c1", state: "success", summary: "3 files" },
      {
        kind: "permission.request",
        reqId: "p1",
        action: "bash",
        resources: ["rm -rf build"],
        summary: "运行命令",
      },
      { kind: "permission.resolved", reqId: "p1", reply: "once" },
      {
        kind: "question.request",
        reqId: "q1",
        questions: [{
          id: "target",
          header: "范围",
          question: "先做哪一端？",
          options: [{ label: "iOS" }, { label: "Mac" }],
          multiSelect: false,
          allowOther: true,
        }],
      },
      {
        kind: "question.resolved",
        reqId: "q1",
        answers: [{ questionId: "target", values: ["iOS"] }],
      },
      {
        kind: "subagent.started",
        subagent: {
          id: "child-1",
          name: "reviewer",
          status: "running",
          canMessage: true,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      { kind: "subagent.updated", subagentId: "child-1", status: "completed" },
      { kind: "turn.end", msgId: "m2", finish: "stop", costUsd: 0.01, outputTokens: 12 },
      { kind: "agent.error", message: "provider auth failed" },
    ];
    for (const b of bodies) {
      expect(AgentEventBodySchema.parse(b)).toEqual(b);
      expect(parseS2C({ type: "agent.event", sid: "s1", evSeq: 1, body: b })).toMatchObject({
        body: { kind: b.kind },
      });
    }
  });

  it("chat.snapshot 承载事件历史", () => {
    const snap = parseS2C({
      type: "chat.snapshot",
      sid: "s1",
      evSeq: 3,
      events: [
        { kind: "user.message", msgId: "m1", text: "hi" },
        { kind: "text.delta", msgId: "m2", textId: "t1", delta: "yo" },
        { kind: "turn.end", msgId: "m2" },
      ],
    });
    expect(snap).toMatchObject({ type: "chat.snapshot", evSeq: 3 });
    expect((snap as { events: unknown[] }).events).toHaveLength(3);
  });

  it("chat.complete 与 chat.suggestions 校验输入框候选", () => {
    expect(
      parseC2S({
        type: "chat.complete",
        sid: "s1",
        requestId: "req-1",
        kind: "file",
        query: "src/app",
      }),
    ).toMatchObject({ requestId: "req-1", kind: "file" });
    expect(
      parseS2C({
        type: "chat.suggestions",
        sid: "s1",
        requestId: "req-1",
        kind: "skill",
        items: [
          { kind: "skill", value: "openai-docs", label: "openai-docs", detail: "Codex" },
        ],
      }),
    ).toMatchObject({ items: [{ value: "openai-docs" }] });
    expect(() =>
      parseC2S({
        type: "chat.complete",
        sid: "s1",
        requestId: "req-2",
        kind: "directory",
        query: "src",
      }),
    ).toThrowError(ProtocolError);
  });

  it("Agent 控制消息校验模型、Plan 模式与原生 compact", () => {
    expect(parseC2S({
      type: "launch.models.get",
      requestId: "launch-models-1",
      agent: "codex",
      accountId: "account-work",
    })).toMatchObject({ agent: "codex", accountId: "account-work" });
    expect(parseS2C({
      type: "launch.models",
      requestId: "launch-models-1",
      agent: "codex",
      currentModel: "gpt-5.6-sol",
      currentEffort: "high",
      models: [{
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        supportedEfforts: ["low", "high"],
      }],
    })).toMatchObject({ models: [{ id: "gpt-5.6-sol" }] });
    expect(parseC2S({
      type: "agent.models.get",
      sid: "s1",
      requestId: "models-1",
    })).toMatchObject({ requestId: "models-1" });
    expect(parseC2S({
      type: "agent.model.set",
      sid: "s1",
      requestId: "set-1",
      model: "gpt-5.6-sol",
      effort: "high",
    })).toMatchObject({ model: "gpt-5.6-sol", effort: "high" });
    expect(parseC2S({
      type: "agent.modes.get",
      sid: "s1",
      requestId: "modes-1",
    })).toMatchObject({ requestId: "modes-1" });
    expect(parseC2S({
      type: "agent.mode.set",
      sid: "s1",
      requestId: "mode-1",
      mode: "plan",
    })).toMatchObject({ mode: "plan" });
    expect(parseC2S({
      type: "agent.compact",
      sid: "s1",
      requestId: "compact-1",
    })).toMatchObject({ type: "agent.compact" });

    expect(parseS2C({
      type: "agent.models",
      sid: "s1",
      requestId: "models-1",
      currentModel: "gpt-5.6-sol",
      currentEffort: "high",
      models: [{
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        supportedEfforts: ["low", "high"],
        defaultEffort: "low",
        isDefault: true,
      }],
    })).toMatchObject({ models: [{ id: "gpt-5.6-sol" }] });
    expect(parseS2C({
      type: "agent.control.result",
      sid: "s1",
      requestId: "set-1",
      action: "model.set",
      ok: true,
      currentModel: "gpt-5.6-sol",
    })).toMatchObject({ ok: true, action: "model.set" });
    expect(parseS2C({
      type: "agent.modes",
      sid: "s1",
      requestId: "modes-1",
      currentMode: "plan",
      modes: [{ id: "default", label: "执行" }, { id: "plan", label: "Plan" }],
    })).toMatchObject({ currentMode: "plan" });
    expect(parseC2S({
      type: "question.respond",
      sid: "s1",
      reqId: "q1",
      answers: [{ questionId: "target", values: ["iOS"] }],
    })).toMatchObject({ reqId: "q1" });
    expect(parseC2S({
      type: "subagent.send",
      sid: "s1",
      subagentId: "child-1",
      text: "先检查测试",
    })).toMatchObject({ subagentId: "child-1" });
    expect(parseC2S({
      type: "subagent.history.get",
      sid: "s1",
      subagentId: "child-1",
      requestId: "history-1",
    })).toMatchObject({ subagentId: "child-1", requestId: "history-1" });
    expect(parseS2C({
      type: "subagent.history.result",
      sid: "s1",
      subagentId: "child-1",
      requestId: "history-1",
      events: [{
        kind: "text.delta",
        msgId: "answer-1",
        textId: "answer-1",
        delta: "检查完成",
        agentId: "child-1",
      }],
    })).toMatchObject({ events: [{ kind: "text.delta", agentId: "child-1" }] });
  });

  it("拒绝未知 kind 与缺字段", () => {
    expect(() => AgentEventBodySchema.parse({ kind: "nope" })).toThrow();
    expect(() =>
      parseS2C({ type: "agent.event", sid: "s1", evSeq: 1, body: { kind: "tool.end", callId: "c" } }),
    ).toThrowError(ProtocolError);
  });

  it("SessionInfo 带 kind 与待审批计数", () => {
    const ok = parseS2C({
      type: "session.state",
      session: {
        id: "s1",
        agent: "opencode",
        kind: "structured",
        title: "opencode · repo",
        cwd: "/tmp",
        status: "waiting_approval",
        createdAt: 1,
        cols: 80,
        rows: 24,
        pendingPermissions: 1,
        messageQueue: [
          { id: "q1", text: "下一步跑测试", kind: "queue", createdAt: 2, attachmentCount: 0 },
        ],
        agentControls: {
          compact: true,
          model: true,
          mode: true,
          currentModel: "gpt-5.6-sol",
          currentEffort: "medium",
          currentMode: "plan",
        },
        pendingQuestions: 1,
        subagents: [{
          id: "child-1",
          name: "reviewer",
          status: "running",
          canMessage: true,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });
    expect(ok).toMatchObject({
      session: {
        kind: "structured",
        pendingPermissions: 1,
        messageQueue: [{ id: "q1" }],
        agentControls: { compact: true, currentModel: "gpt-5.6-sol" },
      },
    });
  });
});
