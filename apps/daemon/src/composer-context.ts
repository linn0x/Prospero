import os from "node:os";
import path from "node:path";
import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import type { ChatSuggestion, ChatSuggestionKind } from "@prospero/protocol";

const FILE_CACHE_MS = 15_000;
const SKILL_CACHE_MS = 30_000;
const MAX_INDEX_ENTRIES = 20_000;
const MAX_SKILLS = 500;
const MAX_SELECTED_SKILLS = 5;

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".expo",
  ".gradle",
  ".idea",
  ".next",
  ".turbo",
  ".xcode",
  "DerivedData",
  "Pods",
  "node_modules",
]);

interface IndexedPath {
  value: string;
  directory: boolean;
}

interface CacheEntry<T> {
  at: number;
  value: T;
}

interface SkillRoot {
  dir: string;
  scope: "项目" | "用户" | "Codex" | "Claude" | "OpenCode" | "Grok" | "插件";
  depth: number;
  priority: number;
}

export interface ResolvedSkill {
  name: string;
  description: string;
  path: string;
  contents: string;
}

interface DiscoveredSkill extends Omit<ResolvedSkill, "contents"> {
  scope: SkillRoot["scope"];
  priority: number;
}

const fileCache = new Map<string, CacheEntry<IndexedPath[]>>();
const skillCache = new Map<string, CacheEntry<DiscoveredSkill[]>>();

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function buildFileIndex(cwd: string): Promise<IndexedPath[]> {
  const root = path.resolve(cwd);
  const out: IndexedPath[] = [];
  const queue = [""];
  while (queue.length > 0 && out.length < MAX_INDEX_ENTRIES) {
    const relDir = queue.shift() ?? "";
    let entries: Dirent[];
    try {
      entries = await readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_INDEX_ENTRIES) break;
      const rel = path.join(relDir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        out.push({ value: `${normalizeRelative(rel)}/`, directory: true });
        queue.push(rel);
      } else if (entry.isFile()) {
        out.push({ value: normalizeRelative(rel), directory: false });
      }
      // 目录符号链接可能跳出项目或形成环；文件符号链接也不作为隐式上下文入口。
    }
  }
  return out;
}

async function indexedPaths(cwd: string): Promise<IndexedPath[]> {
  const key = path.resolve(cwd);
  const cached = fileCache.get(key);
  if (cached && Date.now() - cached.at < FILE_CACHE_MS) return cached.value;
  const value = await buildFileIndex(key);
  fileCache.set(key, { at: Date.now(), value });
  return value;
}

function subsequenceScore(haystack: string, needle: string): number | null {
  let cursor = 0;
  let gap = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return null;
    gap += found - cursor;
    cursor = found + 1;
  }
  return gap;
}

function matchScore(value: string, query: string): number | null {
  const haystack = value.toLocaleLowerCase();
  const basename = path.posix.basename(value.replace(/\/$/, "")).toLocaleLowerCase();
  const needle = query.trim().replace(/^@/, "").toLocaleLowerCase();
  const depth = value.split("/").length;
  if (!needle) return depth * 5 + value.length / 1000;
  if (basename === needle) return 0;
  if (basename.startsWith(needle)) return 10 + basename.length / 1000;
  const baseAt = basename.indexOf(needle);
  if (baseAt >= 0) return 20 + baseAt;
  const pathAt = haystack.indexOf(needle);
  if (pathAt >= 0) return 40 + pathAt + depth;
  const fuzzy = subsequenceScore(haystack, needle);
  return fuzzy === null ? null : 100 + fuzzy + depth;
}

async function completeFiles(cwd: string, query: string): Promise<ChatSuggestion[]> {
  const ranked = (await indexedPaths(cwd))
    .map((entry) => ({ entry, score: matchScore(entry.value, query) }))
    .filter((item): item is { entry: IndexedPath; score: number } => item.score !== null)
    .sort((a, b) => a.score - b.score || a.entry.value.localeCompare(b.entry.value))
    .slice(0, 30);
  return ranked.map(({ entry }) => {
    const plain = entry.value.replace(/\/$/, "");
    const parent = path.posix.dirname(plain);
    return {
      kind: "file",
      value: entry.value,
      label: path.posix.basename(plain),
      detail: `${entry.directory ? "目录" : "文件"}${parent === "." ? " · 项目根目录" : ` · ${parent}`}`,
    };
  });
}

