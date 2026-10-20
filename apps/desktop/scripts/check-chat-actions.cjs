// Local sidebar organization checks using synthetic sessions, without model calls.
const {app}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'prospero-chat-actions-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const deadline=setTimeout(()=>app.exit(1),60000);
app.on('browser-window-created',(_,w)=>w.webContents.once('did-finish-load',async()=>{
 const wc=w.webContents,run=s=>wc.executeJavaScript(s);
 const wait=async source=>{for(let i=0;i<100;i++){if(await run(source))return;await delay(100);}throw new Error('Timed out: '+source);};
 try {
  await wait("!!document.querySelector('.workspace-project-button')");
  w.setSize(1200,800);w.show();w.focus();
  await run("(()=>{const p=[...document.querySelectorAll('.workspace-project-button')].find(e=>e.textContent.includes('Current project'));if(p.getAttribute('aria-expanded')!=='true')p.click();})()");
  await wait("!!document.querySelector('[data-slot=workspace-session-pin]')");
  await run("document.querySelector('.workspace-session-link').click()");
  await wait("document.querySelectorAll('.workspace-tab').length===1 && !!document.querySelector('[data-chat-composer]')");
  await run("document.querySelector('[data-slot=workspace-session-pin]').click()");
  await wait("!!document.querySelector('.workspace-pinned-item')");
  const point=await run("(()=>{const r=document.querySelector('.workspace-pinned-item').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()");
  wc.sendInputEvent({type:'mouseMove',...point});await delay(250);
  assert(await run("(()=>{const row=document.querySelector('.workspace-pinned-item'),pin=row.querySelector('[data-slot=workspace-session-pin]'),archive=row.querySelector('.workspace-session-archive');return getComputedStyle(archive).opacity==='1' && pin.getBoundingClientRect().right<=archive.getBoundingClientRect().left;})()"));
  fs.writeFileSync(path.join(out,'pinned-actions.png'),(await wc.capturePage()).toPNG());
  await run("document.querySelector('.workspace-pinned-item .workspace-session-archive').click()");
  await wait("!document.querySelector('.workspace-pinned-item') && document.querySelectorAll('.workspace-tab').length===0");
  assert.equal(await run("[...document.querySelectorAll('.workspace-session-link')].some(e=>e.textContent.includes('当前项目会话'))"),false);
  await run("document.querySelector('[data-testid=workspace-more]').click()");await delay(200);
  await run("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('已归档聊天')).click()");
  await wait("!!document.querySelector('.archived-chat-row')");
  fs.writeFileSync(path.join(out,'archived-chats.png'),(await wc.capturePage()).toPNG());
  await run("document.querySelector('.archived-chat-row button').click()");
  await wait("!document.querySelector('[role=dialog]') && document.querySelectorAll('.workspace-tab').length===1");
  assert(await run("[...document.querySelectorAll('.workspace-session-link')].some(e=>e.textContent.includes('当前项目会话'))"));
  await run("document.querySelector('.workspace-session-link').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:150,clientY:250}))");
  await wait("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.includes('创建聊天分支'))");
  assert(await run("[...document.querySelectorAll('[role=menuitem]')].some(e=>e.textContent.includes('复制会话配置'))"));
  await run("[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.includes('创建聊天分支')).click()");
  await wait("!!document.querySelector('.session-action-error')");
  assert(await run("(()=>{const e=document.querySelector('.session-action-error'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"), 'Unsupported-backend errors must stay above the workspace');
  console.log(JSON.stringify({ok:true,checks:['pin','hover actions','archive unpins and closes tab','restore and reopen','fork distinct from configuration copy'],screenshots:out}));clearTimeout(deadline);app.exit(0);
 } catch(e){console.error(e);console.error(out);fs.writeFileSync(path.join(out,'failure.png'),(await wc.capturePage()).toPNG());clearTimeout(deadline);app.exit(1);}
}));
require('./preview-ux.cjs');
