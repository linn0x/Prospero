import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  AgentKind,
  Attachment,
  PermissionReply,
} from "@prospero/protocol";
import type { AdapterContext, AgentAdapter } from "../src/adapters/types.js";
import type { ResolvedSkill } from "../src/composer-context.js";
import {
  completeComposer,
  injectPortableSkills,
  prepareComposerPrompt,
  resolveExplicitSkills,
} from "../src/composer-context.js";
import { StructuredSession } from "../src/structured-session.js";

let root = "";
const skillName = "prospero-portable-test";
const skillBody = "PORTABLE_SKILL_BODY_7f31";

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "prospero-composer-"));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  writeFileSync(path.join(root, "src", "nested", "feature.ts"), "export const feature = true;\n");
  const skillDir = path.join(root, ".agents", "skills", skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Portable test workflow\n---\n\n${skillBody}\n`,
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("daemon 通用输入上下文", () => {
  it("只把项目相对文件路径作为候选返回客户端", async () => {
    const items = await completeComposer(root, "file", "feature");
    expect(items).toContainEqual(
      expect.objectContaining({ kind: "file", value: "src/nested/feature.ts" }),
    );
    expect(items.every((item) => !path.isAbsolute(item.value))).toBe(true);
  });

  it("发现项目 Skill，并在发送前重新校验 @ 与 $", async () => {
    const skills = await completeComposer(root, "skill", "portable");
    expect(skills).toContainEqual(
      expect.objectContaining({ kind: "skill", value: skillName }),
    );

    const prepared = await prepareComposerPrompt(
      root,
      `检查 @src/nested/feature.ts 和 @../outside.txt，再用 $${skillName}`,
    );
    expect(prepared.text).toContain("- src/nested/feature.ts");
    expect(prepared.text).not.toContain("- ../outside.txt");
    expect(prepared.skills).toHaveLength(1);
    expect(prepared.skills[0]?.contents).toContain(skillBody);
    expect(injectPortableSkills(prepared.text, prepared.skills)).toContain(skillBody);
  });

  it("显式 Skill 解析保持调用顺序，并对缺失项 fail-closed", async () => {
    const resolved = await resolveExplicitSkills(root, [skillName]);
    expect(resolved).toEqual([
      expect.objectContaining({ name: skillName, contents: expect.stringContaining(skillBody) }),
    ]);
    await expect(resolveExplicitSkills(root, [skillName, "missing-skill"]))
      .rejects.toThrow(/找不到显式指定的 Skill/);
  });
});

class CaptureAdapter implements AgentAdapter {
  readonly sends: { text: string; skills: ResolvedSkill[] }[] = [];

  constructor(readonly acceptsSkillInputs = false) {}

  async start(_ctx: AdapterContext): Promise<void> {}
  async send(
    text: string,
    _attachments?: Attachment[],
    skills: ResolvedSkill[] = [],
  ): Promise<void> {
    this.sends.push({ text, skills });
  }
  async respondPermission(_reqId: string, _reply: PermissionReply): Promise<void> {}
  async interrupt(): Promise<void> {}
  async dispose(): Promise<void> {}
}

describe("所有 ChatUI agent 的 Skill 送达", () => {
  it.each(["claude", "opencode", "grok"] satisfies AgentKind[])(
    "%s 收到同一份可移植 SKILL.md",
    async (agent) => {
      const adapter = new CaptureAdapter(false);
      const session = new StructuredSession({
        id: `portable-${agent}`,
        agent,
        title: `${agent} · portable`,
        cwd: root,
        adapter,
      });
      await session.start();
      await session.send(`请执行 $${skillName}`);
      expect(adapter.sends[0]?.text).toContain(skillBody);
      expect(adapter.sends[0]?.skills).toEqual([]);
      // 注入只发给后端；手机历史仍保持用户真正输入的短文本。
      expect(session.snapshot().events[0]).toMatchObject({
        kind: "user.message",
        text: `请执行 $${skillName}`,
      });
      await session.dispose();
    },
  );

  it("Codex 保留原生 Skill input，不把 SKILL.md 混进普通文本", async () => {
    const adapter = new CaptureAdapter(true);
    const session = new StructuredSession({
      id: "native-codex",
      agent: "codex",
      title: "codex · native",
      cwd: root,
      adapter,
    });
    await session.start();
    await session.send(`请执行 $${skillName}`);
    expect(adapter.sends[0]?.text).not.toContain(skillBody);
    expect(adapter.sends[0]?.skills).toEqual([
      expect.objectContaining({ name: skillName, contents: expect.stringContaining(skillBody) }),
    ]);
    await session.dispose();
  });
});
