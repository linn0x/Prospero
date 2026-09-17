//! Skill discovery and composer mention resolution, ported verbatim in spirit
//! from the legacy daemon's `composer-context.ts`. Discovery is pure local
//! filesystem work: project roots walking up to the repository boundary, plus
//! per-user skill directories for each supported agent. Duplicate names resolve
//! by fixed precedence (project first, then user/agent/plugin roots).
//!
//! All functions here perform blocking filesystem I/O and must be called from
//! `spawn_blocking` in async contexts.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use ts_rs::TS;

use crate::error::{Error, Result};

const SKILL_CACHE_MS: Duration = Duration::from_millis(30_000);
const MAX_SKILLS: usize = 500;
const MAX_BOUND_SKILLS: usize = 5;
const MAX_FILE_REFERENCES: usize = 20;

const SKIP_DIRS: &[&str] = &[
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
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillScope {
    Project,
    User,
    Codex,
    Claude,
    OpenCode,
    Grok,
    Plugin,
}

impl SkillScope {
    fn label(self) -> &'static str {
        match self {
            SkillScope::Project => "项目",
            SkillScope::User => "用户",
            SkillScope::Codex => "Codex",
            SkillScope::Claude => "Claude",
            SkillScope::OpenCode => "OpenCode",
            SkillScope::Grok => "Grok",
            SkillScope::Plugin => "插件",
        }
    }
}

/// One discovered SKILL.md (contents not loaded).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub scope: String,
}

/// A discovered skill with SKILL.md contents loaded for prompt injection.
#[derive(Debug, Clone)]
pub struct ResolvedSkill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Clone)]
struct DiscoveredSkill {
    name: String,
    description: String,
    path: String,
    scope: SkillScope,
    priority: i64,
}

struct SkillRoot {
    dir: PathBuf,
    scope: SkillScope,
    depth: usize,
    priority: i64,
}

struct CacheEntry {
    at: Instant,
    value: Vec<DiscoveredSkill>,
}

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn skill_roots(cwd: &Path) -> Vec<SkillRoot> {
    let mut roots = Vec::new();
    let mut current = cwd.to_path_buf();
    let mut priority = 0i64;
    for _ in 0..16 {
        for folder in [".agents", ".codex", ".claude", ".opencode", ".grok"] {
            roots.push(SkillRoot {
                dir: current.join(folder).join("skills"),
                scope: SkillScope::Project,
                depth: 4,
                priority,
            });
            priority += 1;
        }
        // The worktree .git may be a plain file; its presence marks the root.
        if current.join(".git").exists() {
            break;
        }
        let parent = match current.parent() {
            Some(parent) if parent != current => parent.to_path_buf(),
            _ => break,
        };
        current = parent;
    }

    let Some(home) = home_dir() else { return roots };
    let user = |folder: &str, scope: SkillScope, depth: usize, priority: i64| SkillRoot {
        dir: home.join(folder),
        scope,
        depth,
        priority,
    };
    roots.push(user(".agents/skills", SkillScope::User, 5, 100));
    roots.push(user(".codex/skills", SkillScope::Codex, 6, 110));
    roots.push(user(".claude/skills", SkillScope::Claude, 5, 120));
    roots.push(user(
        ".config/opencode/skills",
        SkillScope::OpenCode,
        5,
        130,
    ));
    roots.push(user(".opencode/skills", SkillScope::OpenCode, 5, 131));
    roots.push(user(".grok/skills", SkillScope::Grok, 5, 135));
    // Standalone Prospero plugin ZIPs install here; keep this ahead of the
    // Codex cache so a user-installed plugin needs no marketplace entry.
    roots.push(user(".prospero/plugins", SkillScope::Plugin, 8, 139));
    roots.push(user(".codex/plugins/cache", SkillScope::Plugin, 10, 140));
    roots
}

