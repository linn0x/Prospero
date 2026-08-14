/**
 * Minimal local Codex app-server stand-in for daemon-process recovery tests.
 * It never contacts a provider: all state lives in this process and its JSONL
 * stdio protocol is just enough for CodexAdapter's production path.
 */
import readline from "node:readline";

let nextTurn = 1;
const turns = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result = {}) {
  send({ id, result });
}

function textFrom(params) {
  const input = Array.isArray(params?.input) ? params.input : [];
  const text = input.find((value) => value?.type === "text")?.text;
  return typeof text === "string" ? text : "";
}

function turnStarted(turnId) {
  send({ method: "turn/started", params: { threadId: "fake-thread", turn: { id: turnId } } });
}

function complete(turn) {
  send({ method: "turn/completed", params: {
    threadId: "fake-thread",
    turn: { id: turn.id, status: "completed" },
  } });
  respond(turn.rpcId, { turn: { id: turn.id, status: "completed" } });
  turns.delete(turn.id);
}

function delta(turnId, value) {
  send({ method: "item/agentMessage/delta", params: {
    threadId: "fake-thread", itemId: `message-${turnId}`, delta: value,
  } });
}

function startTurn(id, params) {
  const text = textFrom(params);
  const turnId = `fake-turn-${String(nextTurn++)}`;
  const turn = { id: turnId, rpcId: id, approval: false, question: false };
  turns.set(turnId, turn);
  turnStarted(turnId);

  const long = text.match(/T7_LONG_([A-Z]+_[A-Za-z0-9_-]+)/);
  if (long) {
    const marker = long[1];
    delta(turnId, `${marker}:started`);
    setTimeout(() => delta(turnId, `${marker}:middle`), 60).unref();
    // Keep the final event far enough away that the test can remove the
    // daemon, leave the supervisor offline, and attach a new daemon first.
    setTimeout(() => {
      delta(turnId, `${marker}:finished`);
      complete(turn);
    }, 1_200).unref();
    return;
  }

  const waiting = text.match(/T7_WAIT_([A-Z]+_[A-Za-z0-9_-]+)/);
  if (waiting) {
    const marker = waiting[1];
    turn.marker = marker;
    send({
      id: `approval-rpc-${marker}`,
      method: "item/commandExecution/requestApproval",
      params: { itemId: `approval-${marker}`, threadId: "fake-thread", command: "printf waiting" },
    });
    send({
      id: `question-rpc-${marker}`,
      method: "item/tool/requestUserInput",
      params: {
        itemId: `question-${marker}`,
        threadId: "fake-thread",
        questions: [{ id: "continue", header: "Continue", question: "continue?", options: [{ label: "yes" }] }],
      },
    });
    return;
  }

  delta(turnId, "fake:worker-prompt-completed");
  setTimeout(() => complete(turn), 10).unref();
}

function maybeCompleteWaitingTurn(turn) {
  if (turn.approval && turn.question) {
    delta(turn.id, `${turn.marker}:resumed`);
    complete(turn);
  }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!request || typeof request !== "object") return;

  if (request.method === "initialize") {
    respond(request.id);
    return;
  }
  if (request.method === "thread/start" || request.method === "thread/resume") {
    respond(request.id, { thread: { id: "fake-thread" } });
    return;
  }
  if (request.method === "thread/list") {
    respond(request.id, { data: [] });
    return;
  }
  if (request.method === "turn/start") {
    startTurn(request.id, request.params);
    return;
  }
  if (request.id === undefined) return;

  if (typeof request.id === "string" && request.id.startsWith("approval-rpc-")) {
    const marker = request.id.slice("approval-rpc-".length);
    const turn = [...turns.values()].find((candidate) => candidate.marker === marker);
    if (turn) {
      turn.approval = true;
      maybeCompleteWaitingTurn(turn);
    }
    return;
  }
  if (typeof request.id === "string" && request.id.startsWith("question-rpc-")) {
    const marker = request.id.slice("question-rpc-".length);
    const turn = [...turns.values()].find((candidate) => candidate.marker === marker);
    if (turn) {
      turn.question = true;
      maybeCompleteWaitingTurn(turn);
    }
    return;
  }

  respond(request.id);
});
