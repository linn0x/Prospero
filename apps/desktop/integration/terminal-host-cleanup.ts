import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
/** Only call with an integration test's temporary daemon directory. */
export async function cleanupTerminalHosts(dataDir: string): Promise<void> {
  const root = resolve(dataDir, "terminal-hosts");
  if (!existsSync(root)) return;
  for (const id of readdirSync(root)) {
    const file = resolve(root, id, "host.json");
    if (!existsSync(file)) continue;
    const { base_url: base, token } = JSON.parse(readFileSync(file,"utf8"));
    const url = new URL(base);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("Unexpected test host address");
    const call = (action: string) => fetch(new URL(action, url), {method:"POST",headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(3000)});
    try {
      await call("close");
      for(let attempt=0;attempt<30;attempt++) {
        if((await call("release")).ok) break;
        await new Promise(done=>setTimeout(done,50));
      }
    } catch { /* The daemon may already have finalized and released this host. */ }
  }
}
