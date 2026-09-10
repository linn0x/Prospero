// Runs the actual sandboxed renderer + IPC against an isolated disposable project.
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:http");

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-project-ui-"));
const project = path.join(fixture, "Demo project");
const home = path.join(fixture, "home");
const secondProject = path.join(fixture, "Second project");
const output = path.resolve(__dirname, "../../..", "output/desktop-project-tools");
fs.mkdirSync(project); fs.mkdirSync(home); fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(path.join(project, "src"));
fs.mkdirSync(secondProject); fs.writeFileSync(path.join(secondProject, "README.md"), "# Another workspace\n");
const log = value => fs.appendFileSync(path.join(output, "check.log"), `${new Date().toISOString()} ${value}\n`);
log(`Starting fixture ${fixture}`);
process.on("uncaughtException", error => { log(error.stack); app.exit(1); });
process.on("unhandledRejection", error => { log(String(error)); app.exit(1); });
fs.writeFileSync(path.join(project, "README.md"), "# Project workspace\n\nExplore files, search code, and review changes.\n\n## Getting started\n\nOpen a file from the explorer to preview it here.\n");
fs.writeFileSync(path.join(project, "src", "workspace.ts"), "export interface Workspace {\n  id: string;\n  name: string;\n}\n\nexport function openWorkspace(name: string): Workspace {\n  return { id: crypto.randomUUID(), name };\n}\n");
fs.writeFileSync(path.join(project, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" rx="28" fill="#202a44"/><path d="M42 48h56a20 20 0 0 1 0 40H62v30H42z" fill="#98b6ff"/></svg>');
const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "pipe", windowsHide: true });
git("init", "-b", "main"); git("config", "user.email", "test@example.com"); git("config", "user.name", "Prospero UI test"); git("config", "commit.gpgsign", "false"); git("add", "."); git("commit", "-m", "Create project workspace");
fs.appendFileSync(path.join(project, "src", "workspace.ts"), "\nexport const projectName = 'Prospero';\n");
fs.writeFileSync(path.join(home, "desktop.json"), JSON.stringify({ projects: [project, secondProject], settings: { startDaemonOnLaunch: false, minimizeToTray: false, theme: "dark" } }));
const sessions = [
  { id: "ui-project-session", agent: "codex", kind: "structured", title: "Review project workspace", cwd: project, status: "idle", createdAt: Date.now() },
  { id: "ui-second-session", agent: "codex", kind: "structured", title: "Second workspace", cwd: secondProject, status: "idle", createdAt: Date.now() },
  ...Array.from({ length: 22 }, (_, index) => ({ id: `ui-tab-session-${index}`, agent: index % 3 === 0 ? "claude" : "codex", kind: "structured", title: ["检查工作区布局", "优化会话阅读体验", "修复 macOS 交互", "Review release changes"][index % 4] + ` ${index + 1}`, cwd: project, status: "idle", createdAt: Date.now() - index * 1000 })),
];
const events = [
  { kind: "user.message", msgId: "user", text: "帮我检查项目结构，并查看这次修改。" },
  { kind: "text.delta", msgId: "answer", textId: "answer", delta: "项目结构很清晰：\n\n- `src/workspace.ts` 定义工作区数据与创建逻辑。\n- `README.md` 提供项目说明。\n\n这次修改新增了项目名称。你可以在右侧查看文件和 Git 差异，继续在这里讨论修改。", phase: "final_answer" },
];
const shell = { id: "ui-workspace-shell", agent: "shell", kind: "pty", title: "Project terminal", cwd: project, status: "running", createdAt: Date.now() };
let shellCreates = 0;
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("content-type", "application/json");
  if (url.pathname.endsWith("/session/create")) { shellCreates++; response.end(JSON.stringify(shell)); }
  else if (url.pathname.includes(shell.id) && url.pathname.endsWith("/view")) {
    if (Number(url.searchParams.get("outputAfterSeq")) > 0) setTimeout(() => { if (!response.destroyed) { response.statusCode = 204; response.end(); } }, 200);
    else response.end(JSON.stringify({ kind: "pty", mode: "snapshot", seq: 1, cols: 100, rows: 30, ansi: "Windows PowerShell\r\n\r\nPS " + project + "> " }));
  } else if (url.pathname.endsWith("/view")) {
    if (url.searchParams.has("afterSeq")) { setTimeout(() => { if (!response.destroyed) { response.statusCode = 204; response.end(); } }, 1000); }
    else response.end(JSON.stringify({ mode: "snapshot", events, evSeq: events.length }));
  } else if (url.pathname.endsWith("/sessions")) response.end(JSON.stringify({ items: sessions, hasMore: false }));
  else response.end(JSON.stringify({ ok: true, available: false, items: [], modes: [], models: [] }));
});
process.env.PROSPERO_HOME = home;
process.argv.push("--background");
app.setPath("userData", path.join(fixture, "userData"));
app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error("Project UI check timed out", fixture); app.exit(1); }, 150_000);

