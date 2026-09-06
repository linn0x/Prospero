import type { JsonObject } from "./types";

export type AccountCapabilities = {
  sessionKinds: ("pty" | "structured")[];
  plan: boolean;
  resume: boolean;
  modelSelection: boolean;
  reasoningEffort: boolean;
};

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

export function accountEngine(account: JsonObject): string {
  if (typeof account["engine"] === "string" && ["codex", "claude", "opencode"].includes(account["engine"])) return account["engine"];
  return record(account["apiProfile"])["protocol"] === "openai_chat_completions"
    ? "opencode" : typeof account["agent"] === "string" ? account["agent"] : "codex";
}

export function accountCapabilities(account?: JsonObject): AccountCapabilities {
  const profile = record(account?.["apiProfile"]);
  const isApi = Object.keys(profile).length > 0;
  const chat = accountEngine(account ?? {}) === "opencode";
  const disabled = typeof account?.["apiProfileError"] === "string" || record(profile["modelCapabilities"])["tools"] === false;
  const supplied = record(account?.["capabilities"]);
  const kinds = supplied["sessionKinds"];
  return {
    sessionKinds: disabled ? [] : Array.isArray(kinds)
      ? kinds.filter((kind): kind is "pty" | "structured" => kind === "pty" || kind === "structured")
      : chat ? ["structured"] : ["pty", "structured"],
    ...Object.fromEntries((["plan", "resume", "modelSelection", "reasoningEffort"] as const).map((key) => [
      key, !disabled && (typeof supplied[key] === "boolean" ? supplied[key] : key === "plan" || key === "resume" ? !chat : !isApi),
    ])) as Pick<AccountCapabilities, "plan" | "resume" | "modelSelection" | "reasoningEffort">,
  };
}
