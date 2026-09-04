import type { JsonObject, SessionInfo } from "../shared/types";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/;

function boundedText(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : fallback;
}

function boundedNonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : fallback;
}

export function sessionInfoFromControl(value: unknown): SessionInfo {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("参数格式无效");
  const item = value as JsonObject;
  if (typeof item["id"] !== "string" || !SAFE_ID.test(item["id"])) throw new Error("会话无效");
  const messageQueue: NonNullable<SessionInfo["messageQueue"]> = Array.isArray(item["messageQueue"])
    ? item["messageQueue"].slice(0, 50).flatMap((raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
      const queued = raw as JsonObject;
      const id = boundedText(queued["id"], "", 500);
      const kind = queued["kind"];
      if (!id || (kind !== "queue" && kind !== "guide")) return [];
      return [{
        id,
        text: boundedText(queued["text"], "", 20_000),
        kind,
        createdAt: boundedNonNegativeInteger(queued["createdAt"]),
        attachmentCount: boundedNonNegativeInteger(queued["attachmentCount"]),
      }];
    })
    : [];
  const subagents = Array.isArray(item["subagents"])
    ? item["subagents"].flatMap((raw) => {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
      const subagent = raw as JsonObject;
      const id = typeof subagent["id"] === "string" ? subagent["id"].slice(0, 160) : "";
      return id ? [{
        id,
        ...(typeof subagent["name"] === "string" ? { name: subagent["name"].slice(0, 200) } : {}),
        ...(typeof subagent["role"] === "string" ? { role: subagent["role"].slice(0, 200) } : {}),
        ...(typeof subagent["status"] === "string" ? { status: subagent["status"].slice(0, 80) } : {}),
      }] : [];
    })
    : [];
  return {
    id: item["id"],
    agent: boundedText(item["agent"], "shell", 80),
    kind: boundedText(item["kind"], "pty", 80),
    title: boundedText(item["title"], "未命名会话", 500),
    ...(typeof item["displayTitle"] === "string" ? { displayTitle: item["displayTitle"].slice(0, 500) } : {}),
    cwd: boundedText(item["cwd"], "", 4_096),
    status: boundedText(item["status"], "unknown", 80),
    ...(typeof item["preview"] === "string" ? { preview: item["preview"].slice(0, 2_000) } : {}),
    ...(typeof item["createdAt"] === "number" && Number.isFinite(item["createdAt"])
      ? { createdAt: Math.max(0, Math.floor(item["createdAt"])) }
      : {}),
    ...(typeof item["accountId"] === "string" && item["accountId"].length > 0 && item["accountId"].length <= 100
      ? { accountId: item["accountId"] }
      : {}),
    ...(typeof item["accountName"] === "string" && item["accountName"].length > 0 && item["accountName"].length <= 80
      ? { accountName: item["accountName"] }
      : {}),
    ...(typeof item["pendingPermissions"] === "number" ? { pendingPermissions: boundedNonNegativeInteger(item["pendingPermissions"]) } : {}),
    ...(typeof item["pendingQuestions"] === "number" ? { pendingQuestions: boundedNonNegativeInteger(item["pendingQuestions"]) } : {}),
    ...(typeof item["approvalPolicy"] === "string" ? { approvalPolicy: item["approvalPolicy"].slice(0, 80) } : {}),
    ...(typeof item["busySince"] === "number" ? { busySince: boundedNonNegativeInteger(item["busySince"]) } : {}),
    ...(messageQueue.length > 0 ? { messageQueue } : {}),
    ...(subagents.length > 0 ? { subagents } : {}),
  };
}
