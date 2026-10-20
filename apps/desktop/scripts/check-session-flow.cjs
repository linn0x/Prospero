// Isolated session-creation layout regression; uses synthetic preview data.
// Run after building: electron scripts/check-session-flow.cjs
const {app}=require('electron');const fs=require('node:fs');const assert=require('node:assert/strict');
const out=fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'prospero-session-flow-'));
const deadline=setTimeout(()=>app.exit(1),60_000);
app.on('will-quit',()=>clearTimeout(deadline));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.on('browser-window-created',(_,w)=>w.webContents.once('did-finish-load',async()=>{
 const wc=w.webContents;const run=s=>wc.executeJavaScript(s);
 try{
  for(let i=0;i<100;i++){if(await run("!!document.querySelector('.prospero-main')"))break;await delay(100);}
  w.setMinimumSize(700,600);w.setSize(1000,650);w.show();
  // The active session lives in the second project, not the fallback first one.
  await run(`(()=>{const p=[...document.querySelectorAll('.workspace-project-button')].find(e=>e.textContent.includes('Current project'));if(p.getAttribute('aria-expanded')!=='true')p.click();})()`);
  await delay(300);
  await run(`(()=>{const row=[...document.querySelectorAll('.workspace-session-link')].find(e=>e.textContent.includes('当前项目会话'));if(!row)throw new Error('Missing preview session');row.click();})()`);
  await delay(500);
  await run(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:window.prospero.platform==='darwin',ctrlKey:window.prospero.platform!=='darwin',bubbles:true,cancelable:true}))`);
  await delay(1500);
  assert(await run("document.querySelector('#session-project').value.endsWith('Current project')"), 'New-session shortcut must retain the active project');
  const measure=()=>run(`(()=>{const d=document.querySelector('[role="dialog"]');const f=d.querySelector('[data-slot="dialog-footer"]');const fields=d.querySelector('fieldset');const r=f.getBoundingClientRect();return {title:d.querySelector('[data-slot="dialog-title"]').textContent,footerTop:r.top,footerBottom:r.bottom,height:innerHeight,scrolls:fields.scrollHeight>fields.clientHeight};})()`);
  let initial=await measure();assert(initial.footerTop>=0&&initial.footerBottom<=initial.height);assert(initial.scrolls,'Long form should scroll independently');
  await run("document.querySelector('.session-create-fields').scrollTop=99999");await delay(200);assert.deepEqual(await measure(),initial);
  fs.writeFileSync(out+'/create-session.png',(await wc.capturePage()).toPNG());
  await run("document.querySelector('.session-create-fields').scrollTop=0;document.querySelectorAll('.create-dialog-tabs [role=tab]')[1].click()");await delay(500);
  assert(await run("document.querySelector('[data-slot=dialog-title]').textContent.includes('工作区')"));
  await run("document.querySelectorAll('.create-dialog-tabs [role=tab]')[0].click()");await delay(300);assert.equal((await measure()).title,'新建会话');
  // Configure accounts and return without rebuilding the user's form choices.
  for (const [id,value] of [['session-agent','claude'],['session-kind','pty'],['session-approval','strict']]) {
    await run(`(()=>{const select=document.getElementById(${JSON.stringify(id)});select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await delay(100);
  }
  await delay(300);
  const selections = () => run(`JSON.stringify(['session-project','session-agent','session-kind','session-approval'].map(id=>document.getElementById(id).value))`);
  const draft = await selections();
  assert.deepEqual(JSON.parse(draft).slice(1), ['claude', 'pty', 'strict']);
  await run("document.querySelector('.session-configure-accounts').click()");await delay(700);
  assert(await run("!document.querySelector('[role=dialog]') && !!document.querySelector('.session-draft-banner')"));
  assert(await run("document.querySelector('.accounts-page').getBoundingClientRect().bottom <= innerHeight + 1"), 'Account editor must fit beneath the resume banner');
  await run("document.querySelector('.session-draft-banner button').click()");await delay(700);
  assert.equal(await selections(), draft, 'Resume must preserve workspace, agent, type and approval policy');
  assert.equal(await run("!!document.querySelector('.session-draft-banner')"), false);
  await run("document.querySelector('.session-configure-accounts').click()");await delay(300);
  await run("document.querySelectorAll('.session-draft-banner button')[1].click()");await delay(200);
  assert.equal(await run("!!document.querySelector('.session-draft-banner') || !!document.querySelector('[role=dialog]')"), false, 'Discard should dismiss the return path without reopening creation');
  console.log(JSON.stringify({ok:true,initial,draftRestored:true,screenshot:out+'/create-session.png'}));app.exit(0);
 }catch(e){console.error(e);fs.writeFileSync(out+'/flow-failure.png',(await wc.capturePage()).toPNG());app.exit(1);}
}));require('./preview-ux.cjs');
