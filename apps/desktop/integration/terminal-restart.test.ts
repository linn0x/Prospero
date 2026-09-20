import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { once } from "node:events";
import { Terminal } from "@xterm/xterm";
import { expect, it } from "vitest";
import { RustClient } from "../src/main/rust-client";
import { rustTerminalView } from "../src/main/rust-runtime";
import { TerminalRecovery } from "../src/main/terminal-recovery";
import { configureRustTerminalUnicode } from "../src/renderer/src/terminal-unicode";
import { writeTerminalEvents } from "../src/renderer/src/terminal-events";

const write = (t: Terminal, bytes: Uint8Array) => new Promise<void>(done => t.write(bytes, done));
const screen = (t: Terminal) => ({ x: t.buffer.active.cursorX, y: t.buffer.active.cursorY, mode: t.buffer.active.type,
  rows: Array.from({length:t.rows},(_,y)=>{const line=t.buffer.active.getLine(t.buffer.active.baseY+y);// The snapshot intentionally starts at the viewport, without the preceding
    // scrollback line; only that first line's incoming wrap edge is outside it.
    return {wrapped:y===0?undefined:line?.isWrapped,cells:Array.from({length:t.cols},(_,x)=>{const c=line?.getCell(x);return [c?.getChars() || (c?.getWidth()===0?"":" "),c?.getWidth(),c?.getFgColor(),c?.getBgColor()];})};}) });

it("reconnects a fresh desktop to the same live PTY after history pruning and continues at the exact snapshot cursor", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "prospero-cold-recovery-"));
  let child: ChildProcess | undefined; let connection: {baseUrl:string;token:string} | undefined;
  const original = new Terminal({cols:80,rows:24,allowProposedApi:true});
  const restored = new Terminal({cols:80,rows:24,allowProposedApi:true});
  configureRustTerminalUnicode(original); configureRustTerminalUnicode(restored);
  let recovery: TerminalRecovery | undefined;
  try {
    child=spawn(resolve("../../target/release/prosperod-rs"),["serve","--data-dir",dir],{stdio:["ignore","pipe","pipe"]});
    await new Promise<void>((done,fail)=>{let output="";const timer=setTimeout(()=>fail(new Error("daemon startup timeout")),10000);child!.once("exit",()=>{clearTimeout(timer);fail(new Error("daemon exited"));});child!.stdout!.on("data",b=>{output+=b;if(output.includes('"event":"ready"')){clearTimeout(timer);done();}});});
    connection=JSON.parse(await readFile(resolve(dir,"connection.json"),"utf8"));
    const c=connection!;
    const request=async(path:string,body?:unknown)=>{const r=await fetch(c.baseUrl+path,{method:body?"POST":"GET",headers:{authorization:`Bearer ${c.token}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});expect(r.ok).toBe(true);return r.json();};
    const session=await request("/v1/terminals",{title:"Recovery acceptance",agent:"custom",workspace:dir,size:{cols:80,rows:24},command:"stty raw -echo; printf READY; cat"});
    let cursor=0; let ready="";
    while(!ready.includes("READY")){const p=await request(`/v1/terminals/${session.id}/output?afterSeq=${cursor}&waitMs=1000`);cursor=p.nextSeq;await writeTerminalEvents(original,p.events,()=>true);for(const e of p.events)if(e.type==="output")ready+=Buffer.from(e.dataB64,"base64").toString();}
    // More than the daemon's 1 MiB retained byte budget; consume live output as
    // the old desktop would. Include the Claude mode that previously poisoned snapshots.
    for(let i=0;i<180;i++) {
      const text=(i===0?"\x1b[?2031h":"")+`row-${i}: 中文 🦀 `+"x".repeat(6900)+"\r\n";
      await request(`/v1/terminals/${session.id}/input`,{dataB64:Buffer.from(text).toString("base64")});
      let bytes=0;
      while(bytes<Buffer.byteLength(text)){const p=await request(`/v1/terminals/${session.id}/output?afterSeq=${cursor}&waitMs=1000`);expect(p.resyncRequired).toBe(false);cursor=p.nextSeq;await writeTerminalEvents(original,p.events,()=>true);for(const e of p.events)if(e.type==="output")bytes+=Buffer.from(e.dataB64,"base64").length;}
    }
    const retained=await request(`/v1/terminals/${session.id}/output?afterSeq=0`);
    expect(retained.floorSeq).toBeGreaterThan(0);
    const client = new RustClient(c.baseUrl,c.token);
    recovery=new TerminalRecovery(resolve(dir,"desktop-cache"));
    const frame=await rustTerminalView(client,session.id,undefined,0,AbortSignal.timeout(5000),recovery);
    expect(frame?.mode).toBe("snapshot");
    restored.resize(frame!.cols as number,frame!.rows as number);
    await write(restored,Buffer.from(frame!.dataB64 as string,"base64"));
    expect(screen(restored)).toEqual(screen(original));
    expect(frame!.seq).toBe(cursor);
    const suffix="\x1b[31mAFTER RESTART\x1b[0m\r\n";
    await request(`/v1/terminals/${session.id}/input`,{dataB64:Buffer.from(suffix).toString("base64")});
    const next=await rustTerminalView(client,session.id,cursor,1000,AbortSignal.timeout(5000),recovery);
    await writeTerminalEvents(original,next!.events,()=>true);await writeTerminalEvents(restored,next!.events,()=>true);
    expect(screen(restored)).toEqual(screen(original));
    await request(`/v1/terminals/${session.id}/close`,{});
  } finally {
    await recovery?.flush(); original.dispose();restored.dispose();
    if(connection)await fetch(connection.baseUrl+"/v1/shutdown",{method:"POST",headers:{authorization:`Bearer ${connection.token}`}}).catch(()=>{});
    if(child&&child.exitCode===null){const timer=setTimeout(()=>child?.kill("SIGKILL"),3000);await once(child,"exit");clearTimeout(timer);}
    await rm(dir,{recursive:true,force:true});
  }
},60000);