fn parse_frontmatter(contents: &str, fallback_name: &str) -> (String, String) {
    // Frontmatter must start at byte 0: `---` optional spaces, newline ...
    let Some(rest) = contents.strip_prefix("---") else {
        return (fallback_name.to_owned(), "可复用的 Agent Skill".to_owned());
    };
    let after_marker = rest.trim_start_matches([' ', '\t']);
    let rest = if after_marker.starts_with('\n') || after_marker.starts_with("\r\n") {
        after_marker.trim_start_matches(['\r', '\n'])
    } else {
        return (fallback_name.to_owned(), "可复用的 Agent Skill".to_owned());
    };
    let block_end = memchr_block_end(rest);
    let block = match block_end {
        Some(index) => &rest[..index],
        None => return (fallback_name.to_owned(), "可复用的 Agent Skill".to_owned()),
    };

    fn scalar(block: &str, key: &str) -> String {
        let lines: Vec<&str> = block
            .split('\n')
            .map(|line| line.strip_prefix('\r').unwrap_or(line))
            .collect();
        for (index, line) in lines.iter().enumerate() {
            let prefix = format!("{key}:");
            let Some(rest) = line.strip_prefix(&prefix) else {
                continue;
            };
            let raw = rest.trim();
            if matches!(raw, ">" | "|" | ">-" | "|-") {
                let mut folded = Vec::new();
                for content in &lines[index + 1..] {
                    if !content.is_empty() && !content.starts_with(char::is_whitespace) {
                        break;
                    }
                    folded.push(content.trim());
                }
                return folded
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(if raw.starts_with('>') { " " } else { "\n" });
            }
            if raw.len() >= 2
                && ((raw.starts_with('"') && raw.ends_with('"'))
                    || (raw.starts_with('\'') && raw.ends_with('\'')))
            {
                return raw[1..raw.len() - 1].to_owned();
            }
            return raw.to_owned();
        }
        String::new()
    }

    let name = scalar(block, "name");
    let description = scalar(block, "description");
    (
        if name.is_empty() {
            fallback_name.to_owned()
        } else {
            name
        },
        if description.is_empty() {
            "可复用的 Agent Skill".to_owned()
        } else {
            description
        },
    )
}

/// Find the index in `rest` (the text after the opening `---`) where the
/// closing `---` line begins.
fn memchr_block_end(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] == b'-' && bytes[index..].starts_with(b"---") {
            let after = &bytes[index + 3..];
            if after.is_empty() || after.starts_with(b"\n") || after.starts_with(b"\r\n") {
                return Some(index);
            }
        }
        index += 1;
    }
    None
}

fn scan_skill_root(root: &SkillRoot) -> Vec<DiscoveredSkill> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();

    fn walk(
        dir: &Path,
        depth: usize,
        root: &SkillRoot,
        visited: &mut HashSet<PathBuf>,
        out: &mut Vec<DiscoveredSkill>,
    ) {
        if depth > root.depth || out.len() >= MAX_SKILLS {
            return;
        }
        let actual = match std::fs::canonicalize(dir) {
            Ok(path) => path,
            Err(_) => return,
        };
        if !visited.insert(actual.clone()) {
            return;
        }
        let entries = match std::fs::read_dir(&actual) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut children = Vec::new();
        let mut skill_file: Option<PathBuf> = None;
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let file_type = entry.file_type();
            let is_file = file_type
                .as_ref()
                .map(|kind| kind.is_file())
                .unwrap_or(false);
            let is_dir = file_type
                .as_ref()
                .map(|kind| kind.is_dir() || kind.is_symlink())
                .unwrap_or(false);
            if name == "SKILL.md" && is_file {
                skill_file = Some(actual.join(name.as_ref()));
                continue;
            }
            if is_dir
                && !SKIP_DIRS.contains(&name.as_ref())
                && (!name.starts_with('.') || name == ".system")
            {
                children.push(actual.join(name.as_ref()));
            }
        }
        if let Some(skill_path) = skill_file {
            if let Ok(contents) = std::fs::read_to_string(&skill_path) {
                let fallback = actual
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let (name, description) = parse_frontmatter(&contents, &fallback);
                out.push(DiscoveredSkill {
                    name,
                    description,
                    path: skill_path.to_string_lossy().into_owned(),
                    scope: root.scope,
                    priority: root.priority,
                });
            }
            // Never descend into a skill's own references/scripts directories.
            return;
        }
        for child in children {
            walk(&child, depth + 1, root, visited, out);
            if out.len() >= MAX_SKILLS {
                return;
            }
        }
    }

    walk(&root.dir, 0, root, &mut visited, &mut out);
    out
}

