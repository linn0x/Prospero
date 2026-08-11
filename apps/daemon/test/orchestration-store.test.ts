import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestrationError, OrchestrationStore } from "../src/orchestration/store.js";
import { canTransition, findCycle, isReady, type Task } from "../src/orchestration/model.js";

const dirs: string[] = [];
function tmpHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-orch-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(): { store: OrchestrationStore; runId: string } {
  const store = new OrchestrationStore();
  const run = store.createRun({ objective: "把编排跑通" });
  return { store, runId: run.id };
}

describe("Run 与 Task", () => {
  it("建任务、按 Run 列出、依赖必须真实存在", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "做 A" });
    const b = store.createTask({ runId, title: "B", spec: "做 B", deps: [a.id] });

    expect(store.listTasks(runId).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(() => store.createTask({ runId, title: "C", spec: "", deps: ["task_nope"] }))
      .toThrow(/依赖的任务不存在/);
  });

  it("依赖跨 Run 会被拒 —— 否则调度得跨 Run 找前置,语义就散了", () => {
    const { store, runId } = seed();
    const other = store.createRun({ objective: "另一件事" });
    const a = store.createTask({ runId, title: "A", spec: "" });
    expect(() => store.createTask({ runId: other.id, title: "B", spec: "", deps: [a.id] }))
      .toThrow(/属于别的 Run/);
  });

  it("只有任务图结构变化才递增 revision，状态流转不会制造伪冲突", () => {
    const { store, runId } = seed();
    const task = store.createTask({ runId, title: "A", spec: "做 A" });
    expect(store.getRun(runId).graphRevision).toBe(1);
    store.createDispatch({ taskId: task.id, sessionId: "s1" });
    store.setTaskStatus(task.id, "done");
    expect(store.getRun(runId).graphRevision).toBe(1);
    const next = store.createTask({ runId, title: "B", spec: "做 B" });
    store.setTaskDeps(next.id, [task.id]);
    expect(store.getRun(runId).graphRevision).toBe(3);
  });
});

