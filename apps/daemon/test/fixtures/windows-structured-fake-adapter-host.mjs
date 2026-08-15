import { spawn } from "node:child_process";

export async function createWindowsSessionHostHandler(context) {
  const job = await context.createProviderJob();
  let provider = null;
  let grandchildPid = null;
  let pending = null;
  return {
    async handleCommand(command) {
      if (command.method === "structured.send") {
        if (!provider) {
          provider = spawn(process.execPath, ["-e", [
            "const { spawn } = require('node:child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            "process.stdout.write(String(child.pid) + '\\n');",
            "setInterval(() => {}, 1000);",
          ].join(" ")], { stdio: ["ignore", "pipe", "ignore"] });
          await job.registerProcess(provider);
          const line = await new Promise((resolve, reject) => {
            provider.stdout.once("data", (chunk) => resolve(String(chunk).trim()));
            provider.once("error", reject);
          });
          grandchildPid = Number(line);
        }
        pending = "real-native-approval";
        await context.emit({ type: "structured.event", evSeq: 1, body: {
          kind: "permission.request", reqId: pending, action: "fake-native", resources: ["fixture"], summary: "pending",
        } });
        return { ok: true, result: { pending, providerPid: provider.pid, grandchildPid } };
      }
      if (command.method === "structured.respondPermission") {
        if (command.params?.reqId !== pending) return { ok: false, code: "unknown_request", message: "request is not pending" };
        await context.emit({ type: "structured.event", evSeq: 2, body: {
          kind: "permission.resolved", reqId: pending, reply: command.params.reply,
        } });
        pending = null;
        return { ok: true, result: { resolved: true } };
      }
      if (command.method === "structured.kill") {
        return {
          ok: true,
          result: { killed: true, providerPid: provider?.pid ?? null, grandchildPid },
          terminal: true,
          snapshotState: { pending, providerPid: provider?.pid ?? null, grandchildPid },
          async afterReply() {
            try { await job.terminate(); }
            finally { await job.close(); }
          },
        };
      }
      return { ok: false, code: "unsupported", message: "unsupported fake adapter command" };
    },
    snapshotState() { return { pending }; },
  };
}
