// Isolated Electron -> MessagePort -> Rust daemon -> detached PTY owner check.
const {app}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const WebSocket=require('ws');const {buildSync}=require('esbuild');
const root=path.resolve(__dirname,'../../..');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'prospero-stream-ui-'));
const rustHome=path.join(temporary,'rust'),home=path.join(temporary,'legacy'),project=path.join(temporary,'project');
const output=path.join(root,'output/desktop-terminal');
for(const p of [path.join(rustHome,'desktop'),home,project,output])fs.mkdirSync(p,{recursive:true});
fs.writeFileSync(path.join(rustHome,'desktop/desktop.json'),JSON.stringify({projects:[project],settings:{startDaemonOnLaunch:true,minimizeToTray:false,theme:'dark'}}));
Object.assign(process.env,{PROSPERO_BACKEND:'rust',PROSPERO_RUST_HOME:rustHome,PROSPERO_HOME:home,PROSPERO_RUST_BINARY:path.join(root,'target/debug/prosperod-rs'),PROSPERO_RUNTIME_SWITCH_FILE:path.join(temporary,'backend.json')});
app.setPath('userData',path.join(rustHome,'electron'));process.argv.push('--background');
const codec=buildSync({stdin:{contents:'export * from "./apps/desktop/src/shared/terminal-stream";',resolveDir:root},bundle:true,write:false,platform:'node',format:'cjs'});
const mod={exports:{}};new Function('module','exports',codec.outputFiles[0].text)(mod,mod.exports);
const {TerminalStreamKind:K,encodeTerminalFrame:encode,decodeTerminalFrame:decode}=mod.exports;
const payload=value=>new TextEncoder().encode(JSON.stringify(value));const body=f=>JSON.parse(new TextDecoder().decode(f.payload));
const wireTrace=[];
const originalSend=WebSocket.prototype.send,originalEmit=WebSocket.prototype.emit;
function record(direction,data){try{const f=decode(data,direction==='out'?'client':'server');wireTrace.push({direction,kind:f.kind,seq:f.sequence,bytes:f.payload.length,...([K.Attach,K.Hello,K.Error].includes(f.kind)?{control:body(f)}:{})});}catch{}}
WebSocket.prototype.send=function(data,...args){record('out',data);return originalSend.call(this,data,...args)};
WebSocket.prototype.emit=function(event,...args){if(event==='message'&&args[1])record('in',args[0]);return originalEmit.call(this,event,...args)};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));let connection,sid,peer;
async function request(route,data){const response=await fetch(connection.baseUrl+route,{method:data===undefined?'GET':'POST',headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(10000)});return response;}
async function cleanup(){
 if(peer)peer.terminate();
 if(connection){if(sid)await request(`/v1/terminals/${sid}/close`,{}).catch(()=>{});await request('/v1/shutdown',{}).catch(()=>{});}
 // Release fixture-owned host processes even when the test fails midway.
 const owners=path.join(rustHome,'daemon/terminal-hosts');
 if(fs.existsSync(owners))for(const id of fs.readdirSync(owners)){
  try{const host=JSON.parse(fs.readFileSync(path.join(owners,id,'host.json'),'utf8'));const base=new URL(host.base_url);assert.equal(base.hostname,'127.0.0.1');
   const call=action=>fetch(new URL(action,base),{method:'POST',headers:{authorization:'Bearer '+host.token},signal:AbortSignal.timeout(2000)});
   await call('close').catch(()=>{});
   for(let attempt=0;attempt<30;attempt++){
    const released=await call('release').catch(()=>undefined);if(!released||released.ok)break;await delay(50);
   }
  }catch{}
 }
}
const deadline=setTimeout(()=>{console.error('stream UI timeout');void cleanup().finally(()=>app.exit(1));},90000);
app.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',async()=>{
 const wc=window.webContents;const run=source=>wc.executeJavaScript(source,true);
 const wait=async condition=>{for(let i=0;i<200;i++){if(await run(condition))return;await delay(50);}throw new Error('Timed out: '+condition)};
 const screenshot=async name=>fs.writeFileSync(path.join(output,name+'.png'),(await wc.capturePage()).toPNG());
 const loseGpu=()=>run("document.querySelectorAll('#workspace-session-panel canvas').forEach(canvas=>canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext())");
 try{
  window.setOpacity(0);window.setMinimumSize(600,400);window.setSize(1200,850);window.showInactive();
  await wait("Boolean(document.querySelector('.prospero-shell'))");
  const config=path.join(rustHome,'daemon/connection.json');
  for(let i=0;i<200&&!fs.existsSync(config);i++)await delay(50);
  connection=JSON.parse(fs.readFileSync(config,'utf8'));
  const created=await request('/v1/terminals',{title:'Stream UI fixture',agent:'custom',workspace:project,size:{cols:80,rows:24},command:'stty raw -echo; printf UI_READY; cat'});
  assert(created.ok);sid=(await created.json()).id;
  await run(`localStorage.setItem('prospero.activeView','workspaces');localStorage.setItem('prospero.activeSession',${JSON.stringify(sid)});localStorage.setItem('prospero.openSessions',JSON.stringify([${JSON.stringify(sid)}]));localStorage.setItem('prospero.workspaceFocus','false')`);
  await new Promise(resolve=>{wc.once('did-finish-load',resolve);wc.reload()});
  await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-screen'))");await loseGpu();
  await wait("document.querySelector('#workspace-session-panel .xterm-rows')?.textContent.includes('UI_READY')");
  await wait("!document.querySelector('#workspace-session-panel .xterm-helper-textarea')?.readOnly");
  // The lease proves this is the stream path, rather than a silent HTTP fallback.
  const denied=await request(`/v1/terminals/${sid}/input`,{dataB64:Buffer.from('bypass').toString('base64')});assert.equal(denied.status,409);
  const buttonVisible=await run("(()=>{const b=[...document.querySelectorAll('.terminal-control button')].find(b=>b.textContent==='释放控制');if(!b)return false;const r=b.getBoundingClientRect();return r.width>5&&r.height>5&&getComputedStyle(b.closest('.terminal-status')).clipPath==='none'})()");assert(buttonVisible,'controller release is actually visible');
  await run("document.querySelector('#workspace-session-panel .xterm-helper-textarea').focus()");
  for(const keyCode of ['a','b','c']){wc.sendInputEvent({type:'keyDown',keyCode});wc.sendInputEvent({type:'char',keyCode});wc.sendInputEvent({type:'keyUp',keyCode});}
  await wait("document.querySelector('#workspace-session-panel .xterm-rows')?.textContent.includes('UI_READYabc')");
  const frames=[];peer=new WebSocket(connection.baseUrl.replace(/^http/,'ws')+`/v1/terminals/${sid}/stream`,{headers:{authorization:'Bearer '+connection.token}});
  peer.on('message',(raw,binary)=>{if(!binary)return;const f=decode(raw,'server');frames.push(f);if([K.Snapshot,K.Output,K.Resize].includes(f.kind))peer.send(encode({kind:K.Applied,sequence:f.sequence,payload:new Uint8Array()}));});
  await new Promise((resolve,reject)=>{peer.once('open',resolve);peer.once('error',reject)});
  peer.send(encode({kind:K.Attach,sequence:0,payload:payload({wantControl:false})}));
  for(let i=0;i<100&&!frames.some(f=>f.kind===K.Ready);i++)await delay(25);assert(frames.some(f=>f.kind===K.Ready));
  peer.send(encode({kind:K.Acquire,sequence:1,payload:payload({takeover:true})}));
  await wait("document.querySelector('.terminal-status')?.textContent.includes('正在观察')");
  assert(await run("document.querySelector('#workspace-session-panel .xterm-helper-textarea').readOnly"));
  const before=await(await request(`/v1/terminals/${sid}/snapshot`)).json();window.setSize(900,700);await delay(250);
  const after=await(await request(`/v1/terminals/${sid}/snapshot`)).json();assert.deepEqual(after.size,before.size,'observer must not resize PTY');
  await run("[...document.querySelectorAll('.terminal-control button')].find(b=>b.textContent==='接管').click()");
  await wait("!document.querySelector('#workspace-session-panel .xterm-helper-textarea').readOnly");
  await screenshot('terminal-stream');
  // Main-frame reload must release the old socket/lease without waiting for GC.
  await new Promise(resolve=>{wc.once('did-finish-load',resolve);wc.reload()});
  await wait("Boolean(document.querySelector('#workspace-session-panel .xterm-screen'))");await loseGpu();
  await wait("document.querySelector('#workspace-session-panel .xterm-rows')?.textContent.includes('UI_READYabc')");
  await wait("!document.querySelector('#workspace-session-panel .xterm-helper-textarea').readOnly");
  const pasteText='LONG_PASTE_START'+('中文x'.repeat(3000))+'LONG_PASTE_END';
  await run(`(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(pasteText)});document.querySelector('#workspace-session-panel .terminal-host').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`);
  await wait("document.querySelector('#workspace-session-panel .xterm-rows')?.textContent.includes('LONG_PASTE_END')");
  const echoed=await(await request(`/v1/terminals/${sid}/output?afterSeq=0`)).json();
  const bytes=Buffer.concat(echoed.events.filter(e=>e.type==='output').map(e=>Buffer.from(e.dataB64,'base64')));
  assert(bytes.includes(Buffer.from(pasteText)),'multi-chunk Unicode paste must be complete and ordered');
  await run("window.__streamFixtureScreen=document.querySelector('#workspace-session-panel .xterm-screen')");
  assert((await request(`/v1/terminals/${sid}/close`,{})).ok);
  await wait("document.querySelector('.terminal-status')?.textContent.includes('会话已结束')");
  await delay(800);
  assert(await run("window.__streamFixtureScreen===document.querySelector('#workspace-session-panel .xterm-screen')"),'exit metadata must not recreate the terminal');
  assert(await run("document.querySelector('#workspace-session-panel .xterm-rows')?.textContent.includes('LONG_PASTE_END')"),'final screen remains visible after exit');
  const result={ok:true,checks:['real Electron MessagePort + daemon + detached host','binary stream active, HTTP bypass rejected','visible controller actions','keyboard echo','multi-client takeover','observer cannot resize','renderer reload releases old lease and restores screen','multi-chunk Unicode paste > 8 KiB','exit preserves the existing terminal and final output']};
  fs.writeFileSync(path.join(output,'stream-ui-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  clearTimeout(deadline);window.destroy();await cleanup();await delay(200);app.exit(0);
 }catch(error){console.error(error);console.error(JSON.stringify(wireTrace.slice(-30)));try{console.error(await run("document.querySelector('#workspace-session-panel')?.innerText"));await screenshot('terminal-stream-failure')}catch{}clearTimeout(deadline);window.destroy();await cleanup();app.exit(1)}
}));
import(pathToFileURL(path.join(__dirname,'../out/main/index.js')).href).catch(error=>{console.error(error);app.exit(1)});
process.on('exit',()=>fs.rmSync(temporary,{recursive:true,force:true}));