function parseFrontmatter(contents: string, fallbackName: string): {
  name: string;
  description: string;
} {
  const block = contents.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? "";
  const scalar = (key: string): string => {
    const lines = block.split(/\r?\n/);
    const index = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
    if (index < 0) return "";
    const raw = lines[index]!.replace(new RegExp(`^${key}:\\s*`), "").trim();
    if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") {
      const folded: string[] = [];
      for (const line of lines.slice(index + 1)) {
        if (line.length > 0 && !/^\s/.test(line)) break;
        folded.push(line.trim());
      }
      return folded.filter(Boolean).join(raw.startsWith(">") ? " " : "\n");
    }
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1);
    }
    return raw;
  };
  return {
    name: scalar("name") || fallbackName,
    description: scalar("description") || "可复用的 Agent Skill",
  };
}

async function skillRoots(cwd: string): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = [];
  let current = path.resolve(cwd);
  let priority = 0;
  for (let level = 0; level < 16; level++) {
    roots.push({ dir: path.join(current, ".agents", "skills"), scope: "项目", depth: 4, priority: priority++ });
    roots.push({ dir: path.join(current, ".codex", "skills"), scope: "项目", depth: 4, priority: priority++ });
    roots.push({ dir: path.join(current, ".claude", "skills"), scope: "项目", depth: 4, priority: priority++ });
    roots.push({ dir: path.join(current, ".opencode", "skills"), scope: "项目", depth: 4, priority: priority++ });
    roots.push({ dir: path.join(current, ".grok", "skills"), scope: "项目", depth: 4, priority: priority++ });
    try {
      // worktree 的 .git 可以是普通文件；只要存在就已经到 repo root。
      await stat(path.join(current, ".git"));
      break;
    } catch {
      // 继续向上找 repo root。
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const home = os.homedir();
  roots.push({ dir: path.join(home, ".agents", "skills"), scope: "用户", depth: 5, priority: 100 });
  roots.push({ dir: path.join(home, ".codex", "skills"), scope: "Codex", depth: 6, priority: 110 });
  roots.push({ dir: path.join(home, ".claude", "skills"), scope: "Claude", depth: 5, priority: 120 });
  roots.push({ dir: path.join(home, ".config", "opencode", "skills"), scope: "OpenCode", depth: 5, priority: 130 });
  roots.push({ dir: path.join(home, ".opencode", "skills"), scope: "OpenCode", depth: 5, priority: 131 });
  roots.push({ dir: path.join(home, ".grok", "skills"), scope: "Grok", depth: 5, priority: 135 });
  roots.push({ dir: path.join(home, ".codex", "plugins", "cache"), scope: "插件", depth: 10, priority: 140 });
  return roots;
}

async function scanSkillRoot(root: SkillRoot): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = [];
  const visited = new Set<string>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > root.depth || out.length >= MAX_SKILLS) return;
    let actual: string;
    try {
      actual = await realpath(dir);
    } catch {
      return;
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    let entries: Dirent[];
    try {
      entries = await readdir(actual, { withFileTypes: true });
    } catch {
      return;
    }
    const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");
    if (skillFile) {
      const skillPath = path.join(actual, skillFile.name);
      try {
        const contents = await readFile(skillPath, "utf8");
        const metadata = parseFrontmatter(contents, path.basename(actual));
        out.push({
          ...metadata,
          path: skillPath,
          scope: root.scope,
          priority: root.priority,
        });
      } catch {
        // 单个损坏 Skill 不应让整个补全失败。
      }
      return; // Skill 自己的 references/scripts 下面不再扫描嵌套 Skill。
    }
    await Promise.all(
      entries
        .filter(
          (entry) =>
            (entry.isDirectory() || entry.isSymbolicLink()) &&
            !SKIP_DIRS.has(entry.name) &&
            (!entry.name.startsWith(".") || entry.name === ".system"),
        )
        .map((entry) => walk(path.join(actual, entry.name), depth + 1)),
    );
  };
  await walk(root.dir, 0);
  return out;
}

async function discoveredSkills(cwd: string): Promise<DiscoveredSkill[]> {
  const key = path.resolve(cwd);
  const cached = skillCache.get(key);
  if (cached && Date.now() - cached.at < SKILL_CACHE_MS) return cached.value;
  const roots = await skillRoots(key);
  const all = (await Promise.all(roots.map(scanSkillRoot))).flat();
  // 同名 Skill 按项目 → 用户 → 各 agent/插件的优先级覆盖。这样补全不会出现
  // 两个一模一样的 `$name`，发送时的解析结果也与 UI 里选中的一致。
  const byName = new Map<string, DiscoveredSkill>();
  for (const skill of all.sort((a, b) => a.priority - b.priority)) {
    const name = skill.name.toLocaleLowerCase();
    if (!byName.has(name)) byName.set(name, skill);
  }
  const value = [...byName.values()].slice(0, MAX_SKILLS);
  skillCache.set(key, { at: Date.now(), value });
  return value;
}

