import { startStructuredSupervisor } from "../../dist/structured-supervisor.js";

const home = process.env.PROSPERO_TEST_HOME;
if (!home) throw new Error("PROSPERO_TEST_HOME is required");

let emit = null;
let timers = [];
const adapter = {
  async start(context) {
    emit = context.emit;
    emit({ kind: "text.delta", msgId: "fake", textId: "fake", delta: "started" });
  },
  async send(text) {
    // Returning immediately models an adapter which accepted a long native turn.
    timers.push(setTimeout(() => {
      emit?.({ kind: "text.delta", msgId: "fake", textId: "fake", delta: `progress:${text}` });
    }, 60));
    timers.push(setTimeout(() => {
      emit?.({ kind: "turn.end", msgId: "fake", inputTokens: 1, outputTokens: 1 });
    }, 300));
  },
  async kill() {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
  },
};

const supervisor = await startStructuredSupervisor({ home });
await supervisor.createSession("fake-long-turn", adapter);
process.stdout.write(`${JSON.stringify({ socketPath: supervisor.socketPath, token: supervisor.token })}\n`);

process.on("SIGTERM", () => {
  void supervisor.close().finally(() => process.exit(0));
});
