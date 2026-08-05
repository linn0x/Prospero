import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "./dist/adapters/claude.js";
import { StructuredSession } from "./dist/structured-session.js";

const cwd = mkdtempSync(path.join(os.tmpdir(), "usage-"));
const a = new ClaudeAdapter({});
const s = new StructuredSession({ id: "up", agent: "claude", title: "u", cwd, adapter: a });
s.on("event", () => {});
await s.start();

// 直接看 SDK 上有没有那个方法
const q = a.q ?? Object.values(a).find((v) => v && typeof v === "object" && "interrupt" in v);
console.log("adapter.q 存在:", !!a.q);
if (a.q) {
  const keys = Object.keys(a.q).concat(
    Object.getOwnPropertyNames(Object.getPrototypeOf(a.q) ?? {}),
  );
  console.log("含 usage 的方法:", keys.filter((k) => /usage/i.test(k)));
}
const r = await s.usage();
console.log("usage() 返回:", JSON.stringify(r, null, 2));
await s.dispose();
process.exit(0);