async function completeSkills(cwd: string, query: string): Promise<ChatSuggestion[]> {
  const needle = query.trim().replace(/^\$/, "").toLocaleLowerCase();
  return (await discoveredSkills(cwd))
    .map((skill) => {
      const name = skill.name.toLocaleLowerCase();
      const description = skill.description.toLocaleLowerCase();
      const score = !needle
        ? skill.priority
        : name === needle
          ? 0
          : name.startsWith(needle)
            ? 10
            : name.includes(needle)
              ? 20 + name.indexOf(needle)
              : description.includes(needle)
                ? 100 + description.indexOf(needle)
                : null;
      return { skill, score };
    })
    .filter((item): item is { skill: DiscoveredSkill; score: number } => item.score !== null)
    .sort((a, b) => a.score - b.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, 30)
    .map(({ skill }): ChatSuggestion => ({
      kind: "skill",
      value: skill.name,
      label: skill.name,
      detail: `${skill.scope} · ${skill.description}`,
    }));
}

export async function completeComposer(
  cwd: string,
  kind: ChatSuggestionKind,
  query: string,
): Promise<ChatSuggestion[]> {
  return kind === "file" ? completeFiles(cwd, query) : completeSkills(cwd, query);
}

async function resolveFileMentions(cwd: string, text: string): Promise<string[]> {
  const root = await realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
  const candidates: string[] = [];
  const pattern = /(?:^|[\s([{,])@(?:"([^"\n]+)"|([^\s\])},;]+))/g;
  for (const match of text.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? "").replace(/\/$/, "");
    if (!raw || path.isAbsolute(raw) || raw.split(/[\\/]/).includes("..")) continue;
    const candidate = path.resolve(root, raw);
    if (!inside(root, candidate)) continue;
    try {
      const actual = await realpath(candidate);
      if (!inside(root, actual)) continue;
      await stat(actual);
      candidates.push(normalizeRelative(path.relative(root, actual)));
    } catch {
      // 手输不存在的 @token 仍作为普通文本，不提升成可信文件引用。
    }
    if (candidates.length >= 20) break;
  }
  return [...new Set(candidates)];
}

async function resolveSkillMentions(cwd: string, text: string): Promise<ResolvedSkill[]> {
  const requested = [...text.matchAll(/(?:^|\s)\$([A-Za-z0-9][A-Za-z0-9._:-]*)/g)].map(
    (match) => match[1]!.toLocaleLowerCase(),
  );
  if (requested.length === 0) return [];
  const skills = await discoveredSkills(cwd);
  const selected: ResolvedSkill[] = [];
  for (const name of [...new Set(requested)]) {
    const match = skills.find((skill) => skill.name.toLocaleLowerCase() === name);
    if (!match) continue;
    try {
      selected.push({
        name: match.name,
        description: match.description,
        path: match.path,
        contents: await readFile(match.path, "utf8"),
      });
    } catch {
      // 补全后文件恰好被删：保留用户原文，让 agent 自己解释找不到。
    }
    if (selected.length >= MAX_SELECTED_SKILLS) break;
  }
  return selected;
}

export interface PreparedComposerPrompt {
  text: string;
  skills: ResolvedSkill[];
}

/** 解析用户显式选择的 @ 文件与 $ Skill；显示日志仍保留用户原文。 */
export async function prepareComposerPrompt(
  cwd: string,
  text: string,
): Promise<PreparedComposerPrompt> {
  const [files, skills] = await Promise.all([
    resolveFileMentions(cwd, text),
    resolveSkillMentions(cwd, text),
  ]);
  const withFiles =
    files.length === 0
      ? text
      : `${text}\n\n[Prospero file references]\nThe user explicitly selected these paths relative to the project root. Inspect them when relevant:\n${files.map((file) => `- ${file}`).join("\n")}`;
  return { text: withFiles, skills };
}

/** 没有原生 Skill input 的 agent 直接收到完整 SKILL.md，因而行为一致。 */
export function injectPortableSkills(text: string, skills: ResolvedSkill[]): string {
  if (skills.length === 0) return text;
  const instructions = skills
    .map(
      (skill) =>
        `--- Skill: ${skill.name} (${skill.path}) ---\n${skill.contents}\n--- End skill: ${skill.name} ---`,
    )
    .join("\n\n");
  return `[Prospero selected Agent Skills]\nThe user explicitly selected the following skills. Follow their instructions for this request, resolving relative references from each SKILL.md directory.\n\n${instructions}\n\n[User request]\n${text}`;
}
