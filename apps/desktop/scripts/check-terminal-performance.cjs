// Isolated renderer benchmark. Never connects to a daemon or existing session.
// Run with Electron; compares the previous per-event writer with current code.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { buildSync } = require("esbuild");
const root = path.resolve(__dirname, "../../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-terminal-perf-"));
const output = path.join(root, "output/desktop-terminal");
app.setPath("userData", path.join(temporary, "profile"));
const source = `
import { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';
import { writeTerminalEvents } from './apps/desktop/src/renderer/src/terminal-events';
import { configureRustTerminalUnicode } from './apps/desktop/src/renderer/src/terminal-unicode';
const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
async function previous(terminal, events) {
  for (const event of events) {
    if (event.type === 'resize') terminal.resize(event.size.cols, event.size.rows);
    else await new Promise(resolve => terminal.write(bytes(event.dataB64), resolve));
  }
}
window.measure = async (mode, pages) => {
  const host = document.getElementById('terminal'); host.replaceChildren();
  const terminal = new Terminal({cols:120,rows:40,scrollback:10000,fontSize:14,allowProposedApi:true});
  configureRustTerminalUnicode(terminal);
  terminal.open(host);
  let renderer = 'dom';
  if (mode === 'current-webgl') {
    let addon;
    try {
      addon = new WebglAddon();
      addon.onContextLoss(() => { addon.dispose(); renderer = 'dom-context-loss'; });
      terminal.loadAddon(addon); renderer = 'webgl';
    } catch { addon?.dispose(); renderer = 'dom-unavailable'; }
  }
  await frame(); await frame();
  let writes = 0;
  const original = terminal.write.bind(terminal);
  terminal.write = (...args) => { writes++; return original(...args); };
  const gaps = [], longTasks = [];
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e=>e.duration)));
  observer.observe({entryTypes:['longtask']});
  let measuring = true, last = performance.now();
  const tick = now => { gaps.push(now-last); last=now; if(measuring)requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const start = performance.now();
  for (const page of pages) {
    if(mode === 'previous-dom') await previous(terminal,page);
    else await writeTerminalEvents(terminal,page,()=>true);
  }
  await frame(); await frame();
  const durationMs = performance.now()-start;
  measuring=false; observer.disconnect();
  const buffer = terminal.buffer.active;
  const lines = Array.from({length:buffer.length},(_,i)=>buffer.getLine(i)?.translateToString(true));
  gaps.sort((a,b)=>a-b);
  const result = {mode,renderer,durationMs,writes,frameGapP95Ms:gaps[Math.floor(gaps.length*.95)] ?? null,
    maxFrameGapMs:Math.max(0,...gaps),longTasks:longTasks.length,maxLongTaskMs:Math.max(0,...longTasks),
    screen:JSON.stringify({lines,cols:terminal.cols,rows:terminal.rows,cursorX:buffer.cursorX,cursorY:buffer.cursorY})};
  terminal.dispose(); return result;
};`;
const bundle = buildSync({ stdin: { contents: source, resolveDir: root }, bundle: true, write: false, platform: "browser", format: "iife" });
fs.writeFileSync(path.join(temporary, "runner.js"), bundle.outputFiles[0].contents);
fs.copyFileSync(path.join(root, "node_modules/@xterm/xterm/css/xterm.css"), path.join(temporary, "xterm.css"));
fs.writeFileSync(path.join(temporary, "index.html"), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="xterm.css"><div id="terminal" style="width:1100px;height:800px"></div><script src="runner.js"></script>');
const pages = Array.from({ length: 20 }, (_, page) => Array.from({ length: 64 }, (_, event) => {
  if(event === 32 && page % 5 === 0) return {type:"resize",size:{cols:page%10 ? 100:120,rows:40}};
  const line = `${page}:${event} \x1b[32m中文 output 👩‍💻\x1b[0m ${"abcd ".repeat(15)}\r\n`;
  return {type:"output",dataB64:Buffer.from(line.repeat(4)).toString("base64")};
}));
const deadline = setTimeout(() => { console.error("Terminal performance check timed out"); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show:false,width:1200,height:900,webPreferences:{ sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true } });
  try {
    await window.loadFile(path.join(temporary, "index.html"));
    const results=[]; let expected;
    for(let repeat=0;repeat<3;repeat++) {
      // Alternate ordering to reduce warm-up/order bias.
      const modes=repeat%2 ? ["current-webgl","current-dom","previous-dom"] : ["previous-dom","current-dom","current-webgl"];
      for(const mode of modes) {
        const result=await window.webContents.executeJavaScript(`window.measure(${JSON.stringify(mode)},${JSON.stringify(pages)})`);
        expected ??= result.screen;
        assert.equal(result.screen,expected,`${mode} changed screen/cursor/resize ordering`);
        delete result.screen; results.push({...result,repeat});
        console.log(JSON.stringify(result));
      }
    }
    const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
    const summary=Object.fromEntries(["previous-dom","current-dom","current-webgl"].map(mode=>[mode,{medianDurationMs:median(results.filter(r=>r.mode===mode).map(r=>r.durationMs)),writes:results.find(r=>r.mode===mode).writes}]));
    const report={ok:true,scope:"Synthetic xterm renderer throughput; not native-terminal or end-to-end input latency",platform:process.platform,electron:process.versions.electron,summary,results};
    fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,"performance.json"),JSON.stringify(report,null,2));
    console.log(JSON.stringify({ok:true,summary,output})); clearTimeout(deadline); window.destroy(); app.exit(0);
  } catch(error) { console.error(error); clearTimeout(deadline); app.exit(1); }
});
process.on("exit",()=>fs.rmSync(temporary,{recursive:true,force:true}));
