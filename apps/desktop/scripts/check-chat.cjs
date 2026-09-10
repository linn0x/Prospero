// Exercise the actual packaged renderer with an isolated conversation and project.
const { app } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createServer } = require("node:http");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "prospero-chat-ui-"));
const project = path.join(fixture, "Demo project"), home = path.join(fixture, "home");
const output = path.resolve(__dirname, "../../../output/desktop-chat");
fs.mkdirSync(project); fs.mkdirSync(home); fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(project, "report.md"), "# 验证报告\n\n文件预览正常。\n");
fs.writeFileSync(path.join(project, "app.ts"), "export const ready = true;\n");
fs.writeFileSync(path.join(home, "desktop.json"), JSON.stringify({ projects: [project], settings: { startDaemonOnLaunch: false, minimizeToTray: false, theme: "dark" } }));
const sessions = [{ id: "chat-ui", agent: "codex", kind: "structured", title: "优化桌面端会话体验", cwd: project, status: "idle", createdAt: Date.now() }];
const events = [
  { kind: "user.message", msgId: "u1", text: "请改善 **桌面端阅读体验**，并提供报告。" },
  { kind: "text.delta", msgId: "c1", delta: "正在检查配色与布局。", phase: "commentary" },
  { kind: "reasoning.delta", msgId: "r1", delta: "检查标题、列表与代码块的阅读顺序。" },
  { kind: "tool.start", callId: "tool1", tool: "read_file", summary: "读取界面样式" },
  { kind: "tool.end", callId: "tool1", state: "success", summary: "已读取界面样式" },
  { kind: "text.delta", msgId: "a1", phase: "final_answer", delta: "## 桌面端已更新\n\n文字现在更清晰，**每轮结果独立展示**。\n\n- 标题、列表与表格正常排版\n- 过程可以随时展开\n\n| 项目 | 状态 |\n| --- | --- |\n| 配色 | 已修复 |\n| Markdown | 已支持 |\n\n```ts\nexport const ready = true;\n```\n\n[查看报告](report.md)" },
  { kind: "turn.end", msgId: "a1", finish: "completed", diffs: [{ path: "app.ts", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-export const ready = false;\n+export const ready = true;" }] },
  { kind: "user.message", msgId: "u2", text: "也检查一下浅色主题。" },
  { kind: "text.delta", msgId: "c2", delta: "正在检查浅色主题。", phase: "commentary" },
  { kind: "text.delta", msgId: "a2", phase: "final_answer", delta: "浅色主题也已调整，发送按钮的文字具有足够对比度。" },
  { kind: "turn.end", msgId: "a2", finish: "completed" },
  { kind: "user.message", msgId: "u3", text: "最后确认一下运行中的折叠行为。" },
  { kind: "text.delta", msgId: "c3", delta: "正在验证本轮的过程折叠…", phase: "commentary" },
];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("content-type", "application/json");
  if (url.pathname.endsWith("/view")) {
    const after = Number(url.searchParams.get("afterSeq"));
    if (!url.searchParams.has("afterSeq")) response.end(JSON.stringify({ mode: "snapshot", events, evSeq: events.length }));
    else if (after < events.length) response.end(JSON.stringify({ mode: "delta", events: events.slice(after), evSeq: events.length }));
    else setTimeout(() => { if (!response.destroyed) { response.statusCode = 204; response.end(); } }, 150);
  } else if (url.pathname.endsWith("/sessions")) response.end(JSON.stringify({ items: sessions, hasMore: false }));
  else response.end(JSON.stringify({ ok: true, available: false, items: [], modes: [], models: [] }));
});
process.env.PROSPERO_HOME = home;
process.argv.push("--background");
app.setPath("userData", path.join(fixture, "userData"));
app.disableHardwareAcceleration();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error("Chat check timed out"); app.exit(1); }, 90_000);
process.on("uncaughtException", error => { console.error(error); app.exit(1); });
process.on("unhandledRejection", error => { console.error(error); app.exit(1); });

