import { spawn } from "node:child_process";

export async function createWindowsSessionHostHandler(context) {
  const job = await context.createProviderJob();
  let provider = null;
  let grandchildPid = null;
  let pendingPermission = null;
  let pendingQuestion = null;
  const agentEnvironment = context.handlerOptions?.agentEnvironment;
  if (agentEnvironment !== undefined && (!agentEnvironment || typeof agentEnvironment !== "object" || Array.isArray(agentEnvironment) ||
    !Object.values(agentEnvironment).every((value) => typeof value === "string"))) {
    throw new Error("fake agent environment is invalid");
  }
  return {
    async handleCommand(command) {
      if (command.method === "structured.send") {
        if (!provider) {
          provider = spawn(process.execPath, ["-e", [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            "process.stdout.write(JSON.stringify({ pid: process.pid, grandchildPid: child.pid, home: process.env.HOME, localAppData: process.env.LOCALAPPDATA, repo: process.env.PROSPERO_TEST_REPO }) + '\\n');",
            "setInterval(() => {}, 1000);",
          ].join(" ")], {
            stdio: ["ignore", "pipe", "ignore"],
            ...(agentEnvironment ? { env: { ...process.env, ...agentEnvironment } } : {}),
          });
          await job.registerProcess(provider);
          const line = await new Promise((resolve, reject) => {
            provider.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
            provider.once("error", reject);
          });
          const processInfo = JSON.parse(line);
          if (!Number.isSafeInteger(processInfo.pid) || processInfo.pid !== provider.pid || !Number.isSafeInteger(processInfo.grandchildPid)) {
            throw new Error("fake provider returned invalid process identity");
          }
          grandchildPid = processInfo.grandchildPid;
          provider.environment = {
            home: processInfo.home,
            localAppData: processInfo.localAppData,
            repo: processInfo.repo,
          };
        }
        pendingPermission = "real-native-approval";
        pendingQuestion = "real-native-question";
        await context.emit({ type: "structured.event", evSeq: 1, body: {
          kind: "permission.request", reqId: pendingPermission, action: "fake-native", resources: ["fixture"], summary: "pending",
        } });
        await context.emit({ type: "structured.event", evSeq: 2, body: {
          kind: "question.request", reqId: pendingQuestion, questions: [{ id: "continue", question: "continue fake agent?" }],
        } });
        return { ok: true, result: {
          pendingPermission, pendingQuestion, providerPid: provider.pid, grandchildPid, environment: provider.environment,
        } };
      }
      if (command.method === "structured.respondPermission") {
        if (command.params?.reqId !== pendingPermission) return { ok: false, code: "unknown_request", message: "request is not pending" };
        await context.emit({ type: "structured.event", evSeq: 3, body: {
          kind: "permission.resolved", reqId: pendingPermission, reply: command.params.reply,
        } });
        pendingPermission = null;
        return { ok: true, result: { resolved: true } };
      }
      if (command.method === "structured.respondQuestion") {
        if (command.params?.reqId !== pendingQuestion) return { ok: false, code: "unknown_request", message: "question is not pending" };
        await context.emit({ type: "structured.event", evSeq: 4, body: {
          kind: "question.resolved", reqId: pendingQuestion, answers: command.params.answers ?? [],
        } });
        pendingQuestion = null;
        return { ok: true, result: { resolved: true } };
      }
      if (command.method === "structured.kill") {
        return {
          ok: true,
          result: { killed: true, providerPid: provider?.pid ?? null, grandchildPid },
          terminal: true,
          snapshotState: { pendingPermission, pendingQuestion, providerPid: provider?.pid ?? null, grandchildPid },
          async afterReply() {
            try { await job.terminate(); }
            finally { await job.close(); }
          },
        };
      }
      return { ok: false, code: "unsupported", message: "unsupported fake adapter command" };
    },
    snapshotState() { return { pendingPermission, pendingQuestion }; },
  };
}
