/**
 * 生成 unified diff。
 *
 * 为什么自己写:只有 Codex 会主动给 patch,Claude 的 Edit/Write 只给
 * old_string/new_string 或整份 content —— 要在手机上看清"改了哪几行",
 * 得由 daemon 合成。行级 LCS 足够,纯函数便于测试。
 */
import type { FileDiff } from "@prospero/protocol";

/** patch 传输上限:手机上看不完那么多,超出截断 */
const MAX_PATCH_CHARS = 8000;
/** 每个改动块上下保留的上下文行数 */
const CONTEXT_LINES = 3;

type Op = { type: " " | "+" | "-"; line: string };

/** 行级 LCS(长度矩阵),文件很大时退化为整体替换以免 O(n²) 爆炸 */
function lcsOps(a: string[], b: string[]): Op[] {
  const MAX_CELLS = 4_000_000;
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((line): Op => ({ type: "-", line })),
      ...b.map((line): Op => ({ type: "+", line })),
    ];
  }
  const m = a.length;
  const n = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: " ", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "+", line: b[j]! });
      j++;
    }
  }
  while (i < m) ops.push({ type: "-", line: a[i++]! });
  while (j < n) ops.push({ type: "+", line: b[j++]! });
  return ops;
}

/** 只保留改动附近的上下文,中间省略处插入 @@ 标记 */
function compact(ops: Op[]): string {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type === " ") continue;
    for (
      let d = Math.max(0, k - CONTEXT_LINES);
      d <= Math.min(ops.length - 1, k + CONTEXT_LINES);
      d++
    ) {
      keep[d] = true;
    }
  }
  const out: string[] = [];
  let skipping = false;
  for (let k = 0; k < ops.length; k++) {
    if (keep[k]) {
      skipping = false;
      out.push(ops[k]!.type + ops[k]!.line);
    } else if (!skipping) {
      skipping = true;
      out.push("@@");
    }
  }
  return out.join("\n");
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  return s.replace(/\n$/, "").split("\n");
}

export function makeDiff(path: string, before: string, after: string): FileDiff {
  const ops = lcsOps(splitLines(before), splitLines(after));
  const additions = ops.filter((o) => o.type === "+").length;
  const deletions = ops.filter((o) => o.type === "-").length;
  let patch = compact(ops);
  let truncated = false;
  if (patch.length > MAX_PATCH_CHARS) {
    patch = patch.slice(0, MAX_PATCH_CHARS);
    truncated = true;
  }
  return { path, patch, additions, deletions, ...(truncated ? { truncated: true } : {}) };
}

/** 新建文件:全部算作新增 */
export function makeCreateDiff(path: string, content: string): FileDiff {
  return makeDiff(path, "", content);
}

/**
 * 从已有的 unified diff 文本构造(Codex 直接给 patch 的情况)。
 * 只统计 +/- 行数,不重新计算。
 */
export function fromUnifiedPatch(path: string, patchText: string): FileDiff {
  const lines = patchText.split("\n").filter((l) => !/^(---|\+\+\+|diff |index )/.test(l));
  const additions = lines.filter((l) => l.startsWith("+")).length;
  const deletions = lines.filter((l) => l.startsWith("-")).length;
  let patch = lines.join("\n");
  let truncated = false;
  if (patch.length > MAX_PATCH_CHARS) {
    patch = patch.slice(0, MAX_PATCH_CHARS);
    truncated = true;
  }
  return { path, patch, additions, deletions, ...(truncated ? { truncated: true } : {}) };
}

/**
 * 从工具参数里尽力提取 diff。
 * Claude 的 Edit(old_string/new_string)、Write(content)、
 * MultiEdit(edits[])都能覆盖;认不出则返回 null。
 */
export function diffFromToolInput(
  tool: string,
  input: Record<string, unknown>,
): FileDiff | null {
  const path =
    typeof input["file_path"] === "string"
      ? input["file_path"]
      : typeof input["path"] === "string"
        ? input["path"]
        : null;
  if (path === null) return null;

  const lower = tool.toLowerCase();

  if (lower.includes("write") && typeof input["content"] === "string") {
    return makeCreateDiff(path, input["content"]);
  }

  if (
    typeof input["old_string"] === "string" &&
    typeof input["new_string"] === "string"
  ) {
    return makeDiff(path, input["old_string"], input["new_string"]);
  }

  // MultiEdit:把各段改动拼成一个 patch
  const edits = input["edits"];
  if (Array.isArray(edits) && edits.length > 0) {
    const parts: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const e of edits) {
      if (!e || typeof e !== "object") continue;
      const o = e as Record<string, unknown>;
      if (typeof o["old_string"] !== "string" || typeof o["new_string"] !== "string") continue;
      const d = makeDiff(path, o["old_string"], o["new_string"]);
      parts.push(d.patch);
      additions += d.additions;
      deletions += d.deletions;
    }
    if (parts.length === 0) return null;
    let patch = parts.join("\n@@\n");
    let truncated = false;
    if (patch.length > MAX_PATCH_CHARS) {
      patch = patch.slice(0, MAX_PATCH_CHARS);
      truncated = true;
    }
    return { path, patch, additions, deletions, ...(truncated ? { truncated: true } : {}) };
  }

  return null;
}
