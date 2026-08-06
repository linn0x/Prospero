export interface ProjectFileReference {
  /** 始终是相对于会话项目根目录的 POSIX 路径。 */
  path: string;
  line?: number;
  column?: number;
}

const BARE_FILES = new Set([
  "AGENTS.md",
  "Dockerfile",
  "Gemfile",
  "LICENSE",
  "Makefile",
  "Podfile",
  "README",
  "SKILL.md",
]);

function normalizeAbsolute(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function normalizeRelative(input: string): string | null {
  const parts: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function looksLikeFile(path: string, explicit: boolean): boolean {
  if (path.endsWith("/") || /[?*{}$<>|]/.test(path)) return false;
  if (!explicit && /\s/.test(path)) return false;
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (!base) return false;
  if (BARE_FILES.has(base) || base.startsWith(".")) return true;
  if (/\.[A-Za-z][A-Za-z0-9+_-]{0,12}$/.test(base)) return true;
  // extensionless 文件（如 scripts/build）只在它确实长得像路径时识别。
  return path.includes("/") && /^[^\s.][^\s]*$/.test(base);
}

/**
 * 把 agent 给出的 Markdown href / 行内代码解析成受项目根约束的文件引用。
 * 绝对路径只有确实位于 projectRoot 下才会被降成相对路径；URL 与 `..` 一律拒绝。
 */
export function resolveProjectFileReference(
  target: string,
  projectRoot: string,
  explicit = false,
): ProjectFileReference | null {
  let raw = target.trim();
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1).trim();
  if (raw.startsWith("@")) raw = raw.slice(1);
  if (/^file:\/\//i.test(raw)) raw = raw.replace(/^file:\/\//i, "");
  else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) || /^(?:mailto|data):/i.test(raw)) {
    return null;
  }

  let line: number | undefined;
  let column: number | undefined;
  const fragment = /#L(\d+)(?:C(\d+))?$/i.exec(raw);
  if (fragment) {
    line = Number(fragment[1]);
    if (fragment[2]) column = Number(fragment[2]);
    raw = raw.slice(0, fragment.index);
  } else {
    const suffix = /:(\d+)(?::(\d+))?$/.exec(raw);
    if (suffix) {
      line = Number(suffix[1]);
      if (suffix[2]) column = Number(suffix[2]);
      raw = raw.slice(0, suffix.index);
    }
  }

  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  raw = raw.replace(/\\/g, "/");
  if (raw.endsWith("/")) return null;
  const normalizedRoot = normalizeAbsolute(projectRoot.replace(/\\/g, "/").replace(/\/$/, ""));
  if (!normalizedRoot) return null;

  let relative: string | null;
  if (raw.startsWith("/")) {
    const absolute = normalizeAbsolute(raw);
    if (!absolute || !absolute.startsWith(`${normalizedRoot}/`)) return null;
    relative = absolute.slice(normalizedRoot.length + 1);
  } else {
    relative = normalizeRelative(raw);
  }
  if (!relative || !looksLikeFile(relative, explicit)) return null;
  return {
    path: relative,
    ...(line !== undefined && line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}
