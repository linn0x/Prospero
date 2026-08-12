import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventBody, Attachment, PermissionReply } from "@prospero/protocol";
import { StructuredSession } from "../src/structured-session.js";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";

const homes: string[] = [];
function isolateHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "prospero-att-"));
  homes.push(dir);
  process.env["PROSPERO_HOME"] = dir;
  return dir;
}
afterEach(() => {
  for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env["PROSPERO_HOME"];
  vi.restoreAllMocks();
});

/** 记录收到什么的假适配器 */
function fakeAdapter(acceptsImages: boolean) {
  const seen: { text: string; attachments?: Attachment[] }[] = [];
  const adapter: AgentAdapter = {
    acceptsImages,
    start: async (_ctx: AdapterContext) => {},
    send: async (text: string, attachments?: Attachment[]) => {
      seen.push({ text, ...(attachments ? { attachments } : {}) });
    },
    respondPermission: async (_r: string, _p: PermissionReply) => {},
    interrupt: async () => {},
    dispose: async () => {},
  };
  return { adapter, seen };
}

const png: Attachment = {
  mimeType: "image/png",
  // 1x1 透明 PNG
  dataB64:
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  name: "shot.png",
};

async function makeSession(acceptsImages: boolean) {
  const { adapter, seen } = fakeAdapter(acceptsImages);
  const events: AgentEventBody[] = [];
  const s = new StructuredSession({
    id: "att-test", agent: "claude", title: "t", cwd: os.tmpdir(), adapter,
  });
  s.on("event", (b) => events.push(b));
  await s.start();
  return { s, seen, events };
}

describe("消息附件", () => {
  it("后端能收图时，原样交给适配器，并保留可按需读取的历史索引", async () => {
    isolateHome();
    const { s, seen, events } = await makeSession(true);
    await s.send("这是什么错?", [png]);
    expect(seen[0]?.attachments).toHaveLength(1);
    expect(seen[0]?.text).toBe("这是什么错?");
    const user = events.find((event) => event.kind === "user.message");
    expect(user?.kind).toBe("user.message");
    if (!user || user.kind !== "user.message") return;
    expect(user.attachments).toHaveLength(1);
    expect(JSON.stringify(user)).not.toContain(png.dataB64);
    const attachment = user.attachments?.[0];
    expect(attachment?.name).toBe("shot.png");
    const chunk = await s.attachmentChunk(user.msgId, attachment!.id, 0, 1024);
    expect(chunk?.mimeType).toBe("image/png");
    expect(chunk?.data.toString("base64")).toBe(png.dataB64);
  });

  it("后端收不了图时落盘,并把路径并进文本", async () => {
    const home = isolateHome();
    const { s, seen } = await makeSession(false);
    await s.send("这是什么错?", [png]);

    expect(seen[0]?.attachments).toBeUndefined();
    expect(seen[0]?.text).toContain("这是什么错?");
    expect(seen[0]?.text).toContain("[附件]");

    const line = seen[0]!.text.split("\n").find((l) => l.startsWith("[附件]"))!;
    const file = line.replace("[附件] ", "");
    // 必须真的落在 ~/.prospero 下,而不是用户仓库里
    expect(file.startsWith(home)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).length).toBeGreaterThan(0);
  });

  it("只发图不带字也成立", async () => {
    isolateHome();
    const { s, seen } = await makeSession(true);
    await s.send("", [png]);
    expect(seen[0]?.attachments).toHaveLength(1);
  });

  it("聊天记录保存图片索引而不是把原图塞进事件快照", async () => {
    isolateHome();
    const { s, events } = await makeSession(true);
    await s.send("看这个", [png, png]);
    const user = events.find((e) => e.kind === "user.message");
    expect(user?.kind).toBe("user.message");
    if (!user || user.kind !== "user.message") return;
    expect(user.text).toBe("看这个");
    expect(user.attachments).toHaveLength(2);
    expect(new Set(user.attachments?.map((attachment) => attachment.id))).toHaveLength(2);
    expect(JSON.stringify(user)).not.toContain(png.dataB64);
  });

  it("文件名里的路径分隔符被消掉,不能借附件名写到别处", async () => {
    const home = isolateHome();
    const { s, seen } = await makeSession(false);
    await s.send("x", [{ ...png, name: "../../evil" }]);
    const line = seen[0]!.text.split("\n").find((l) => l.startsWith("[附件]"))!;
    const file = line.replace("[附件] ", "");
    expect(file.startsWith(path.join(home, "attachments"))).toBe(true);
    expect(file).not.toContain("..");
  });
});
