const assert = require("node:assert/strict");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Called by the real Electron project-tools fixture. No model or live shell.
module.exports = async ({ window, run, wait, click, screenshot, shellCreates }) => {
  const wc = window.webContents;
  window.setSize(1800, 1000);
  await wait("document.querySelector('.workspace-dock-aside').clientWidth>620");
  await click('[data-slot="project-file-tab"][title="src/workspace.ts"]');
  const geometry = await run("(" + function () {
    const bounds = selector => [...document.querySelectorAll(selector)].find(el => el.getClientRects().length).getBoundingClientRect();
    const chat = bounds(".workspace-primary"), tools = bounds(".workspace-dock-aside");
    const header = bounds(".session-toolbar"), tabs = bounds(".context-dock-tabbar");
    const tree = bounds(".project-tools-panel"), preview = bounds(".project-preview-area");
    const messages = bounds("[data-slot=message-scroller-content]"), composer = bounds(".chat-composer-inner");
    return {
      chatWidth: chat.width, toolsWidth: tools.width, gap: tools.left - chat.right,
      headerTop: header.top, tabsTop: tabs.top, headerHeight: header.height, tabsHeight: tabs.height,
      treeLeft: tree.left, previewRight: preview.right, treeWidth: tree.width,
      gutterDelta: Math.abs(messages.left - composer.left), overflow: document.documentElement.scrollWidth > innerWidth,
    };
  }.toString() + ")()");
  assert.equal(geometry.overflow, false);
  assert.equal(geometry.gap, 1);
  assert.equal(geometry.headerTop, geometry.tabsTop);
  assert.equal(geometry.headerHeight, geometry.tabsHeight);
  assert(geometry.treeLeft >= geometry.previewRight && geometry.treeWidth >= 200);
  assert(geometry.gutterDelta <= 2, JSON.stringify(geometry));
  await screenshot("workspace-split-light");
  await click('[aria-label="切换文件树"]');
  assert.equal(await run("Boolean([...document.querySelectorAll('.project-tools-panel')].find(el=>el.getClientRects().length))"), false);
  await click('[aria-label="切换文件树"]');

  const separator = await run("(() => {const r=document.querySelector('.context-dock-resizer').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y+120),width:Number(document.querySelector('.context-dock-resizer').getAttribute('aria-valuenow'))}})()");
  wc.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, x: separator.x, y: separator.y });
  await delay(80);
  wc.sendInputEvent({ type: "mouseMove", button: "left", x: separator.x - 60, y: separator.y });
  await wait("Number(document.querySelector('.context-dock-resizer').getAttribute('aria-valuenow'))===" + (separator.width + 60));
  await delay(80);
  wc.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: separator.x - 60, y: separator.y });
  await wait("Number(document.querySelector('.context-dock-resizer').getAttribute('aria-valuenow'))===" + (separator.width + 60));
  await wait("!document.querySelector('[data-dock-resizing]')");
  assert.equal(await run("JSON.parse(localStorage.getItem('prospero.contextDock.v1')).width"), separator.width + 60);
  const moved = { x: separator.x - 60, y: separator.y };
  wc.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...moved });
  await delay(80);
  wc.sendInputEvent({ type: "mouseMove", button: "left", x: moved.x + 50, y: moved.y });
  await wait("Number(document.querySelector('.context-dock-resizer').getAttribute('aria-valuenow'))===" + (separator.width + 10));
  wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  wc.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: moved.x + 50, y: moved.y });
  await wait("Number(document.querySelector('.context-dock-resizer').getAttribute('aria-valuenow'))===" + (separator.width + 60));

  await click('[aria-label="打开工具标签"]');
  await run("[...document.querySelectorAll('[role=menuitem]')].find(el=>el.textContent==='终端').click()");
  await wait("Boolean(document.querySelector('.dock-terminal .xterm'))");
  await wait("document.querySelector('.dock-terminal').textContent.includes('实时终端')");
  await run("window.__terminal=document.querySelector('.dock-terminal .xterm')");
  await delay(300);
  const terminalGeometry = await run("['.dock-terminal','.terminal-host','.xterm-screen','.xterm-screen canvas'].map(s=>{const el=document.querySelector(s);const r=el?.getBoundingClientRect();return {s,width:r?.width,height:r?.height}})");
  assert(terminalGeometry.every(item => item.width > 100 && item.height > 100), JSON.stringify(terminalGeometry));
  await screenshot("workspace-terminal-light");
  await click('[data-slot="project-file-tab"][title="src/workspace.ts"]');
  await click("#dock-tab-terminal");
  assert.equal(await run("window.__terminal===document.querySelector('.dock-terminal .xterm')"), true);
  window.setSize(700, 740);
  await wait("Boolean(document.querySelector('.workspace-dock-sheet .xterm'))");
  assert.equal(await run("window.__terminal===document.querySelector('.workspace-dock-sheet .xterm')"), true);
  await run("document.querySelector('[aria-label=\"隐藏工具栏\"]').click()");
  await delay(30);
  assert.equal(await run("!document.querySelector('.workspace-dock-sheet') || Boolean(document.querySelector('.workspace-dock-sheet .xterm'))"), true, "Sheet keeps its content during the exit animation");
  await wait("!document.querySelector('.workspace-dock-sheet')");
  await click('[aria-label="切换工具栏"]');
  await wait("Boolean(document.querySelector('.workspace-dock-sheet .xterm'))");
  window.setSize(1800, 1000);
  await wait("Boolean(document.querySelector('.workspace-dock-aside .xterm'))");
  await wait("!document.querySelector('.workspace-dock-sheet')");
  assert.equal(await run("window.__terminal===document.querySelector('.workspace-dock-aside .xterm')"), true);
  assert.equal(shellCreates(), 1, "Switching tabs and dock placement never recreates the shell");
  await click('[data-slot="project-file-tab"][title="src/workspace.ts"]');
  await run("window.prospero.updateSettings({theme:'dark'})");
  await delay(600);
  await screenshot("workspace-split-dark");

  wc.debugger.attach("1.3");
  await wc.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  window.setSize(700, 740);
  await wait("Boolean(document.querySelector('.workspace-dock-sheet'))");
  assert(Number.parseFloat(await run("getComputedStyle(document.querySelector('.workspace-dock-sheet')).transitionDuration")) <= .001);
  wc.debugger.detach();
  return { ...geometry, shellCreates: shellCreates(), checks: ["aligned headers and composer", "right file tree", "pointer drag", "Escape rollback", "persistent terminal", "Sheet exit content", "reduced motion"] };
};