fn discovered_skills(cwd: &str) -> Vec<DiscoveredSkill> {
    let key = Path::new(cwd)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(cwd))
        .to_string_lossy()
        .into_owned();
    {
        let guard = cache().lock().unwrap();
        if let Some(entry) = guard.get(&key)
            && entry.at.elapsed() < SKILL_CACHE_MS
        {
            return entry.value.clone();
        }
    }
    let roots = skill_roots(Path::new(&key));
    let mut all: Vec<DiscoveredSkill> = Vec::new();
    for root in &roots {
        all.extend(scan_skill_root(root));
    }
    // Same-name skills follow project → user → agents/plugins precedence so
    // completion never offers two identical `$name` tokens.
    all.sort_by(|a, b| {
        a.priority
            .cmp(&b.priority)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    let mut by_name: HashSet<String> = HashSet::new();
    let mut value = Vec::new();
    for skill in all {
        let lower = skill.name.to_lowercase();
        if by_name.insert(lower) {
            value.push(skill);
            if value.len() >= MAX_SKILLS {
                break;
            }
        }
    }
    cache().lock().unwrap().insert(
        key,
        CacheEntry {
            at: Instant::now(),
            value: value.clone(),
        },
    );
    value
}

/// Effective skill catalog after precedence resolution (the `/v1/skills` list).
pub fn list_skills(cwd: &str) -> Vec<Skill> {
    discovered_skills(cwd)
        .into_iter()
        .map(|skill| Skill {
            name: skill.name,
            description: skill.description,
            path: skill.path,
            scope: skill.scope.label().to_owned(),
        })
        .collect()
}

/// Skill completion suggestions for the composer `$` lookup.
pub fn complete_skills(cwd: &str, query: &str) -> Vec<SkillSuggestion> {
    let needle = query.trim().trim_start_matches('$').to_lowercase();
    let mut scored: Vec<(i64, String, DiscoveredSkill)> = discovered_skills(cwd)
        .into_iter()
        .filter_map(|skill| {
            let name = skill.name.to_lowercase();
            let description = skill.description.to_lowercase();
            let score = if needle.is_empty() {
                skill.priority
            } else if name == needle {
                0
            } else if name.starts_with(&needle) {
                10
            } else if let Some(position) = name.find(&needle) {
                20 + position as i64
            } else {
                100 + description.find(&needle)? as i64
            };
            Some((score, skill.name.clone(), skill))
        })
        .collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    scored
        .into_iter()
        .take(30)
        .map(|(_, _, skill)| SkillSuggestion {
            kind: "skill".to_owned(),
            label: skill.name.clone(),
            value: skill.name,
            detail: format!("{} · {}", skill.scope.label(), skill.description),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SkillSuggestion {
    pub kind: String,
    pub value: String,
    pub label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub detail: String,
}

/// Iterator over `(?:^|\s)\$([A-Za-z0-9][A-Za-z0-9._:-]*)` mentions.
fn skill_mentions(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let at_start = i == 0;
        let preceded_by_space = !at_start && matches!(bytes[i - 1], b' ' | b'\t' | b'\n' | b'\r');
        if bytes[i] == b'$' && (at_start || preceded_by_space) {
            let start = i + 1;
            let mut end = start;
            let mut first = true;
            while end < bytes.len() {
                let ch = bytes[end];
                let valid = ch.is_ascii_alphanumeric()
                    || (!first && matches!(ch, b'.' | b'_' | b':' | b'-'));
                if !valid {
                    break;
                }
                first = false;
                end += 1;
            }
            if end > start {
                out.push(text[start..end].to_lowercase());
                i = end;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Resolve the user's `$skill` mentions to existing skills, loading contents.
fn resolve_skill_mentions(cwd: &str, text: &str) -> Vec<ResolvedSkill> {
    let requested = skill_mentions(text);
    if requested.is_empty() {
        return Vec::new();
    }
    let skills = discovered_skills(cwd);
    let mut selected = Vec::new();
    for name in requested {
        if selected
            .iter()
            .any(|skill: &ResolvedSkill| skill.name.to_lowercase() == name)
        {
            continue;
        }
        let Some(skill) = skills
            .iter()
            .find(|skill| skill.name.to_lowercase() == name)
        else {
            continue;
        };
        if let Ok(contents) = std::fs::read_to_string(&skill.path) {
            selected.push(ResolvedSkill {
                name: skill.name.clone(),
                description: skill.description.clone(),
                path: skill.path.clone(),
                contents,
            });
        }
        if selected.len() >= MAX_BOUND_SKILLS {
            break;
        }
    }
    selected
}

/// Strict resolution for orchestration workers: every explicitly named skill
/// must exist and be readable (a typo never silently degrades to plain text).
pub fn resolve_explicit_skills(cwd: &str, names: &[String]) -> Result<Vec<ResolvedSkill>> {
    let mut requested: Vec<String> = names
        .iter()
        .map(|name| name.trim().to_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    requested.sort();
    requested.dedup();
    if requested.is_empty() {
        return Ok(Vec::new());
    }
    if requested.len() > MAX_BOUND_SKILLS {
        return Err(Error::Invalid(format!(
            "每个 worker 最多显式绑定 {MAX_BOUND_SKILLS} 个 Skill"
        )));
    }
    let skills = discovered_skills(cwd);
    let mut selected = Vec::new();
    for name in requested {
        let Some(skill) = skills
            .iter()
            .find(|skill| skill.name.to_lowercase() == name)
        else {
            return Err(Error::Invalid(format!("找不到显式指定的 Skill: {name}")));
        };
        let contents = std::fs::read_to_string(&skill.path)
            .map_err(|_| Error::Invalid(format!("无法读取显式指定的 Skill: {}", skill.name)))?;
        selected.push(ResolvedSkill {
            name: skill.name.clone(),
            description: skill.description.clone(),
            path: skill.path.clone(),
            contents,
        });
    }
    Ok(selected)
}

/// Validate that every `$skill` mentioned in a task spec is explicitly bound.
pub fn assert_mentions_bound(spec: &str, allowed: &[String]) -> Result<()> {
    if allowed.is_empty() {
        return Ok(());
    }
    let allowed: HashSet<String> = allowed
        .iter()
        .map(|name| name.trim().to_lowercase())
        .collect();
    let mut undeclared: Vec<String> = skill_mentions(spec)
        .into_iter()
        .filter(|name| !allowed.contains(name))
        .collect();
    undeclared.sort();
    undeclared.dedup();
    if !undeclared.is_empty() {
        return Err(Error::Invalid(format!(
            "任务 spec 引用了未显式绑定的 Skill: {}",
            undeclared.join(", ")
        )));
    }
    Ok(())
}

fn is_inside(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

fn has_parent_segment(raw: &str) -> bool {
    raw.split(['/', '\\']).any(|part| part == "..")
}

/// Resolve explicit `@path`/`@"quoted path"` file mentions, ported from the
/// legacy `resolveFileMentions`: non-absolute, contained, existing paths only.
fn resolve_file_mentions(cwd: &str, text: &str) -> Vec<String> {
    let root = Path::new(cwd)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(cwd));
    let bytes = text.as_bytes();
    let mut candidates: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let valid_prefix = i == 0
            || matches!(
                bytes[i - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b'(' | b'[' | b'{' | b','
            );
        if bytes[i] != b'@' || !valid_prefix {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        let mut raw;
        if end < bytes.len() && bytes[end] == b'"' {
            let start = end + 1;
            end = start;
            while end < bytes.len() && bytes[end] != b'"' && bytes[end] != b'\n' {
                end += 1;
            }
            raw = text[start..end].to_string();
            if end < bytes.len() && bytes[end] == b'"' {
                end += 1;
            }
        } else {
            let start = end;
            while end < bytes.len()
                && !matches!(
                    bytes[end],
                    b' ' | b'\t' | b'\n' | b'\r' | b']' | b')' | b'}' | b',' | b';'
                )
            {
                end += 1;
            }
            raw = text[start..end].to_string();
        }
        raw = raw.trim_end_matches('/').to_string();
        i = end;
        if raw.is_empty() || Path::new(&raw).is_absolute() || has_parent_segment(&raw) {
            continue;
        }
        let candidate = root.join(&raw);
        if !is_inside(&root, &candidate) {
            continue;
        }
        if let Ok(actual) = std::fs::canonicalize(&candidate)
            && is_inside(&root, &actual)
            && std::fs::metadata(&actual).is_ok()
            && let Ok(relative) = actual.strip_prefix(&root)
        {
            let normalized = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if !candidates.contains(&normalized) {
                candidates.push(normalized);
            }
        }
        if candidates.len() >= MAX_FILE_REFERENCES {
            break;
        }
    }
    candidates
}

pub struct PreparedPrompt {
    pub text: String,
    pub skills: Vec<ResolvedSkill>,
}

/// Resolve explicit @ files and $ skills for one composer message.
pub fn prepare_composer_prompt(cwd: &str, text: &str) -> PreparedPrompt {
    let files = resolve_file_mentions(cwd, text);
    let skills = resolve_skill_mentions(cwd, text);
    let with_files = if files.is_empty() {
        text.to_owned()
    } else {
        format!(
            "{text}\n\n[Prospero file references]\nThe user explicitly selected these paths relative to the project root. Inspect them when relevant:\n{}",
            files
                .iter()
                .map(|file| format!("- {file}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    PreparedPrompt {
        text: with_files,
        skills,
    }
}

/// Inject full SKILL.md contents into a prompt. The Rust daemon only hosts the
/// Claude CLI, which has no native skill-input channel, so skills always travel
/// inline (identical wording to the legacy portable-skill path).
pub fn inject_portable_skills(text: &str, skills: &[ResolvedSkill]) -> String {
    if skills.is_empty() {
        return text.to_owned();
    }
    let instructions = skills
        .iter()
        .map(|skill| {
            format!(
                "--- Skill: {} ({}) ---\n{}\n--- End skill: {} ---",
                skill.name, skill.path, skill.contents, skill.name
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "[Prospero selected Agent Skills]\nThe user explicitly selected the following skills. Follow their instructions for this request, resolving relative references from each SKILL.md directory.\n\n{instructions}\n\n[User request]\n{text}"
    )
}

/// One composer turn fully prepared for the CLI: file block + inline skills.
pub fn expand_prompt(cwd: &str, text: &str) -> String {
    let prepared = prepare_composer_prompt(cwd, text);
    inject_portable_skills(&prepared.text, &prepared.skills)
}
