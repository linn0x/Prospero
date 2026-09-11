export const sessionId = index => `session-${String(index).padStart(9, "0")}`;
export const taskId = index => `task-${String(index).padStart(9, "0")}`;
export const runId = index => `run-${String(Math.floor(index / 100)).padStart(7, "0")}`;

export function session(index) {
  return {
    version: 1, id: sessionId(index), agent: "codex", title: `Archive ${index}`, cwd: "/synthetic",
    createdAt: index + 1, approvalPolicy: "standard", preview: "", previewRaw: "", previewMsgId: "",
    totals: { costUsd: 0, inputTokens: 0, outputTokens: 0 }, evSeq: 1, adapterState: {}, terminal: true,
    events: [], toolOutputs: [], messageQueue: [],
  };
}

export function task(index) {
  return {
    id: taskId(index), runId: runId(index), title: `Task ${index}`, spec: "x".repeat(1024), skills: [],
    deps: index % 100 ? [taskId(index - 1)] : [], parentId: null, status: "pending", result: null,
    createdAt: index + 1, updatedAt: index + 1,
  };
}

export function run(index) {
  return {
    id: runId(index), objective: `Run ${Math.floor(index / 100)}`, status: "active",
    coordinatorSessionId: null, graphRevision: 1, automation: null, coordinatorPrompt: null,
    createdAt: index + 1, updatedAt: index + 1,
  };
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)].toFixed(3));
}