app.on("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    const wc = window.webContents;
    const run = source => wc.executeJavaScript(source, true);
    const errors = [];
    wc.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
    const wait = async expression => { for (let i = 0; i < 80; i++) { if (await run(expression)) return; await delay(100); } throw new Error(`Timed out: ${expression}`); };
    const click = async selector => { await wait(`Boolean(document.querySelector(${JSON.stringify(selector)}))`); await run(`document.querySelector(${JSON.stringify(selector)}).click()`); await delay(100); };
    const screenshot = async name => fs.writeFileSync(path.join(output, `${name}.png`), (await wc.capturePage()).toPNG());
    const turn = index => `document.querySelectorAll('.chat-turn')[${index}]`;
    const pill = index => `${turn(index)}.querySelector('.chat-process-pill')`;
    try {
      window.setMinimumSize(640, 600); window.setSize(1280, 1000); window.setOpacity(0); window.showInactive();
      await wait("Boolean(document.querySelector('.prospero-shell'))");
      await run("localStorage.setItem('prospero.activeView','workspaces');localStorage.setItem('prospero.activeSession','chat-ui');localStorage.setItem('prospero.openSessions','[\"chat-ui\"]')");
      await new Promise(resolve => { wc.once("did-finish-load", resolve); wc.reload(); });
      await wait("document.querySelectorAll('.chat-turn').length===3");
      await wait("document.documentElement.classList.contains('dark')");
      assert.equal(await run(`${pill(0)}.getAttribute('aria-expanded')`), "false");
      assert.equal(await run(`${pill(1)}.getAttribute('aria-expanded')`), "false");
      assert.equal(await run(`${pill(2)}.getAttribute('aria-expanded')`), "true");
      assert.equal(await run("document.querySelectorAll('.chat-turn:first-child .chat-markdown h2').length"), 1);
      assert.equal(await run("document.querySelectorAll('.chat-turn:first-child .chat-markdown table').length"), 1);
      assert(await run("Boolean(document.querySelector('.chat-code-block .hljs-keyword'))"));
      assert(await run("Boolean(document.querySelector('[data-align=end] .chat-markdown strong'))"));
      const geometry = await run("(() => {const v=document.querySelector('[data-slot=message-scroller-viewport]').getBoundingClientRect();const r=document.querySelector('.conversation-rail').getBoundingClientRect();return {railCenter:r.top+r.height/2,viewportCenter:v.top+v.height/2}})()");
      assert(Math.abs(geometry.railCenter - geometry.viewportCenter) < 2, JSON.stringify(geometry));
      await run(`${pill(0)}.click()`); await delay(100);
      assert.equal(await run(`${pill(0)}.getAttribute('aria-expanded')`), "true");
      assert.equal(await run(`${pill(1)}.getAttribute('aria-expanded')`), "false");
      assert(await run(`${turn(0)}.innerText.includes('正在检查配色与布局')`));
      await run(`${pill(0)}.click()`);
      events.push({ kind: "text.delta", msgId: "a3", phase: "final_answer", delta: "本轮完成后，过程已自动折叠。" }, { kind: "turn.end", msgId: "a3", finish: "completed" });
      await wait(`${turn(2)}.dataset.completed==='true'`);
      assert.equal(await run(`${pill(2)}.getAttribute('aria-expanded')`), "false");
      await run("(() => {const input=document.querySelector('[data-chat-composer]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'继续优化');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await wait("!document.querySelector('[data-chat-send]').disabled");
      const colors = {};
      for (const theme of ["dark", "light"]) {
        await run(`window.prospero.updateSettings({theme:${JSON.stringify(theme)}})`);
        await wait(`document.documentElement.classList.contains('dark')===${theme === "dark"}`);
        await run("document.querySelector('[data-slot=message-scroller-viewport]').scrollTop=0");
        await delay(800);
        colors[theme] = await run("(() => {const s=getComputedStyle(document.querySelector('[data-chat-send]'));const m=getComputedStyle(document.querySelector('.chat-markdown'));const b=getComputedStyle(document.querySelector('.chat-pane'));return {buttonText:s.color,buttonBackground:s.backgroundColor,transition:s.transitionDuration,primaryText:s.getPropertyValue('--primary-foreground'),messageText:m.color,background:b.backgroundColor}})()");
        const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
        const lum = value => rgb(value).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
        const contrast = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05);
        const c = colors[theme];
        c.buttonContrast = contrast(c.buttonText, c.buttonBackground);
        c.messageContrast = contrast(c.messageText, c.background);
        assert(c.buttonContrast >= 4.5, JSON.stringify(c)); assert(c.messageContrast >= 4.5, JSON.stringify(c));
        await screenshot(`conversation-${theme}`);
      }
      await click('.chat-diff-trigger');
      await wait("Boolean(document.querySelector('[data-diff-line=added]'))");
      assert(await run("document.querySelector('.chat-diff-body').innerText.includes('export const ready = true')"));
      await run("document.querySelector('.chat-turn-results').scrollIntoView({block:'center'})");
      await delay(200);
      await screenshot("turn-diff");
      await click('.chat-result-files button');
      await wait("!document.querySelector('.project-preview-loading') && document.querySelector('.project-markdown-preview h1')?.textContent==='验证报告'");
      await delay(400);
      await screenshot("result-file");
      await click('[aria-label="隐藏工具栏"]');
      await run(`${pill(0)}.click();${pill(0)}.scrollIntoView({block:'start'})`); await delay(200);
      await screenshot("process-expanded");
      await run(`${pill(0)}.click()`);
      await run("window.prospero.updateSettings({theme:'dark'})");
      window.setSize(760, 740); await delay(250);
      await screenshot("conversation-compact");
      assert.equal(await run("document.querySelector('[data-slot=message-scroller-viewport]').scrollWidth>document.querySelector('[data-slot=message-scroller-viewport]').clientWidth"), false);
      events.push({ kind: "user.message", msgId: "u4", text: "请确认权限" }, { kind: "text.delta", msgId: "c4", delta: "等待审批后继续。", phase: "commentary" }, { kind: "permission.request", reqId: "pending", summary: "需要审批的操作" });
      await wait("document.querySelectorAll('.conversation-rail button').length===4");
      await click('.conversation-rail button:last-child');
      await wait("document.querySelectorAll('.chat-turn').length===4");
      await run(`${pill(3)}.click()`); await delay(100);
      assert(await run(`${turn(3)}.innerText.includes('需要审批的操作')`), "Pending permission stays visible when process is collapsed");
      events.push({ kind: "permission.resolved", reqId: "pending" }, { kind: "turn.end", msgId: "c4", finish: "interrupted" });
      await wait(`${turn(3)}.dataset.completed==='true'`);
      assert(await run(`${turn(3)}.innerText.includes('本轮已停止，未生成最终答复')`));
      for (let index = 0; index < 130; index++) events.push({ kind: "user.message", msgId: `history-u-${index}`, text: `历史问题 ${index}` }, { kind: "text.delta", msgId: `history-a-${index}`, delta: `答复 ${index}`, phase: "final_answer" }, { kind: "turn.end", msgId: `history-a-${index}`, finish: "completed" });
      await wait("document.querySelectorAll('.conversation-rail button').length===134");
      assert((await run("document.querySelectorAll('.chat-turn').length")) <= 120);
      const rail = await run("(() => {const r=document.querySelector('.conversation-rail');const v=document.querySelector('[data-slot=message-scroller-viewport]').getBoundingClientRect();const b=r.getBoundingClientRect();return {overflow:r.scrollHeight>r.clientHeight,top:b.top,bottom:b.bottom,viewportTop:v.top,viewportBottom:v.bottom}})()");
      assert(rail.overflow); assert(rail.top >= rail.viewportTop); assert(rail.bottom <= rail.viewportBottom);
      await click('.conversation-rail button:first-child');
      await wait("document.querySelector('.chat-turn .chat-markdown')?.textContent.includes('桌面端阅读体验')");
      await run("document.querySelector('.conversation-rail button:first-child').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))");
      await wait("document.querySelectorAll('.conversation-rail button')[133].getAttribute('aria-current')==='true'");
      assert.deepEqual(errors.filter(message => /Uncaught|Maximum update|unique.*key|validateDOMNesting/.test(message)), []);
      const result = { ok: true, geometry, colors, rail, checks: ["Markdown", "independent disclosure", "completion folds process", "result files", "turn diff", "theme contrast", "compact layout", "pending approval", "interrupted turn", "134-turn keyboard navigation"], output };
      fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
      console.log(JSON.stringify(result)); clearTimeout(deadline); app.exit(0);
    } catch (error) { console.error(error); console.error(errors); await screenshot("failure"); clearTimeout(deadline); app.exit(1); }
  });
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(home, "status.json"), JSON.stringify({ pid: process.pid, port: server.address().port, controlToken: "isolated-ui-test", sessions }));
  import(pathToFileURL(path.join(__dirname, "../out/main/index.js")).href);
});
