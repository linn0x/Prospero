const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { createServer } = require("node:http");
const { pathToFileURL } = require("node:url");

const root = process.env.PROSPERO_PASTE_FIXTURE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "prospero-paste-fixture-"));
if (fs.readdirSync(root).length) throw new Error("Paste fixture requires an empty directory");
const home = path.join(root, "home"), userData = path.join(root, "electron");
fs.mkdirSync(home); fs.mkdirSync(userData);
const token = randomBytes(32).toString("hex");
const session = { id: "paste-regression", agent: "shell", kind: "pty", title: "Clipboard regression fixture", cwd: root, status: "running", createdAt: Date.now() };
const inputs = []; const output = []; let seq = 1;
const save = () => fs.writeFileSync(path.join(root, "inputs.json"), JSON.stringify(inputs), { mode: 0o600 });
save();
const keys = [];
app.on("web-contents-created", (_event, contents) => contents.on("before-input-event", (_inputEvent, input) => {
  if (input.type === "keyDown" && input.code === "KeyV") {
    keys.push({ type: input.type, code: input.code, meta: input.meta, control: input.control, shift: input.shift, isAutoRepeat: input.isAutoRepeat });
    fs.writeFileSync(path.join(root, "keys.json"), JSON.stringify(keys), { mode: 0o600 });
  }
}));
const server = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("content-type", "application/json");
  if (url.pathname.endsWith("/view")) {
    const after = Number(url.searchParams.get("outputAfterSeq"));
    if (after === seq) { setTimeout(() => { if (!response.destroyed) { response.statusCode = 204; response.end(); } }, 250); return; }
    if (after > 0 && after < seq) response.end(JSON.stringify({ kind: "pty", mode: "delta", baseSeq: after, seq, dataB64: Buffer.from(output.filter(item => item.seq > after).map(item => item.text).join("")).toString("base64") }));
    else response.end(JSON.stringify({ kind: "pty", mode: "snapshot", ansi: "\u001b[?2004hClipboard regression fixture — input is recorded, never executed\r\n> ", cols: 100, rows: 30, seq }));
  } else if (url.pathname.endsWith("/interact")) {
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
    request.on("end", () => {
      try {
        const message = JSON.parse(body);
        if (message.type === "term.input") {
          const text = Buffer.from(message.dataB64, "base64").toString("utf8");
          inputs.push(text); if (inputs.length > 512) inputs.shift(); save();
          output.push({ seq: ++seq, text: text.replace(/\u001b\[(?:200|201)~/g, "").replace(/\r/g, "\r\n") });
          if (output.length > 512) output.shift();
        }
        response.end(JSON.stringify({ accepted: true }));
      } catch { response.statusCode = 400; response.end("{}"); }
    });
  } else if (url.pathname.endsWith("/sessions")) response.end(JSON.stringify({ items: [session], total: 1, active: 1, terminal: 0 }));
  else response.end(JSON.stringify({ ok: true, accounts: [], items: [], models: [], modes: [] }));
});
process.env.PROSPERO_BACKEND = "legacy";
process.env.PROSPERO_HOME = home;
app.setPath("userData", userData);
app.commandLine.appendSwitch("force-renderer-accessibility");
fs.writeFileSync(path.join(home, "desktop.json"), JSON.stringify({ projects: [root], settings: { startDaemonOnLaunch: false, minimizeToTray: false, theme: "dark" } }));
server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(home, "status.json"), JSON.stringify({ pid: process.pid, port, controlToken: token, sessions: [session] }), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify({ pid: process.pid, root, port }));
  await import(pathToFileURL(path.join(__dirname, "../out/main/index.js")).href);
});
