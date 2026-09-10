import type { FileDiff } from "@prospero/protocol";
import { fromUnifiedPatch } from "./diff.js";

function diffPath(value: string): string {
  const raw = value.split("\t")[0]!.trim();
  let decoded = raw;
  if (raw.startsWith('"')) {
    // Git quotes non-ASCII filename bytes with octal UTF-8 escapes, which JSON cannot decode.
    const utf8 = raw.replace(/(?:\\[0-7]{3})+/g, (bytes) => Buffer.from(
      bytes.match(/[0-7]{3}/g)!.map((byte) => parseInt(byte, 8)),
    ).toString("utf8"));
    try { decoded = JSON.parse(utf8) as string; } catch { /* Keep uncommon Git quoting visible. */ }
  }
  return decoded.replace(/^[ab]\//, "");
}

/** An aggregate snapshot replaces earlier snapshots; it must never be summed with them. */
export function codexTurnDiffs(patch: string): FileDiff[] {
  return patch.split(/(?=^diff --git )/m).flatMap((section) => {
    const next = /^\+\+\+ (.+)$/m.exec(section)?.[1];
    const previous = /^--- (.+)$/m.exec(section)?.[1];
    const target = next && next !== "/dev/null" ? next : previous;
    const binaryTarget = /^diff --git (?:".*?"|.*?) (".*?"|b\/.*)$/m.exec(section)?.[1];
    const path = target ? diffPath(target) : binaryTarget ? diffPath(binaryTarget) : "";
    return path && path !== "/dev/null" ? [fromUnifiedPatch(path, section)] : [];
  });
}

export function codexFileChanges(item: Record<string, unknown>): FileDiff[] {
  return (Array.isArray(item["changes"]) ? item["changes"] : []).flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const change = value as Record<string, unknown>;
    return typeof change["path"] === "string" && typeof change["diff"] === "string"
      ? [fromUnifiedPatch(change["path"], change["diff"])] : [];
  });
}
