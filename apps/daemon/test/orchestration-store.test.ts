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
});