describe("原子任务图", () => {
  it("一次创建 Run 和整张 DAG，并把临时节点 id 映射为持久 task id", () => {
    const store = new OrchestrationStore();
    const result = store.createRunGraph({
      objective: "发布新版本",
      nodes: [
        { clientId: "design", title: "设计", spec: "定协议", deps: [] },
        { clientId: "mac", title: "Mac", spec: "实现 Mac", deps: ["design"] },
        { clientId: "ios", title: "iOS", spec: "实现 iOS", deps: ["design"] },
        { clientId: "ship", title: "发布", spec: "联合验收", deps: ["mac", "ios"] },
      ],
    });

    expect(result.run.graphRevision).toBe(1);
    expect(result.tasks).toHaveLength(4);
    expect(store.getTask(result.idMap["ship"]!).deps).toEqual([
      result.idMap["mac"],
      result.idMap["ios"],
    ]);
    expect(store.listReadyTasks(result.run.id).map((task) => task.title)).toEqual(["设计"]);
  });

  it("未知依赖或环让整次新建回滚，不留下 Run 或任务", () => {
    const store = new OrchestrationStore();
    expect(() => store.createRunGraph({
      objective: "坏图",
      nodes: [{ clientId: "a", title: "A", spec: "A", deps: ["missing"] }],
    })).toThrow(/不存在/);
    expect(store.listRuns()).toEqual([]);
    expect(store.listTasks()).toEqual([]);

    expect(() => store.createRunGraph({
      objective: "环",
      nodes: [
        { clientId: "a", title: "A", spec: "A", deps: ["b"] },
        { clientId: "b", title: "B", spec: "B", deps: ["a"] },
      ],
    })).toThrow(/成环/);
    expect(store.listRuns()).toEqual([]);
    expect(store.listTasks()).toEqual([]);
  });

  it("按 revision 原子编辑 pending 节点并新增依赖节点", () => {
    const store = new OrchestrationStore();
    const initial = store.createRunGraph({
      objective: "继续编辑",
      nodes: [{ clientId: "a", title: "A", spec: "旧说明", deps: [] }],
    });
    const a = initial.idMap["a"]!;
    const applied = store.applyTaskGraph({
      runId: initial.run.id,
      baseRevision: 1,
      nodes: [
        { clientId: a, title: "A2", spec: "新说明", deps: [] },
        { clientId: "new-b", title: "B", spec: "依赖 A", deps: [a] },
      ],
    });

    expect(applied.run.graphRevision).toBe(2);
    expect(store.getTask(a)).toMatchObject({ title: "A2", spec: "新说明" });
    expect(store.getTask(applied.idMap["new-b"]!).deps).toEqual([a]);
  });

  it("过期 revision 或编辑已派发任务会拒绝且不产生局部改动", () => {
    const store = new OrchestrationStore();
    const initial = store.createRunGraph({
      objective: "冲突保护",
      nodes: [{ clientId: "a", title: "A", spec: "原始", deps: [] }],
    });
    const a = initial.idMap["a"]!;
    expect(() => store.applyTaskGraph({
      runId: initial.run.id,
      baseRevision: 0,
      nodes: [{ clientId: a, title: "不应写入", spec: "x", deps: [] }],
    })).toThrow(/已经更新/);
    expect(store.getTask(a).title).toBe("A");

    store.createDispatch({ taskId: a, sessionId: "worker" });
    expect(() => store.applyTaskGraph({
      runId: initial.run.id,
      baseRevision: 1,
      nodes: [
        { clientId: a, title: "也不应写入", spec: "x", deps: [] },
        { clientId: "new", title: "不能残留", spec: "x", deps: [] },
      ],
    })).toThrow(/只能编辑 pending/);
    expect(store.getTask(a).title).toBe("A");
    expect(store.listTasks(initial.run.id)).toHaveLength(1);
  });

  it("可原子删除 pending 节点并同时重连依赖", () => {
    const store = new OrchestrationStore();
    const initial = store.createRunGraph({
      objective: "删改任务图",
      nodes: [
        { clientId: "a", title: "A", spec: "A", deps: [] },
        { clientId: "b", title: "B", spec: "B", deps: ["a"] },
      ],
    });
    const a = initial.idMap["a"]!;
    const b = initial.idMap["b"]!;

    const applied = store.applyTaskGraph({
      runId: initial.run.id,
      baseRevision: 1,
      nodes: [{ clientId: b, title: "B", spec: "不再依赖 A", deps: [] }],
      deleteTaskIds: [a],
    });

    expect(applied.deletedTaskIds).toEqual([a]);
    expect(applied.run.graphRevision).toBe(2);
    expect(store.listTasks(initial.run.id)).toEqual([
      expect.objectContaining({ id: b, deps: [] }),
    ]);
    expect(() => store.getTask(a)).toThrow(/找不到任务/);
  });

  it("删除仍被引用或已经派发的节点会整体拒绝", () => {
    const store = new OrchestrationStore();
    const initial = store.createRunGraph({
      objective: "删除保护",
      nodes: [
        { clientId: "a", title: "A", spec: "A", deps: [] },
        { clientId: "b", title: "B", spec: "B", deps: ["a"] },
      ],
    });
    const a = initial.idMap["a"]!;

    expect(() => store.applyTaskGraph({
      runId: initial.run.id,
      baseRevision: 1,
      nodes: [],
      deleteTaskIds: [a],
    })).toThrow(/依赖的任务不存在/);
    expect(store.listTasks(initial.run.id)).toHaveLength(2);

    store.createDispatch({ taskId: a, sessionId: "worker" });
    expect(() => store.applyTaskGraph({
      runId: initial.run.id,
      baseRevision: 1,
      nodes: [],
      deleteTaskIds: [a],
    })).toThrow(/只能删除 pending/);
    expect(store.listTasks(initial.run.id)).toHaveLength(2);
  });
});

