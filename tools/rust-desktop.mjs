import { spawn } from "node:child_process";

const npm = process.env.npm_execpath;
if (!npm) throw new Error("Use npm run dev:desktop:rust");
const child = spawn(process.execPath, [npm, "run", "dev", "-w", "@prospero/desktop"], { env: { ...process.env, PROSPERO_BACKEND: "rust" }, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.once("error", () => { process.exitCode = 1; });
child.once("exit", code => { process.exitCode = code ?? 1; });