app.on("browser-window-created", (_event, window) => {
  log("Window created");
  window.webContents.on("render-process-gone", (_event, details) => { log(`Renderer exited ${JSON.stringify(details)}`); app.exit(1); });
  window.webContents.on("did-fail-load", (_event, code, description) => { log(`Load failed ${code} ${description}`); app.exit(1); });
  window.webContents.once("did-finish-load", async () => {
    log("Renderer loaded");
    const wc = window.webContents;
    const run = source => wc.executeJavaScript(source, true);
    const errors = [];
    wc.on("console-message", details => { if (details.level === "error" && !details.message.includes("ERR_CONNECTION_REFUSED")) errors.push(details.message); });
    const wait = async (expression, label = expression) => { log(`Waiting ${label}`); for (let i = 0; i < 80; i++) { if (await run(expression)) return; await delay(100); } throw new Error(`Timed out: ${label}`); };
    const visible = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(element=>element.getClientRects().length && getComputedStyle(element).visibility!=='hidden')`;
    const click = async selector => { await wait(`Boolean(${visible(selector)}) && !(${visible(selector)}).disabled && (${visible(selector)}).getAttribute('aria-disabled')!=='true'`); await run(`${visible(selector)}.click()`); await delay(100); };
    const fill = async (selector, value) => { await wait(`Boolean(${visible(selector)})`); await run(`(() => { const input=${visible(selector)}; const prototype=input.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`); await delay(100); };
    const screenshot = async name => fs.writeFileSync(path.join(output, name + ".png"), (await wc.capturePage()).toPNG());
    const navigate = async mode => { await click(`#dock-tab-${mode === "git" ? "diff" : mode}`); await delay(200); };
    const back = () => click('.project-preview-navigation button');
    try {
      window.setMinimumSize(640, 600);
      window.setSize(1380, 900);
      window.setOpacity(0); window.showInactive();
      await wait("Boolean(document.querySelector('.prospero-shell'))");
      await run(`localStorage.setItem('prospero.activeView','workspaces');localStorage.setItem('prospero.activeSession','ui-project-session');localStorage.setItem('prospero.openSessions',${JSON.stringify(JSON.stringify(sessions.slice(0, 2).map(session => session.id)))});`);
      await new Promise(resolve => { wc.once("did-finish-load", resolve); wc.reload(); });
      await wait("Boolean(document.querySelector('.session-toolbar'))");
      await wait("document.querySelector('.workspace-primary')?.textContent.includes('项目结构很清晰')");
      await run("window.__originalCenter=document.querySelector('.workspace-primary');window.__originalChat=document.querySelector('.chat-pane')");
      await click('[aria-label="浏览项目文件"]');
      await wait("Boolean(document.querySelector('.workspace-dock-aside .project-tools-shell'))");
      const assertSplit = async () => {
        const bounds = await run("(() => {const center=document.querySelector('.workspace-primary').getBoundingClientRect();const dock=document.querySelector('.workspace-dock-aside').getBoundingClientRect();return {centerWidth:center.width,dockWidth:dock.width,gap:dock.left-center.right,route:localStorage.getItem('prospero.activeView'),sameCenter:window.__originalCenter===document.querySelector('.workspace-primary')}})()");
        assert.equal(bounds.route, "workspaces"); assert.equal(bounds.sameCenter, true); assert(bounds.centerWidth >= 420); assert(bounds.dockWidth >= 300); assert(bounds.gap >= 0 && bounds.gap <= 8);
        return bounds;
      };
      await assertSplit();
      await screenshot("explorer-right");
      await click('[title="README.md"].project-tree-row');
      await wait("Boolean(document.querySelector('.project-markdown-preview h1'))");
      assert.equal(await run("document.querySelector('.project-markdown-preview h1').textContent"), "Project workspace");
      await back();
      await click('[title="src"].project-tree-row');
      await click('[title="src/workspace.ts"].project-tree-row');
      await wait("Boolean(document.querySelector('.project-code-source .hljs-keyword'))");
      assert.equal(await run("document.querySelectorAll('.project-preview-tab').length"), 2);
      await screenshot("files-dark");
      await click('[aria-label="编辑"]');
      await wait("Boolean(document.querySelector('.project-code-editor'))");
      await fill('.project-code-editor', "export const projectName = 'Prospero edited';\n");
      await run("window.__editor=document.querySelector('.project-code-editor')");
      await click('[aria-label="隐藏工具栏"]');
      await wait("!document.querySelector('.workspace-dock-aside')");
      await click('[aria-label="浏览项目文件"]');
      await wait("Boolean(document.querySelector('.project-code-editor'))");
      assert.equal(await run("window.__editor===document.querySelector('.project-code-editor') && window.__editor.value.includes('Prospero edited')"), true, "Hiding the dock preserves the editor and draft");
      window.setSize(700, 740); await wait("Boolean(document.querySelector('.workspace-dock-sheet .project-code-editor'))");
      assert.equal(await run("window.__editor===document.querySelector('.project-code-editor')"), true, "Inline to overlay keeps the editor mounted");
      await screenshot("files-overlay");
      window.setSize(1380, 900); await wait("Boolean(document.querySelector('.workspace-dock-aside .project-code-editor'))");
      await click('#workspace-tab-ui-second-session');
      await click('[aria-label="浏览项目文件"]');
      await click('[title="README.md"].project-tree-row');
      await wait("document.querySelector('.project-tools-instance:not([hidden]) .project-markdown-preview h1')?.textContent==='Another workspace'");
      await click('#workspace-tab-ui-project-session');
      await wait("Boolean(document.querySelector('.project-tools-instance:not([hidden]) .project-code-editor'))");
      assert.equal(await run("window.__editor===document.querySelector('.project-tools-instance:not([hidden]) .project-code-editor') && window.__editor.value.includes('Prospero edited')"), true, "Switching projects preserves unsaved files");
      await run("window.__originalCenter=document.querySelector('.workspace-primary')");
      await click('[aria-label="关闭 workspace.ts"]');
      await wait("Boolean(document.querySelector('[role=dialog]'))");
      assert.match(await run("document.querySelector('[role=dialog]').textContent"), /尚未保存/);
      await click('[role="dialog"] [data-slot="button"]'); // Cancel.
      await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',ctrlKey:true,metaKey:true,bubbles:true}))");
      await wait(`window.prospero.readProjectFile(${JSON.stringify(project)},'src/workspace.ts').then(file=>file.content.includes('Prospero edited'))`);
      await navigate("search");
      await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',ctrlKey:true,metaKey:true,shiftKey:true,bubbles:true}))");
      await fill('[data-slot="project-search"]', "Prospero edited");
      await wait("document.querySelectorAll('.project-search-result').length===1");
      await click('.project-search-result');
      await wait("Boolean(document.querySelector('.project-preview-tabpanel:not([hidden]) [data-line=\"1\"].is-target'))");
      await screenshot("search-dark");
      await assertSplit();
      await navigate("git");
      await wait("Boolean(document.querySelector('.project-git-file'))");
      await screenshot("git-list-right");
      await click('.project-git-file > button:first-child');
      await wait("Boolean(document.querySelector('.project-source-line.is-added'))");
      await screenshot("git-dark");
      await back();
      await click('[aria-label="暂存 src/workspace.ts"]');
      await wait(`window.prospero.getProjectGitStatus(${JSON.stringify(project)}).then(status=>status.staged)`);
      await fill('[data-slot="project-commit"]', "Edit workspace from desktop");
      await click('.project-commit-form button[type="submit"]');
      await wait(`window.prospero.getProjectGitHistory(${JSON.stringify(project)}).then(history=>history[0]?.subject==='Edit workspace from desktop')`);
      await navigate("search");
      assert.equal(await run(`${visible('[data-slot="project-search"]')}.value`), "Prospero edited", "Search query survives tool navigation");
      await navigate("files");
      assert.equal(await run("document.querySelector('[title=\"src\"].project-tree-row').getAttribute('aria-expanded')"), "true", "Explorer expansion survives tool navigation");
      await click('[aria-label="新建文件"]');
      await fill('[data-slot="project-file-name"]', "notes.txt");
      await click('[role="dialog"] button[type="submit"]');
      await wait("Boolean(document.querySelector('[title=\"notes.txt\"].project-tree-row'))");
      assert(fs.existsSync(path.join(project, "notes.txt")));
      await back();
      await click('[title="icon.svg"].project-tree-row');
      await wait("Boolean(document.querySelector('.project-image-preview img')?.naturalWidth)");
      await screenshot("image-dark");
      await run("window.prospero.updateSettings({theme:'light'})");
      await back();
      await click('[title="README.md"].project-tree-row');
      await wait("document.documentElement.dataset.theme==='light' || !document.documentElement.classList.contains('dark')");
      await delay(200); await screenshot("files-light");
      window.setSize(980, 740); await delay(250); await screenshot("files-compact");
      const layout = await run("(() => {const root=document.querySelector('.project-tools-shell');const preview=document.querySelector('.project-preview-area').getBoundingClientRect();return {overflow:root.scrollWidth>root.clientWidth,previewWidth:preview.width,previewHeight:preview.height}})()");
      assert.equal(layout.overflow, false); assert(layout.previewWidth > 200); assert(layout.previewHeight > 300);
      await assertSplit();
      const workspaceLayout = await require("./workspace-layout-checks.cjs")({ window, run, wait, click, screenshot, shellCreates: () => shellCreates });
      const tabStrips = await require("./tab-strip-checks.cjs")({ window, run, wait, click, fill, screenshot, sessionIds: sessions.map(session => session.id) });
      const statusMaterial = await require("./status-material-checks.cjs")({ window, run, wait, click, screenshot, sessions, updateSession: (id, patch) => {
        Object.assign(sessions.find(session => session.id === id), patch);
        fs.writeFileSync(path.join(home, "status.json"), JSON.stringify({ pid: process.pid, port: server.address().port, controlToken: "isolated-ui-test", sessions }));
      } });
      assert.deepEqual(errors.filter(message => /Uncaught|Maximum update|unique.*key|validateDOMNesting/.test(message)), []);
      const result = { ok: true, project, output, layout, checks: ["right dock keeps conversation", "hide/reopen preserves draft", "overlay preserves editor", "project switch preserves draft", "files", "markdown", "syntax", "tabs", "unsaved guard", "save", "search shortcut and jump", "diff", "stage", "commit", "create", "image", "light/dark", "compact"] };
      result.workspaceLayout = workspaceLayout;
      result.tabStrips = tabStrips;
      result.statusMaterial = statusMaterial;
      fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); log("Passed");
      clearTimeout(deadline); app.exit(0);
    } catch (error) { log(error.stack); console.error(error); console.error(errors); await screenshot("failure"); clearTimeout(deadline); app.exit(1); }
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(home, "status.json"), JSON.stringify({ pid: process.pid, port: server.address().port, controlToken: "isolated-ui-test", sessions }));
  import(pathToFileURL(path.join(__dirname, "../out/main/index.js")).href);
});