describe("Run 管理", () => {
  it("删除 Run 会清理编排记录，但保留自动执行工作树路径供用户回收代码", () => {
    const { store, runId } = seed();
    const task = store.createTask({ runId, title: "实现", spec: "实现删除" });
    const dispatch = store.createDispatch({ taskId: task.id, sessionId: "worker" });
    store.setDispatchState(dispatch.id, "succeeded", "ok");
    store.setTaskStatus(task.id, "done", "完成");
    store.postMessage({
      runId,
      taskId: task.id,
      from: "worker",
      to: "owner",
      type: "report",
      subject: "完成",
      body: "ok",
    });
    store.createGate({ runId, question: "保留吗？" });
    store.setRunAutomation(runId, {
      state: "paused",
      agent: "codex",
      approvalPolicy: "standard",
      workspace: "run",
      cwd: "/tmp/project",
      workspacePath: "/tmp/prospero-run",
      branch: "prospero/run/test",
      startedAt: 1,
      updatedAt: 2,
      lastError: null,
    });

    expect(store.deleteRun(runId)).toEqual({
      runId,
      deletedTaskCount: 1,
      preservedWorkspacePath: "/tmp/prospero-run",
    });
    expect(store.listRuns()).toEqual([]);
    expect(store.listTasks()).toEqual([]);
    expect(store.listDispatches()).toEqual([]);
    expect(store.listMessages()).toEqual([]);
    expect(store.listGates()).toEqual([]);
  });

  it("仍有活动 worker 时拒绝删除 Run", () => {
    const { store, runId } = seed();
    const task = store.createTask({ runId, title: "运行中", spec: "" });
    store.createDispatch({ taskId: task.id, sessionId: "worker" });

    expect(() => store.deleteRun(runId)).toThrow(/仍有 worker/);
    expect(store.getRun(runId).id).toBe(runId);
  });
});

describe("ready 是派生的", () => {
  it("依赖没做完就不算 ready,做完了自动就 ready —— 不需要谁去改状态", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    const b = store.createTask({ runId, title: "B", spec: "", deps: [a.id] });

    expect(store.listReadyTasks(runId).map((t) => t.id)).toEqual([a.id]);

    store.createDispatch({ taskId: a.id, sessionId: "s1" });
    store.setTaskStatus(a.id, "done", "干完了");

    expect(store.listReadyTasks(runId).map((t) => t.id)).toEqual([b.id]);
  });

  it("依赖被取消不等于放行 —— 前提没了就该有人显式改依赖", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    const b = store.createTask({ runId, title: "B", spec: "", deps: [a.id] });
    store.setTaskStatus(a.id, "cancelled");
    expect(store.listReadyTasks(runId).map((t) => t.id)).toEqual([]);
    expect(store.getTask(b.id).status).toBe("pending");
  });
});

describe("成环检测", () => {
  it("改依赖改出环会被拒,而且原依赖要还原回去", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    const b = store.createTask({ runId, title: "B", spec: "", deps: [a.id] });
    const c = store.createTask({ runId, title: "C", spec: "", deps: [b.id] });

    expect(() => store.setTaskDeps(a.id, [c.id])).toThrow(/成环/);
    // 失败之后不能留下半改的状态
    expect(store.getTask(a.id).deps).toEqual([]);
    expect(store.listReadyTasks(runId).map((t) => t.id)).toEqual([a.id]);
  });

  it("自依赖也是环", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    expect(() => store.setTaskDeps(a.id, [a.id])).toThrow(/成环/);
  });

  it("findCycle 报得出环上的路径", () => {
    const mk = (id: string, deps: string[]): Task => ({
      id, runId: "r", title: id, spec: "", deps, parentId: null,
      status: "pending", result: null, createdAt: 0, updatedAt: 0,
    });
    const map = new Map([
      ["a", mk("a", ["b"])],
      ["b", mk("b", ["c"])],
      ["c", mk("c", ["a"])],
    ]);
    const cycle = findCycle(map);
    expect(cycle).not.toBeNull();
    expect(cycle?.[0]).toBe(cycle?.[cycle.length - 1]);
  });

  it("菱形依赖不是环", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    const b = store.createTask({ runId, title: "B", spec: "", deps: [a.id] });
    const c = store.createTask({ runId, title: "C", spec: "", deps: [a.id] });
    expect(() => store.createTask({ runId, title: "D", spec: "", deps: [b.id, c.id] })).not.toThrow();
  });
});

