import { createWriteStream, mkdirSync, mkdtempSync, statSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { migrateLegacySessionFile } from "../dist/legacy-session-import.js";
import { SessionDatabase } from "../dist/session-database.js";
import { reconnectStructuredSupervisors } from "../dist/structured-supervisor-client.js";

const readNumber = (name, fallback, max) => {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
};
const sessions = readNumber("--sessions", 4, 1000);
const events = readNumber("--events", 12000, 1000000);
const deltaBytes = readNumber("--delta-bytes", 256, 65536);
const concurrency = readNumber("--concurrency", 2, 4);
const toolRepeats = readNumber("--tool-repeats", 100000, 1000000);
const queueRepeats = readNumber("--queue-repeats", 10000, 1000000);
if (sessions * (events * (deltaBytes + 128) + (toolRepeats + queueRepeats) * 16) > 512 * 1024 * 1024) throw new Error("Synthetic input exceeds the 512 MiB benchmark budget");
const root = mkdtempSync(path.join(os.tmpdir(), "prospero-migration-bench-"));
const sources = [];
const payload = "x".repeat(deltaBytes);
const tool = "tool-output-🧪".repeat(toolRepeats);
const queued = "queue-text-🧪".repeat(queueRepeats);
const write = async (stream, value) => { if (!stream.write(value)) await once(stream, "drain"); };
const measure = async (name, action) => {
  global.gc?.();
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  let peakRss = process.memoryUsage().rss;
  const sampling = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
  await new Promise(resolve => setImmediate(resolve));
  const started = performance.now(), cpu = process.cpuUsage();
  try {
    const result = await action();
    await new Promise(resolve => setImmediate(resolve));
    const used = process.cpuUsage(cpu);
    return { name, wallMs: Math.round(performance.now() - started), cpuMs: Math.round((used.user + used.system) / 1000), eventLoopMaxMs: Number((delay.max / 1e6).toFixed(1)), eventLoopP99Ms: Number((delay.percentile(99) / 1e6).toFixed(1)), peakRssMb: Math.round(peakRss / 1024 / 1024), result };
  } finally { clearInterval(sampling); delay.disable(); }
};
try {
  for (let index = 0; index < sessions; index++) {
    const id = `synthetic-${index}`, directory = path.join(root, id);
    mkdirSync(directory, { mode: 0o700 });
    const source = path.join(directory, "session.json"), database = path.join(directory, "session.sqlite");
    const stream = createWriteStream(source, { mode: 0o600 });
    await write(stream, JSON.stringify({ version: 1, id: `synthetic-${index}`, agent: "codex", title: "Synthetic benchmark", cwd: root, createdAt: 1, approvalPolicy: "standard" }).slice(0, -1) + ',"events":[');
    for (let event = 0; event < events; event++) await write(stream, `${event ? "," : ""}${JSON.stringify({ kind: "text.delta", msgId: `message-${Math.floor(event / 20)}`, textId: "text", delta: `${event}:${payload}` })}`);
    await write(stream, `],"evSeq":${events},"preview":"","previewRaw":"","previewMsgId":"","totals":{"costUsd":0,"inputTokens":0,"outputTokens":0},"toolOutputs":${JSON.stringify([["synthetic-tool", tool]])},"adapterState":{},"messageQueue":${JSON.stringify([{ id: "queued", displayText: "Synthetic queue", outgoingText: queued, kind: "queue", createdAt: 1, attachmentCount: 0, attachments: [] }])}}`);
    stream.end();
    await once(stream, "finish");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ version: 1, protocolVersion: 1, implementation: "supervisor", sessionId: id, agent: "codex", title: "Synthetic benchmark", cwd: root, createdAt: 1, approvalPolicy: "standard", socket: path.join(directory, "session.sock"), transport: "unix_socket", tokenFile: "token", sessionDir: directory, supervisorPid: process.pid, lifecycleEpoch: id, status: "died", storageVersion: 2 }), { mode: 0o600 });
    sources.push({ source, database, id: `synthetic-${index}` });
  }
  const run = async () => {
    let index = 0, imported = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, sessions) }, async () => {
      for (;;) { const item = sources[index++]; if (!item) return; const result = await migrateLegacySessionFile(item.source, item.database, { array: false }); imported += Number(result.migrated); }
    }));
    return { imported };
  };
  const first = await measure("first-import", run);
  const second = await measure("already-sqlite", run);
  const reconnect = async () => {
    const restored = await reconnectStructuredSupervisors(root, 5, { archiveMigrationDelayMs: 0 });
    for (const session of restored) await session.dispose();
    return { restored: restored.length };
  };
  const startup = await measure("sqlite-reconnect-first", reconnect);
  const repeated = await measure("sqlite-reconnect-repeat", reconnect);
  let verified = 0;
  for (const item of sources) {
    const database = new SessionDatabase(item.database, { readOnly: true });
    try {
      const page = database.readEventsPage(item.id, { limit: 1 });
      if (page.lastSeq !== events || database.toolOutput(item.id, "synthetic-tool", { maxBytes: Number.MAX_SAFE_INTEGER })?.output !== tool || database.readSession(item.id, { events: false, toolOutputs: false, maxBytes: Number.MAX_SAFE_INTEGER })?.messageQueue?.[0]?.outgoingText !== queued) throw new Error("Synthetic history integrity failed");
      verified++;
    } finally { database.close(); }
  }
  console.log(JSON.stringify({ sessions, eventsPerSession: events, concurrency, sourceMiB: Number((sources.reduce((total, item) => total + statSync(item.source).size, 0) / 1024 / 1024).toFixed(1)), verified, measurements: [first, second, startup, repeated] }));
} finally { for (const item of sources) { if (!item.source.startsWith(root + path.sep)) throw new Error("Unexpected benchmark path"); } rmSync(root, { recursive: true, force: true }); }
