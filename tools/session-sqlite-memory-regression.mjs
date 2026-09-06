import { spawnSync } from "node:child_process";
import { mkdtempSync, openSync, writeSync, closeSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Synthetic fixtures only. Run after `npm run build -w @prospero/daemon`.
// This measures import/startup/page memory, not an Electron or iPhone render.
const self = fileURLToPath(import.meta.url);
const mib = 1024 * 1024;
const metadata = {
  version: 1, id: "synthetic", agent: "codex", title: "Memory fixture", cwd: "/synthetic",
  createdAt: 1, approvalPolicy: "standard", preview: "", previewRaw: "", previewMsgId: "",
  totals: { costUsd: 0, inputTokens: 0, outputTokens: 0 }, toolOutputs: [], messageQueue: [], adapterState: {}, terminal: true,
};

function child(mode, source, destination) {
  const result = spawnSync("/bin/sh", ["-c", 'ulimit -c 0 || exit 125; exec "$@"', "sqlite-memory",
    process.execPath, "--expose-gc", "--max-old-space-size=64", self, "--worker", mode, source, destination], {
    encoding: "utf8", timeout: 180_000, maxBuffer: 64 * 1024,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (result.status !== 0 || result.error) throw new Error(`${mode}: constrained child failed (${result.status}, ${result.signal}): ${result.stderr.slice(-1000)}`);
  return JSON.parse(result.stdout);
}

if (process.argv[2] === "--worker") {
  const [, , , mode, source, destination] = process.argv;
  const { SessionDatabase } = await import("../apps/daemon/dist/session-database.js");
  const started = performance.now();
  if (mode === "import") {
    const { migrateLegacySessionFile } = await import("../apps/daemon/dist/legacy-session-import.js");
    await migrateLegacySessionFile(source, destination, { array: true });
  } else {
    const database = new SessionDatabase(destination, { readOnly: true });
    try {
      const state = database.readSession("synthetic", { events: false, toolOutputs: false, messageQueue: false });
      const page = database.readEventsPage("synthetic", { limit: 200, maxBytes: 512 * 1024 });
      if (!state || !page.hasMore || page.events.length < 1 || page.lastSeq !== state.evSeq) throw new Error("invalid bounded read");
      if (page.events.some(({ body }) => body.text !== "x".repeat(32 * 1024))) throw new Error("history body changed");
    } finally { database.close(); }
  }
  const elapsedMs = Math.round(performance.now() - started);
  global.gc?.();
  process.stdout.write(JSON.stringify({ elapsedMs, heapMiB: +(process.memoryUsage().heapUsed / mib).toFixed(1),
    peakRssMiB: +(process.resourceUsage().maxRSS / 1024).toFixed(1) }));
} else {
  const home = mkdtempSync(path.join(tmpdir(), "prospero-sqlite-memory-"));
  try {
    const results = [];
    for (const sizeMiB of [10, 100]) {
      const source = path.join(home, `${sizeMiB}.json`);
      const destination = path.join(home, `${sizeMiB}.sqlite`);
      const fd = openSync(source, "wx", 0o600);
      const count = sizeMiB * 32;
      try {
        writeSync(fd, `[${JSON.stringify({ ...metadata, evSeq: count }).slice(0, -1)},"events":[`);
        for (let index = 0; index < count; index++) {
          writeSync(fd, `${index ? "," : ""}${JSON.stringify({ kind: "user.message", msgId: `m${index}`, text: "x".repeat(32 * 1024) })}`);
        }
        writeSync(fd, "]}]");
      } finally { closeSync(fd); }
      results.push({ sizeMiB, actualBytes: statSync(source).size, heapLimitMiB: 64,
        import: child("import", source, destination), read: child("read", source, destination) });
    }
    process.stdout.write(`${JSON.stringify({ node: process.version, results }, null, 2)}\n`);
  } finally { rmSync(home, { recursive: true, force: true }); }
}