describe("状态机", () => {
  it("done 是终态,不能被改回去 —— 要改就新建任务,别改历史", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    store.createDispatch({ taskId: a.id, sessionId: "s1" });
    store.setTaskStatus(a.id, "done");
    expect(() => store.setTaskStatus(a.id, "pending")).toThrow(/不能从 done/);
  });

  it("failed 可以退回 pending 重试", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    store.createDispatch({ taskId: a.id, sessionId: "s1" });
    store.setTaskStatus(a.id, "failed", "编译不过");
    expect(() => store.setTaskStatus(a.id, "pending")).not.toThrow();
  });

  it("同状态自转是幂等的 —— 重试的命令不该炸", () => {
    expect(canTransition("done", "done")).toBe(true);
    expect(canTransition("pending", "done")).toBe(false);
  });

  it("已派发的任务不能再派一次 —— 否则两个 worker 会在同一份代码上互相覆盖", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    store.createDispatch({ taskId: a.id, sessionId: "s1" });
    expect(() => store.createDispatch({ taskId: a.id, sessionId: "s2" }))
      .toThrow(OrchestrationError);
  });

  it("可取消 pending/blocked 任务并关闭关联 Gate，但不能越过取消的依赖", () => {
    const { store, runId } = seed();
    const first = store.createTask({ runId, title: "前置", spec: "" });
    const dependent = store.createTask({ runId, title: "后置", spec: "", deps: [first.id] });
    const gate = store.createGate({ runId, taskId: first.id, question: "还做吗？" });

    expect(store.getTask(first.id).status).toBe("blocked");
    expect(store.cancelTask(first.id, "需求已撤销")).toMatchObject({
      status: "cancelled",
      result: "需求已撤销",
    });
    expect(store.getGate(gate.id)).toMatchObject({ status: "cancelled" });
    expect(store.listReadyTasks(runId).map((task) => task.id)).not.toContain(dependent.id);
  });

  it("failed 任务可清除旧结果后退回 pending，活动 worker 存在时不能直接取消", () => {
    const { store, runId } = seed();
    const task = store.createTask({ runId, title: "重试", spec: "" });
    const dispatch = store.createDispatch({ taskId: task.id, sessionId: "worker" });
    expect(() => store.cancelTask(task.id)).toThrow(/先停止 worker/);

    store.setDispatchState(dispatch.id, "failed", "失败");
    store.setTaskStatus(task.id, "failed", "旧错误");
    expect(store.retryTask(task.id)).toMatchObject({ status: "pending", result: null });
    expect(() => store.retryTask(task.id)).toThrow(/只有 failed/);
  });
});

describe("派发", () => {
  it("绕过 ready 列表直接写 dispatch 也会被拒绝 —— 依赖是派发边界的硬约束", () => {
    const { store, runId } = seed();
    const first = store.createTask({ runId, title: "前置", spec: "" });
    const dependent = store.createTask({ runId, title: "后置", spec: "", deps: [first.id] });
    expect(() => store.createDispatch({ taskId: dependent.id, sessionId: "s1" }))
      .toThrow(/依赖尚未全部完成/);
  });

  it("落定之后就不再是 active dispatch", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    const d = store.createDispatch({ taskId: a.id, sessionId: "s1" });

    expect(store.activeDispatchFor(a.id)?.id).toBe(d.id);
    store.setDispatchState(d.id, "succeeded", "ok");
    expect(store.activeDispatchFor(a.id)).toBeNull();
    expect(store.getDispatch(d.id).settledAt).not.toBeNull();
  });

  it("记住的是持久的会话 id —— daemon 重启后它照样指向同一个 agent", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    const d = store.createDispatch({ taskId: a.id, sessionId: "sess-42", worktreePath: "/tmp/wt" });
    expect(d.sessionId).toBe("sess-42");
    expect(d.worktreePath).toBe("/tmp/wt");
  });
});

describe("邮箱", () => {
  it("只给收件人、只给未读,按时间正序", () => {
    const { store, runId } = seed();
    store.postMessage({ runId, from: "w1", to: "coord", type: "report", subject: "一", body: "" });
    const m2 = store.postMessage({ runId, from: "w2", to: "coord", type: "ask", subject: "二", body: "" });
    store.postMessage({ runId, from: "coord", to: "w1", type: "note", subject: "三", body: "" });

    const inbox = store.unreadFor("coord");
    expect(inbox.map((m) => m.subject)).toEqual(["一", "二"]);

    store.markRead([inbox[0]!.id]);
    expect(store.unreadFor("coord").map((m) => m.id)).toEqual([m2.id]);
  });

  it("markRead 幂等,重复 ack 不会改已读时间", () => {
    const { store, runId } = seed();
    const m = store.postMessage({ runId, from: "w1", to: "coord", type: "note", subject: "x", body: "" });
    store.markRead([m.id]);
    const first = store.getMessage(m.id).readAt;
    store.markRead([m.id]);
    expect(store.getMessage(m.id).readAt).toBe(first);
  });

  it("markAnswered 也幂等，ask 被 reply 和 wait 同时收尾时不改写审计时间", () => {
    const { store, runId } = seed();
    const ask = store.postMessage({
      runId, from: "worker", to: "coord", type: "ask", subject: "要决定", body: "",
    });
    store.markAnswered(ask.id);
    const first = store.getMessage(ask.id).answeredAt;
    store.markAnswered(ask.id);
    expect(store.getMessage(ask.id).answeredAt).toBe(first);
  });
});

