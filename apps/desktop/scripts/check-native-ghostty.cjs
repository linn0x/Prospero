// Isolated libghostty NSView smoke: no Prospero main process or daemon is used.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const root = path.resolve(__dirname, "../../..");
const bundle = process.env.PROSPERO_NATIVE_GHOSTTY_DIR || path.join(root, "apps/desktop/.native/ghostty");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-ghostty-smoke-"));
app.setPath("userData", path.join(fixture, "electron"));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  await app.whenReady();
  const native = require(path.join(bundle, "ghostty.node"));
  const baseConfig = fs.readFileSync(path.join(bundle, "config"), "utf8");
  let appConfigPath = path.join(fixture, "app-ghostty.conf");
  let appConfig = baseConfig;
  if (process.env.PROSPERO_NATIVE_GHOSTTY_SMOKE_NO_VSYNC === "1") {
    appConfig = /^\s*window-vsync\s*=.*$/m.test(appConfig)
      ? appConfig.replace(/^\s*window-vsync\s*=.*$/m, "window-vsync = false")
      : `${appConfig.trimEnd()}\nwindow-vsync = false\n`;
    fs.writeFileSync(appConfigPath, appConfig, { mode: 0o600 });
  } else {
    appConfigPath = path.join(bundle, "config");
  }
  native.initialize(appConfigPath, path.join(bundle, "resources"));
  native.setFocusHandler?.((id, focused) => console.log(JSON.stringify({ focus: { id, focused } })));
  native.setShortcutHandler?.((action, id) => console.log(JSON.stringify({ shortcut: { id, action } })));
  native.setPasteImageHandler?.(() => true);

  const window = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  await window.loadURL("data:text/html,<html><body style='margin:0;background:%231a1b26;color:%23c0caf5'>Native Ghostty smoke</body></html>");
  window.focus();
  const socketPath = path.join(fixture, "relay.sock");
  const relay = path.join(bundle, "prospero-terminal-relay");
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  // Ghostty already wraps embedded commands in `exec -l`; an extra exec token
  // here becomes `exec -l exec ...` and makes Bash try to run a binary named exec.
  const command = `${shellQuote(relay)} ${shellQuote(socketPath)}`;
  const configPath = path.join(fixture, "ghostty.conf");
  fs.writeFileSync(configPath, baseConfig.replace(/^\s*font-family\s*=.*$/m, 'font-family = "Menlo"'), { mode: 0o600 });
  let resolveRelay;
  const relayConnected = new Promise(resolve => { resolveRelay = resolve; });
  let resolveResize;
  const resizeReceived = new Promise(resolve => { resolveResize = resolve; });
  let resolveInput;
  const inputReceived = new Promise(resolve => { resolveInput = resolve; });
  let relayTextSent = false;
  const relayServer = net.createServer(socket => {
    let pending = Buffer.alloc(0);
    socket.on("data", chunk => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const size = pending.readUInt32BE(1);
        if (pending.length < size + 5) break;
        const kind = String.fromCharCode(pending[0]);
        const payload = pending.subarray(5, size + 5);
        pending = pending.subarray(size + 5);
        if (kind === "R") {
          resolveRelay({ columns: payload.readUInt16BE(0), rows: payload.readUInt16BE(2) });
          resolveResize();
          if (!relayTextSent) {
            relayTextSent = true;
            const outputId = Buffer.alloc(4); outputId.writeUInt32BE(0x12345678);
            const output = Buffer.concat([outputId, Buffer.from("RELAY_GHOSTTY_SMOKE", "utf8")]);
            const header = Buffer.alloc(5); header[0] = "O".charCodeAt(0); header.writeUInt32BE(output.length, 1);
            socket.write(Buffer.concat([header, output]));
          }
        } else if (kind === "A") {
          if (payload.readUInt32BE(0) === 0x12345678) console.log("relay output acknowledged by Ghostty PTY");
        } else if (kind === "I") {
          resolveInput(payload.toString("utf8"));
        }
      }
    });
  });
  await new Promise((resolve, reject) => { relayServer.once("error", reject); relayServer.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  const id = native.create(window.getNativeWindowHandle(), command, { fontSize: 14, fontFamily: "Menlo", configPath });
  native.update(id, { x: 0, y: 0, width: 900, height: 600, visible: true, focus: true });
  console.log(JSON.stringify({ created: id, initialSize: native.size(id), command }));

  const relayGrid = await Promise.race([relayConnected, delay(5000).then(() => null)]);
  if (!relayGrid) {
    let text = "";
    try { text = native.readText(id); } catch (error) { text = `readText failed: ${String(error)}`; }
    console.error(JSON.stringify({ relayTimeout: socketPath, size: native.size(id), text }));
    throw new Error(`Native Ghostty relay did not connect to ${socketPath}`);
  }
  console.log(JSON.stringify({ relayConnected: relayGrid }));
  let output = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(250);
    try { output = native.readText(id); }
    catch (error) { console.error("readText error while surface alive:", error); break; }
    if (attempt % 4 === 0) console.log(JSON.stringify({ attempt, size: native.size(id), text: output.slice(-600) }));
    if (output.includes("RELAY_GHOSTTY_SMOKE")) break;
  }
  if (!output.includes("RELAY_GHOSTTY_SMOKE")) {
    console.error("Ghostty command produced no expected text; final text:", JSON.stringify(output));
    throw new Error("Ghostty relay output did not render in the native surface");
  }
  native.setReadOnly(id, false);
  native.testIMECommit(id, "に", "日本語_IME_COMMIT");
  const imeRelayInput = await Promise.race([inputReceived, delay(5000).then(() => null)]);
  if (imeRelayInput !== "日本語_IME_COMMIT") throw new Error(`Synthetic IME commit did not reach relay as UTF-8: ${JSON.stringify(imeRelayInput)}`);
  console.log(JSON.stringify({ imeRelayInput }));
  const beforeGrid = native.size(id);
  const replayGrid = native.setGrid(id, 80, 24);
  console.log(JSON.stringify({ beforeGrid, replayGrid }));
  native.update(id, { x: 0, y: 0, width: 900, height: 600, visible: true, preserveGrid: true });
  if (native.size(id).columns !== replayGrid.columns) throw new Error("preserveGrid update changed the replay grid");

  native.destroy(id);
  relayServer.close();
  window.close();
  app.exit(0);
}

main().catch(error => {
  console.error(error);
  app.exitCode = 1;
  app.exit(1);
}).finally(() => {
  process.on("exit", () => fs.rmSync(fixture, { recursive: true, force: true }));
});
