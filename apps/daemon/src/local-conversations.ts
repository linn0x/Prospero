import os from "node:os";
import { existsSync } from "node:fs";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { ResumableConversation } from "@prospero/protocol";
import { CodexAdapter } from "./adapters/codex.js";

export type ResumableAgent = ResumableConversation["agent"];

/**
 * 搜索 Agent 自己的本机持久化索引。这里只读元数据；真正的上下文在
 * session.create(resume) 时由官方 SDK/app-server 接回。
 */
export async function searchLocalConversations(
  agent: ResumableAgent,
  query: string,
  requestedLimit = 20,
): Promise<ResumableConversation[]> {
  const limit = Math.max(1, Math.min(50, requestedLimit));
  if (agent === "codex") return CodexAdapter.searchLocalConversations(query, limit);

  const needle = query.trim().toLocaleLowerCase();
  // Claude 的 API 目前只提供枚举；有搜索词时多取一些元数据后在 daemon 内过滤。
  const sessions = await listSessions({
    limit: needle ? 250 : limit,
    includeProgrammatic: true,
  });
  return sessions
    .filter((session) => {
      if (session.cwd && !existsSync(session.cwd)) return false;
      if (!needle) return true;
      return [
        session.customTitle,
        session.summary,
        session.firstPrompt,
        session.cwd,
        session.gitBranch,
        session.tag,
      ].some((value) => value?.toLocaleLowerCase().includes(needle));
    })
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, limit)
    .map((session): ResumableConversation => {
      const title =
        session.customTitle?.trim() ||
        session.summary.trim() ||
        session.firstPrompt?.trim() ||
        "Claude 对话";
      const preview = session.firstPrompt?.trim();
      return {
        id: session.sessionId,
        agent: "claude",
        title: title.slice(0, 500),
        ...(preview ? { preview: preview.slice(0, 4000) } : {}),
        cwd: session.cwd?.trim() || os.homedir(),
        ...(typeof session.createdAt === "number" && session.createdAt >= 0
          ? { createdAt: Math.round(session.createdAt) }
          : {}),
        updatedAt:
          typeof session.lastModified === "number" && session.lastModified >= 0
            ? Math.round(session.lastModified)
            : Date.now(),
      };
    });
}
