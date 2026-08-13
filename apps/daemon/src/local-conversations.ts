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
  environment?: Record<string, string>,
  codexAppServerArgs?: string[],
): Promise<ResumableConversation[]> {
  const limit = Math.max(1, Math.min(50, requestedLimit));
  if (agent === "codex") {
    return CodexAdapter.searchLocalConversations(query, limit, environment, codexAppServerArgs);
  }

  if (environment?.["CLAUDE_CONFIG_DIR"]) {
    return searchClaudeConversations(environment["CLAUDE_CONFIG_DIR"], query, limit);
  }

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

/**
 * Claude SDK 的 listSessions 尚未暴露 configDir 参数；隔离账号不能通过临时改
 * process.env 来枚举（那会污染并发会话）。这里直接只读该官方目录的 JSONL
 * 元数据，真正恢复仍交给 SDK。
 */
async function searchClaudeConversations(
  configDir: string,
  query: string,
  limit: number,
): Promise<ResumableConversation[]> {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const path = await import("node:path");
  const projects = path.join(configDir, "projects");
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && !full.includes(`${path.sep}subagents${path.sep}`)) {
        files.push(full);
      }
    }
  };
  await walk(projects);
  const needle = query.trim().toLocaleLowerCase();
  const results = await Promise.all(
    files.map(async (file): Promise<ResumableConversation | null> => {
      try {
        const [raw, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
        const lines = raw.split("\n").filter(Boolean);
        let sessionId = path.basename(file, ".jsonl");
        let cwd = os.homedir();
        let firstPrompt = "";
        let title = "";
        let createdAt: number | undefined;
        for (const line of lines.slice(0, 120)) {
          let value: Record<string, unknown>;
          try {
            value = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof value["sessionId"] === "string") sessionId = value["sessionId"];
          if (typeof value["cwd"] === "string") cwd = value["cwd"];
          if (typeof value["timestamp"] === "string" && createdAt === undefined) {
            const parsed = Date.parse(value["timestamp"]);
            if (Number.isFinite(parsed)) createdAt = parsed;
          }
          if (typeof value["customTitle"] === "string") title = value["customTitle"];
          if (value["type"] === "user" && !firstPrompt) {
            const message = value["message"];
            if (message && typeof message === "object" && !Array.isArray(message)) {
              const content = (message as Record<string, unknown>)["content"];
              if (typeof content === "string") firstPrompt = content;
              else if (Array.isArray(content)) {
                firstPrompt = content
                  .map((block) =>
                    block && typeof block === "object" && typeof (block as Record<string, unknown>)["text"] === "string"
                      ? String((block as Record<string, unknown>)["text"])
                      : "",
                  )
                  .join(" ");
              }
            }
          }
          if (firstPrompt && title) break;
        }
        const displayTitle = (title.trim() || firstPrompt.trim() || "Claude 对话").slice(0, 500);
        if (needle && ![displayTitle, firstPrompt, cwd].some((value) => value.toLocaleLowerCase().includes(needle))) {
          return null;
        }
        return {
          id: sessionId,
          agent: "claude",
          title: displayTitle,
          ...(firstPrompt.trim() ? { preview: firstPrompt.trim().slice(0, 4000) } : {}),
          cwd,
          ...(createdAt !== undefined ? { createdAt: Math.round(createdAt) } : {}),
          updatedAt: Math.round(info.mtimeMs),
        };
      } catch {
        return null;
      }
    }),
  );
  return results
    .filter((value): value is ResumableConversation => value !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
}
