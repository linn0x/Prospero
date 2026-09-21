// Isolated interactive UX preview. Uses synthetic data; never starts a daemon.
// Run: npm run preview:ux -w @prospero/desktop
const {app}=require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');const {createServer}=require('node:http');
const repo=path.resolve(__dirname,'../../..');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'prospero-ux-preview-'));
const home=path.join(root,'home'),other=path.join(root,'Other project'),current=path.join(root,'Current project');
for(const p of [home,other,current])fs.mkdirSync(p,{recursive:true});
fs.writeFileSync(path.join(home,'desktop.json'),JSON.stringify({projects:[other,current],settings:{startDaemonOnLaunch:false,minimizeToTray:false,theme:'dark',daemonBackend:'legacy'}}));
const sessions=[{id:'preview-session',agent:'codex',kind:'structured',title:'当前项目会话',cwd:current,status:'idle',createdAt:1}];
if(process.argv.includes('--attention')) {
 sessions[0].pendingPermissions=2; sessions[0].pendingQuestions=1;
 for(let i=0;i<11;i++)sessions.push({id:'preview-shell-'+i,agent:'claude',kind:'pty',title:i%2?'claude · Current project':'Claude',cwd:i%2?current:other,status:'running',createdAt:i+2});
 fs.writeFileSync(path.join(home,'orchestration-desktop.json'),JSON.stringify({version:1,runs:[{id:'preview-run',status:'active',objective:'改进长标题任务的审批展示与完整上下文阅读',cwd:current}],tasks:[{id:'preview-task',runId:'preview-run',status:'failed',title:'检查多个项目同时运行时，审批请求、待回答问题和失败任务是否都能被清晰识别并完成处理',spec:'完整任务说明。\n包含上下文、验证步骤和恢复操作。',cwd:current}],gates:[{id:'preview-gate',taskId:'preview-task',runId:'preview-run',status:'pending',question:'完整审批请求：是否继续处理当前任务？\n请先阅读这一段完整上下文，再选择。',reason:'这是隔离预览数据，不会执行真实操作。',options:['继续','暂停']}],worktreeAssets:[]}));
}
const accounts=['codex','claude'].map(agent=>({id:'native-'+agent,agent,name:agent==='codex'?'Codex':'Claude Code',status:'signed_in',isDefault:true,engine:agent,capabilities:{sessionKinds:['structured','pty'],modelSelection:false,reasoningEffort:false,plan:true,resume:true}}));
const sources=[{id:'preview-source',name:'示例模型源',revision:1,enabled:true,endpoints:[{protocol:'openai_responses',baseUrl:'https://models.invalid/v1'},{protocol:'anthropic',baseUrl:'https://models.invalid'}],credentials:[{id:'preview-key',name:'示例凭据',revision:1}],routes:[{id:'demo-codex',name:'示例模型 · Codex',model:'demo-codex',protocol:'openai_responses',credentialId:'preview-key',enabled:true},{id:'demo-claude',name:'示例模型 · Claude',model:'demo-claude',protocol:'anthropic',credentialId:'preview-key',enabled:true}],defaultRouteId:'demo-codex',createdAt:1,updatedAt:1}];
const server=createServer((req,res)=>{let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{let body={};try{body=JSON.parse(raw||'{}');}catch{}const url=new URL(req.url,'http://127.0.0.1');res.setHeader('content-type','application/json');let result={ok:true,items:[],models:[],modes:[]};
 if(url.pathname.endsWith('/accounts'))result={type:'agent.accounts',requestId:body.requestId,ok:true,accounts};
 else if(url.pathname.endsWith('/model-sources'))result=body.action?.kind==='list'?{type:'model.source.result',requestId:body.requestId,ok:true,sources}:{type:'model.source.result',requestId:body.requestId,ok:false,error:{code:'unsupported',message:'预览模式不会修改配置或创建会话。'}};
 else if(url.pathname.endsWith('/sessions'))result={items:sessions,hasMore:false};
 else if(url.pathname.endsWith('/view'))result=process.argv.includes('--attention')?{kind:'pty',mode:url.searchParams.has('outputAfterSeq')?'delta':'snapshot',ansi:'Prospero isolated terminal preview\r\n$ ',output:'',seq:1,cols:120,rows:40,caughtUp:true}:{mode:'snapshot',events:[],evSeq:0};
 else if(url.pathname.endsWith('/resize'))result={ok:true};
 else if(req.method !== 'GET' && !url.pathname.endsWith('/view')){res.statusCode=400;result={error:'预览不会执行真实操作'};}
 else if(url.pathname.endsWith('/session/create')){res.statusCode=400;result={error:'预览不会创建真实会话'};}
 res.end(JSON.stringify(result));});});
process.env.PROSPERO_HOME=home;process.env.PROSPERO_BACKEND='legacy';process.env.PROSPERO_RUNTIME_SWITCH_FILE=path.join(root,'runtime-switch.json');
app.setPath('userData',path.join(root,'userData'));
app.on('browser-window-created',(_e,w)=>{w.on('page-title-updated',e=>{e.preventDefault();w.setTitle('Prospero UX preview');});});
app.on('will-quit',()=>server.close());
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(path.join(home,'status.json'),JSON.stringify({pid:process.pid,port:server.address().port,controlToken:'synthetic-ui-preview',sessions,capabilities:['model.sources.v1']}));console.log('Isolated UX preview ready');import(pathToFileURL(path.join(repo,'apps/desktop/out/main/index.js')).href);});