describe("决策门", () => {
  it("不能拿另一个 Run 的任务建 gate —— 否则 gate 图和任务图会互相说谎", () => {
    const { store, runId } = seed();
    const other = store.createRun({ objective: "另一个 Run" });
    const task = store.createTask({ runId, title: "A", spec: "" });
    expect(() => store.createGate({ runId: other.id, taskId: task.id, question: "继续吗？" }))
      .toThrow(/不属于/);
  });

  it("建门挡住任务,解门退回 pending 重新排队", () => {
    const { store, runId } = seed();
    const a = store.createTask({ runId, title: "A", spec: "" });
    const gate = store.createGate({ runId, taskId: a.id, question: "上不上?", options: ["上", "不上"] });

    expect(store.getTask(a.id).status).toBe("blocked");
    expect(store.listReadyTasks(runId)).toHaveLength(0);

    store.resolveGate(gate.id, "上");
    // 特意不是直接 dispatched:挡着这段时间里依赖和 worker 都可能变了
    expect(store.getTask(a.id).status).toBe("pending");
    expect(store.listReadyTasks(runId).map((t) => t.id)).toEqual([a.id]);
  });

  it("同一任务的其他 pending gate 仍在时，不能被提前放回 pending", () => {
    const { store, runId } = seed();
    const task = store.createTask({ runId, title: "A", spec: "" });
    const first = store.createGate({ runId, taskId: task.id, question: "一？" });
    store.createGate({ runId, taskId: task.id, question: "二？" });
    store.resolveGate(first.id, "好");
    expect(store.getTask(task.id).status).toBe("blocked");
  });

  it("重复提交同一决策是幂等的，试图改写已决策门会被拒绝", () => {
    const { store, runId } = seed();
    const gate = store.createGate({ runId, question: "上吗？" });
    store.resolveGate(gate.id, "上");
    expect(() => store.resolveGate(gate.id, "上")).not.toThrow();
    expect(() => store.resolveGate(gate.id, "不上")).toThrow(/已经是/);
  });
});

describe("落盘", () => {
  it("重开一个 store 能读回全部状态", () => {
    const home = tmpHome();
    const store = new OrchestrationStore(home);
    const run = store.createRun({ objective: "持久化" });
    const task = store.createTask({ runId: run.id, title: "A", spec: "做 A" });
    store.createDispatch({ taskId: task.id, sessionId: "s1" });
    store.close();

    const reopened = new OrchestrationStore(home);
    expect(reopened.listRuns().map((r) => r.objective)).toEqual(["持久化"]);
    expect(reopened.getTask(task.id).status).toBe("dispatched");
    expect(reopened.activeDispatchFor(task.id)?.sessionId).toBe("s1");
  });

  it("文件坏了当空的开始 —— 编排状态坏掉不该让 daemon 起不来", () => {
    const home = tmpHome();
    writeFileSync(path.join(home, "orchestration.json"), "{ 这不是 json");
    const store = new OrchestrationStore(home);
    expect(store.listRuns()).toEqual([]);
    expect(() => store.createRun({ objective: "自愈" })).not.toThrow();
  });

  it("幂等操作记录会落盘，且同一个 id 不能换参数复用", () => {
    const home = tmpHome();
    const store = new OrchestrationStore(home);
    store.rememberOperation("op-1", "fingerprint-a", { runId: "run-1" });
    store.close();

    const reopened = new OrchestrationStore(home);
    expect(reopened.getOperation("op-1")?.result).toEqual({ runId: "run-1" });
    expect(() => reopened.rememberOperation("op-1", "fingerprint-b", {})).toThrow(
      /已用于另一项操作/,
    );
  });
});
