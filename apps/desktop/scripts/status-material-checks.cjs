const assert = require("node:assert/strict");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async ({ window, run, wait, click, screenshot, sessions, updateSession }) => {
  const wc = window.webContents;
  const [completed, , running, stopped, approval, unread] = sessions;
  await run("window.prospero.updateSettings({theme:'light'})"); await delay(250);
  await run("document.querySelectorAll('.workspace-session-more').forEach(button=>button.click())");
  const row = session => `[...document.querySelectorAll('.workspace-session-link')].find(el=>el.querySelector('.workspace-session-copy')?.textContent===${JSON.stringify(session.title)})`;
  const mark = session => `${row(session)}?.querySelector('.status-mark')`;
  updateSession(running.id, { status: "running" });
  updateSession(stopped.id, { status: "died", pendingPermissions: 1 });
  updateSession(approval.id, { status: "running", pendingPermissions: 1 });
  updateSession(unread.id, { status: "running" });
  await wait(`${mark(running)}?.dataset.motion==='breathe' && ${mark(approval)}?.dataset.motion==='blink' && ${mark(unread)}?.dataset.motion==='breathe'`);
  updateSession(unread.id, { status: "idle" });
  await wait(`${mark(unread)}?.dataset.motion==='bounce'`);
  assert.equal(await run(`${mark(stopped)}.dataset.state`), "terminated");
  const inspect = session => run(`(() => {const row=${row(session)},dot=row.querySelector('.status-mark'),s=getComputedStyle(dot),r=row.getBoundingClientRect(),d=dot.getBoundingClientRect(),title=row.querySelector('strong').getBoundingClientRect();return {state:dot.dataset.state,animation:s.animationName,color:s.backgroundColor,height:r.height,right:r.right-d.right,titleRight:title.right,dotLeft:d.left,small:row.querySelectorAll('small').length,label:dot.getAttribute('aria-label')}})()`);
  const states = {};
  for (const [key, session] of Object.entries({ completed, running, stopped, approval, unread })) states[key] = await inspect(session);
  assert.equal(states.completed.animation, "none");
  assert.equal(states.running.animation, "session-status-breathe");
  assert.equal(states.stopped.animation, "none");
  assert.equal(states.approval.animation, "session-status-blink");
  assert.equal(states.unread.animation, "session-status-bounce");
  assert.equal(states.completed.color, states.unread.color);
  assert.notEqual(states.completed.color, states.stopped.color);
  assert.notEqual(states.stopped.color, states.approval.color);
  const directoryHeight = await run("document.querySelector('.workspace-project-button').getBoundingClientRect().height");
  assert.equal(directoryHeight, 28);
  for (const state of Object.values(states)) { assert.equal(state.height, directoryHeight); assert.equal(state.small, 0); assert(Math.abs(state.right - 8) < 2 && state.dotLeft > state.titleRight); assert(state.label); }
  assert.equal(await run("document.querySelector('.session-toolbar-identity').querySelectorAll('span:not(.status-mark)').length"), 0);
  await run(`window.prospero.setSessionPinned(${JSON.stringify(unread.id)},true)`);
  await wait("Boolean(document.querySelector('.workspace-pinned-item .status-mark[data-motion=bounce]'))");
  assert.equal(await run("document.querySelector('.workspace-pinned-item .workspace-session-link').getBoundingClientRect().height"), directoryHeight);
  assert(Math.abs(await run("(() => {const row=document.querySelector('.workspace-pinned-item .workspace-session-link');return row.getBoundingClientRect().right-row.querySelector('.status-mark').getBoundingClientRect().right})()") - 8) < .1);
  await screenshot("session-status-light");
  await click(`#workspace-tab-${unread.id}`);
  await wait(`${mark(unread)}?.dataset.motion==='none'`);
  await click(`#workspace-tab-${completed.id}`);
  updateSession(completed.id, { status: "waiting_approval" });
  await wait("document.querySelector('.session-toolbar-identity .status-mark')?.dataset.motion==='blink'");
  updateSession(completed.id, { status: "idle" });
  await wait("document.querySelector('.session-toolbar-identity .status-mark')?.dataset.state==='completed'");
  await run("window.prospero.updateSettings({theme:'dark'})"); await delay(600); await screenshot("session-status-dark");

  const glass = {};
  const surface = '.workspace-tab.is-active';
  const style = selector => run(`(() => {const el=document.querySelector(${JSON.stringify(selector)}),s=getComputedStyle(el),p=getComputedStyle(el,'::after');return {filter:s.backdropFilter,shadow:s.boxShadow,border:p.display,pointer:p.pointerEvents,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}})()`);
  glass.windows = await style(surface); assert.equal(glass.windows.filter, "none");
  // The host OS may reduce transparency; model macOS's default preferences
  // explicitly, then check each accessibility fallback separately below.
  wc.debugger.attach('1.3');
  const media = [
    { name: 'prefers-reduced-transparency', value: 'no-preference' },
    { name: 'prefers-contrast', value: 'no-preference' },
    { name: 'forced-colors', value: 'none' },
    { name: 'prefers-reduced-motion', value: 'no-preference' },
  ];
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: media });
  const simulateMac = () => run("document.documentElement.dataset.platform='darwin';document.documentElement.dataset.nativeGlass='true';document.documentElement.dataset.reducedTransparency='false';document.documentElement.dataset.highContrast='false';document.querySelector('.windows-titlebar').style.display='none'");
  await simulateMac(); await delay(250);
  glass.main = await style(surface);
  assert.match(glass.main.filter, /blur\(/, JSON.stringify(await run(`({dataset:{...document.documentElement.dataset},token:getComputedStyle(document.documentElement).getPropertyValue('--glass-filter'),media:['prefers-reduced-transparency: no-preference','prefers-contrast: no-preference','forced-colors: none'].map(query=>[query,matchMedia('('+query+')').matches])})`)));
  assert.equal(glass.main.pointer, 'none');
  const hover = async selector => { await run(`(() => {const el=document.querySelector(${JSON.stringify(selector)}),r=el.getBoundingClientRect();el.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse',clientX:r.left+r.width*.3,clientY:r.top+r.height*.5}))})()`); await delay(60); };
  await hover(surface);
  assert.equal(await run(`document.querySelector('${surface}').style.getPropertyValue('--liquid-active')`), '1');
  assert.equal((await style(surface)).width, glass.main.width);
  glass.sidebar = await style('.context-dock .project-preview-tab.is-active'); assert.equal(glass.sidebar.filter, 'none');
  await hover('.context-dock [data-slot="toggle-group-item"]');
  assert.equal(await run("document.querySelector('.context-dock [data-slot=toggle-group-item]').style.getPropertyValue('--liquid-active')"), '');
  assert.equal((await style('.context-dock [data-slot="toggle-group-item"]')).border, 'none');
  await screenshot("session-tabs-mac-material");
  // Verify the shared Base UI Tabs component in a real dialog, too.
  await click('[aria-label="新增工作区"]');
  await wait("Boolean(document.querySelector('[role=dialog] [data-slot=tabs-trigger][data-active]'))");
  glass.dialog = await style('[role=dialog] [data-slot="tabs-trigger"][data-active]'); assert.match(glass.dialog.filter, /blur\(/);
  await click('[role="dialog"] [data-slot="dialog-close"]');
  await run("document.documentElement.dataset.reducedTransparency='true'");
  glass.reduced = await style(surface); assert.equal(glass.reduced.filter, 'none'); assert.equal(glass.reduced.border, 'none');
  await run("document.documentElement.dataset.reducedTransparency='false';document.documentElement.dataset.highContrast='true'");
  assert.equal((await style(surface)).filter, 'none');
  await run("document.documentElement.dataset.highContrast='false'");
  await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: media.map(feature => feature.name === 'prefers-reduced-motion' ? { ...feature, value: 'reduce' } : feature) });
  assert.equal(await run("[...document.querySelectorAll('.status-mark')].every(dot=>getComputedStyle(dot).animationName==='none')"), true);
  wc.debugger.detach();
  await run("document.documentElement.dataset.platform='win32';document.documentElement.dataset.nativeGlass='false';document.querySelector('.windows-titlebar').style.display=''");
  return { states, glass, checks: ['single-line rows and pins', 'right status dot', 'running/completed/stopped/approval/unread animations', 'background completion unread', 'opening clears unread', 'toolbar status without text', 'macOS tab material', 'conversation sidebar excluded', 'Base UI tabs', 'no hover layout shift', 'reduced transparency/high contrast/reduced motion'] };
};
