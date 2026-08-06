import type { ChatSuggestion, ChatSuggestionKind } from "@prospero/protocol";

export interface ComposerToken {
  kind: ChatSuggestionKind | "command";
  /** 要被候选替换的字符区间。 */
  start: number;
  end: number;
  query: string;
  trigger: "@" | "$" | "/skills" | "/";
}

/** 找光标处正在输入的 @文件、$Skill 或 /命令。 */
export function activeComposerToken(text: string, cursor = text.length): ComposerToken | null {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const prefix = text.slice(0, safeCursor);

  // `/skills foo` 是 `$foo` 的键盘友好别名；单独 `/skills` 仍先作为命令候选。
  const slashSkill = /^\/skills\s+([^\n]*)$/i.exec(prefix);
  if (slashSkill) {
    return {
      kind: "skill",
      start: 0,
      end: safeCursor,
      query: slashSkill[1] ?? "",
      trigger: "/skills",
    };
  }
  if (/^\/[^\s]*$/.test(prefix)) {
    return { kind: "command", start: 0, end: safeCursor, query: prefix.slice(1), trigger: "/" };
  }

  // 带空格的路径由 UI 插成 @"path with spaces"。
  const quotedFile = /(^|[\s([{,])@"([^"\n]*)$/.exec(prefix);
  if (quotedFile) {
    const boundary = quotedFile[1] ?? "";
    return {
      kind: "file",
      start: (quotedFile.index ?? 0) + boundary.length,
      end: safeCursor,
      query: quotedFile[2] ?? "",
      trigger: "@",
    };
  }

  const file = /(^|[\s([{,])@([^\s\])},;]*)$/.exec(prefix);
  if (file) {
    const boundary = file[1] ?? "";
    return {
      kind: "file",
      start: (file.index ?? 0) + boundary.length,
      end: safeCursor,
      query: file[2] ?? "",
      trigger: "@",
    };
  }

  const skill = /(^|[\s([{,])\$([A-Za-z0-9._:-]*)$/.exec(prefix);
  if (skill) {
    const boundary = skill[1] ?? "";
    return {
      kind: "skill",
      start: (skill.index ?? 0) + boundary.length,
      end: safeCursor,
      query: skill[2] ?? "",
      trigger: "$",
    };
  }
  return null;
}

export function replaceComposerToken(
  text: string,
  token: ComposerToken,
  suggestion: ChatSuggestion,
): { text: string; cursor: number } {
  if (token.kind === "command" || token.kind !== suggestion.kind) {
    return { text, cursor: token.end };
  }

  let inserted: string;
  const hasSeparator = /^\s/.test(text.slice(token.end));
  if (suggestion.kind === "skill") {
    inserted = `$${suggestion.value}${hasSeparator ? "" : " "}`;
  } else {
    const directory = suggestion.value.endsWith("/");
    const needsQuotes = /\s/.test(suggestion.value);
    inserted = needsQuotes ? `@"${suggestion.value}"` : `@${suggestion.value}`;
    if (!directory && !hasSeparator) inserted += " ";
  }
  const next = text.slice(0, token.start) + inserted + text.slice(token.end);
  return { text: next, cursor: token.start + inserted.length };
}
