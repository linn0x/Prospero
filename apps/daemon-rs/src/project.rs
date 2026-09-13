use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use ts_rs::TS;

use crate::error::{Error, Result};

pub const MAX_EDIT_BYTES: u64 = 1024 * 1024;
pub const MAX_CHUNK_BYTES: u64 = 1024 * 1024;
pub const MAX_ENTRIES: usize = 2000;
const MAX_GIT_OUTPUT: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub kind: String,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub mtime: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsListing {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    pub entries: Vec<FsEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsContent {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    pub content_b64: String,
    #[ts(type = "number")]
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsWritten {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    #[ts(type = "number")]
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsChunk {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    #[ts(type = "number")]
    pub offset: u64,
    pub data_b64: String,
    #[ts(type = "number")]
    pub total: u64,
    pub eof: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FsDone {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    pub op: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummaryResult {
    pub r#type: String,
    pub sid: String,
    pub request_id: String,
    pub branch: Option<String>,
    #[ts(type = "number | null")]
    pub size_bytes: Option<u64>,
    pub size_complete: bool,
    #[ts(type = "number")]
    pub checked_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub index: String,
    pub worktree: String,
    pub untracked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResult {
    pub r#type: String,
    pub sid: String,
    pub branch: Option<String>,
    #[ts(type = "number")]
    pub ahead: u32,
    #[ts(type = "number")]
    pub behind: u32,
    pub files: Vec<GitFile>,
    pub staged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResult {
    pub r#type: String,
    pub sid: String,
    pub path: String,
    pub patch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryEntry {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitHistoryResult {
    pub r#type: String,
    pub sid: String,
    pub entries: Vec<GitHistoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitDone {
    pub r#type: String,
    pub sid: String,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsPathQuery {
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsChunkQuery {
    pub path: String,
    #[ts(type = "number")]
    pub offset: u64,
    #[ts(type = "number")]
    pub length: u64,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitDiffQuery {
    pub path: String,
    pub staged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    #[ts(type = "number")]
    pub line: usize,
    #[ts(type = "number")]
    pub column: usize,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    #[ts(type = "number")]
    pub scanned: usize,
    #[ts(type = "number")]
    pub skipped: usize,
    pub truncated: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSearchRequest {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub path_filter: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsWriteRequest {
    pub path: String,
    pub content_b64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_new: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_version: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsPathRequest {
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsRenameRequest {
    pub path: String,
    pub to: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitStageRequest {
    pub paths: Vec<String>,
    pub unstage: bool,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitRequest {
    pub message: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FsPutRequest {
    pub path: String,
    #[ts(type = "number")]
    pub offset: u64,
    pub data_b64: String,
    #[serde(rename = "final")]
    pub final_chunk: bool,
}

fn validate_rel_path(rel: &str, allow_root: bool) -> Result<()> {
    if rel.len() > 4096 || rel.contains('\0') || Path::new(rel).is_absolute() {
        return Err(Error::Invalid("invalid path".into()));
    }
    if !allow_root && (rel.is_empty() || rel == ".") {
        return Err(Error::Invalid("invalid path".into()));
    }
    for component in Path::new(rel).components() {
        if matches!(component, Component::ParentDir) {
            return Err(Error::Invalid("invalid path".into()));
        }
    }
    #[cfg(windows)]
    for part in rel.split(['/', '\\']) {
        let lower = part.to_ascii_lowercase();
        if !part.is_empty()
            && part != "."
            && (part.ends_with('.')
                || part.ends_with(' ')
                || matches!(
                    lower.split('.').next().unwrap_or(""),
                    "con"
                        | "prn"
                        | "aux"
                        | "nul"
                        | "com1"
                        | "com2"
                        | "com3"
                        | "com4"
                        | "com5"
                        | "com6"
                        | "com7"
                        | "com8"
                        | "com9"
                        | "lpt1"
                        | "lpt2"
                        | "lpt3"
                        | "lpt4"
                        | "lpt5"
                        | "lpt6"
                        | "lpt7"
                        | "lpt8"
                        | "lpt9"
                ))
        {
            return Err(Error::Invalid("invalid path".into()));
        }
    }
    Ok(())
}

fn contains(base: &Path, target: &Path) -> bool {
    target == base || target.starts_with(base)
}

fn normalize_relative_path(rel: &str) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in Path::new(rel).components() {
        if let Component::Normal(part) = component {
            normalized.push(part);
        }
    }
    normalized
}

fn validate_desktop_rel_path(rel: &str, allow_root: bool) -> Result<()> {
    validate_rel_path(rel, allow_root)?;
    if rel.contains(':') {
        return Err(Error::Invalid("invalid path".into()));
    }
    if rel
        .split(['/', '\\'])
        .any(|part| part.eq_ignore_ascii_case(".git"))
    {
        return Err(Error::Invalid("invalid path".into()));
    }
    Ok(())
}

fn resolve_desktop_mutation_target(root: &Path, rel: &str) -> Result<PathBuf> {
    validate_desktop_rel_path(rel, false)?;
    let real_root = std::fs::canonicalize(root).map_err(|_| Error::NotFound)?;
    let lexical = real_root.join(normalize_relative_path(rel));
    if !contains(&real_root, &lexical) || lexical == real_root {
        return Err(Error::Forbidden);
    }
    match std::fs::canonicalize(&lexical) {
        Ok(real) => {
            if real != lexical || !contains(&real_root, &real) {
                return Err(Error::Forbidden);
            }
            Ok(real)
        }
        Err(_) => {
            let parent = lexical.parent().ok_or(Error::NotFound)?;
            let real_parent = std::fs::canonicalize(parent).map_err(|_| Error::NotFound)?;
            if real_parent != parent || !contains(&real_root, &real_parent) {
                return Err(Error::Forbidden);
            }
            Ok(lexical)
        }
    }
}

fn resolve_within(root: &Path, rel: &str, allow_root: bool) -> Result<PathBuf> {
    validate_rel_path(rel, allow_root)?;
    let real_root = std::fs::canonicalize(root).map_err(|_| Error::NotFound)?;
    let candidate = real_root.join(rel);
    match std::fs::canonicalize(&candidate) {
        Ok(real) => {
            if !contains(&real_root, &real) {
                return Err(Error::Forbidden);
            }
            Ok(real)
        }
        Err(_) => {
            let parent = candidate.parent().ok_or(Error::NotFound)?;
            let real_parent = std::fs::canonicalize(parent).map_err(|_| Error::NotFound)?;
            if !contains(&real_root, &real_parent) {
                return Err(Error::Forbidden);
            }
            Ok(real_parent.join(candidate.file_name().ok_or(Error::NotFound)?))
        }
    }
}

fn mtime_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |duration| {
            duration.as_millis().min(u64::MAX as u128) as u64
        })
}

pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<FsEntry>> {
    let dir = resolve_within(root, rel, true)?;
    if !std::fs::metadata(&dir)
        .map_err(|_| Error::NotFound)?
        .is_dir()
    {
        return Err(Error::Invalid("not a directory".into()));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|_| Error::Forbidden)?
        .take(MAX_ENTRIES)
    {
        let entry = entry.map_err(|_| Error::Forbidden)?;
        let file_type = entry.file_type().map_err(|_| Error::Forbidden)?;
        let info = std::fs::metadata(entry.path()).ok();
        entries.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            kind: if file_type.is_dir() {
                "dir"
            } else if file_type.is_symlink() {
                "symlink"
            } else if file_type.is_file() {
                "file"
            } else {
                "other"
            }
            .into(),
            size: info
                .as_ref()
                .filter(|meta| meta.is_file())
                .map_or(0, |meta| meta.len()),
            mtime: info.as_ref().map_or(0, mtime_ms),
        });
    }
    entries.sort_by(
        |a, b| match (a.kind.as_str() == "dir", b.kind.as_str() == "dir") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        },
    );
    Ok(entries)
}

pub fn read_for_edit(root: &Path, rel: &str) -> Result<(Vec<u8>, u64, bool, bool)> {
    let file = resolve_within(root, rel, false)?;
    let metadata = std::fs::metadata(&file).map_err(|_| Error::NotFound)?;
    if !metadata.is_file() {
        return Err(Error::Invalid("not a file".into()));
    }
    let mut handle = std::fs::File::open(&file).map_err(|_| Error::Forbidden)?;
    let mut data = Vec::new();
    let limit = metadata.len().min(MAX_EDIT_BYTES) as usize;
    std::io::Read::by_ref(&mut handle)
        .take(limit as u64)
        .read_to_end(&mut data)?;
    let binary = data.contains(&0);
    Ok((
        data,
        metadata.len(),
        metadata.len() > MAX_EDIT_BYTES,
        binary,
    ))
}

pub fn write_file_at(
    root: &Path,
    rel: &str,
    content: Vec<u8>,
    create_new: bool,
    expected_version: Option<String>,
) -> Result<u64> {
    if content.len() as u64 > MAX_EDIT_BYTES {
        return Err(Error::Invalid("content too large".into()));
    }
    if expected_version.is_some() && content.contains(&0) {
        return Err(Error::Invalid("invalid text content".into()));
    }
    let file = if create_new || expected_version.is_some() {
        resolve_desktop_mutation_target(root, rel)?
    } else {
        resolve_within(root, rel, false)?
    };
    let mut options = std::fs::OpenOptions::new();
    options.write(true).read(expected_version.is_some());
    if create_new {
        if expected_version.is_some() {
            return Err(Error::Invalid("invalid write precondition".into()));
        }
        options.create_new(true);
    } else if expected_version.is_none() {
        options.create(true);
    }
    if expected_version.is_some() {
        let metadata = std::fs::symlink_metadata(&file).map_err(|_| Error::NotFound)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(Error::Forbidden);
        }
    }
    let mut handle = options.open(&file).map_err(|_| Error::Forbidden)?;
    let metadata = handle.metadata().map_err(|_| Error::Forbidden)?;
    if !metadata.is_file() {
        return Err(Error::Forbidden);
    }
    if let Some(version) = expected_version {
        if version.len() != 64 || !version.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::Invalid("invalid version".into()));
        }
        if metadata.len() > MAX_EDIT_BYTES {
            return Err(Error::Invalid("file too large".into()));
        }
        use sha2::{Digest, Sha256};
        let mut existing = Vec::new();
        std::io::Read::by_ref(&mut handle).read_to_end(&mut existing)?;
        let actual = Sha256::digest(&existing)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if actual != version.to_ascii_lowercase() {
            return Err(Error::Conflict);
        }
    }
    use std::io::{Seek, Write};
    handle.seek(std::io::SeekFrom::Start(0))?;
    handle.write_all(&content)?;
    handle.set_len(content.len() as u64)?;
    Ok(content.len() as u64)
}

pub fn read_chunk(
    root: &Path,
    rel: &str,
    offset: u64,
    length: u64,
) -> Result<(Vec<u8>, u64, bool)> {
    if length == 0 || length > MAX_CHUNK_BYTES {
        return Err(Error::Invalid("invalid chunk length".into()));
    }
    let file = resolve_within(root, rel, false)?;
    let metadata = std::fs::metadata(&file).map_err(|_| Error::NotFound)?;
    if !metadata.is_file() {
        return Err(Error::Invalid("not a file".into()));
    }
    if offset >= metadata.len() {
        return Ok((Vec::new(), metadata.len(), true));
    }
    let want = length.min(MAX_CHUNK_BYTES).min(metadata.len() - offset) as usize;
    let mut handle = std::fs::File::open(&file).map_err(|_| Error::Forbidden)?;
    use std::io::{Read, Seek};
    handle.seek(std::io::SeekFrom::Start(offset))?;
    let mut data = vec![0; want];
    let read = handle.read(&mut data)?;
    data.truncate(read);
    Ok((data, metadata.len(), offset + read as u64 >= metadata.len()))
}

pub fn write_chunk(root: &Path, rel: &str, offset: u64, data: Vec<u8>) -> Result<u64> {
    if data.len() as u64 > MAX_CHUNK_BYTES {
        return Err(Error::Invalid("chunk too large".into()));
    }
    let file = resolve_within(root, rel, false)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|_| Error::Forbidden)?;
    }
    use std::io::{Seek, Write};
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    if offset == 0 {
        options.create(true).truncate(true);
    }
    let mut handle = options.open(&file).map_err(|_| Error::Forbidden)?;
    handle.seek(std::io::SeekFrom::Start(offset))?;
    handle.write_all(&data)?;
    Ok(handle.metadata()?.len())
}

pub fn make_dir(root: &Path, rel: &str) -> Result<()> {
    let dir = resolve_within(root, rel, false)?;
    if dir.exists() {
        return Err(Error::Forbidden);
    }
    std::fs::create_dir(&dir).map_err(|_| Error::Forbidden)
}

pub fn remove_entry(root: &Path, rel: &str) -> Result<()> {
    if rel.is_empty() {
        return Err(Error::Forbidden);
    }
    let target = resolve_within(root, rel, false)?;
    let metadata = std::fs::metadata(&target).map_err(|_| Error::NotFound)?;
    if metadata.is_dir() {
        if std::fs::read_dir(&target)
            .map_err(|_| Error::Forbidden)?
            .next()
            .is_some()
        {
            return Err(Error::Forbidden);
        }
        std::fs::remove_dir(&target).map_err(|_| Error::Forbidden)
    } else {
        std::fs::remove_file(&target).map_err(|_| Error::Forbidden)
    }
}

pub fn rename_entry(root: &Path, rel: &str, to: &str) -> Result<()> {
    if rel.is_empty() || to.is_empty() {
        return Err(Error::Forbidden);
    }
    let from = resolve_within(root, rel, false)?;
    let dest = resolve_within(root, to, false)?;
    std::fs::metadata(&from).map_err(|_| Error::NotFound)?;
    if dest.exists() {
        return Err(Error::Forbidden);
    }
    std::fs::rename(&from, &dest).map_err(|_| Error::Forbidden)
}

pub async fn workspace_summary(
    sid: String,
    root: PathBuf,
    request_id: String,
) -> Result<WorkspaceSummaryResult> {
    let checked_at = crate::database::now();
    let branch_root = root.clone();
    let branch = workspace_branch(branch_root).await.ok().flatten();
    let (size_bytes, size_complete) = tokio::task::spawn_blocking(move || workspace_size(&root))
        .await
        .map_err(|_| Error::Closed)??;
    Ok(WorkspaceSummaryResult {
        r#type: "workspace.summary.result".into(),
        sid,
        request_id,
        branch,
        size_bytes,
        size_complete,
        checked_at,
    })
}

pub fn workspace_size(root: &Path) -> Result<(Option<u64>, bool)> {
    let base = match std::fs::canonicalize(root) {
        Ok(value) => value,
        Err(_) => return Ok((None, false)),
    };
    let deadline = Instant::now() + Duration::from_millis(1500);
    let mut directories = vec![base.clone()];
    let mut seen = HashSet::new();
    let mut size = 0_u64;
    let mut count = 0_usize;
    let mut complete = true;
    while let Some(directory) = directories.pop() {
        if count >= 20_000 || Instant::now() >= deadline {
            return Ok((Some(size), false));
        }
        let actual = match std::fs::canonicalize(&directory) {
            Ok(value) => value,
            Err(_) if directory == base => return Ok((None, false)),
            Err(_) => {
                complete = false;
                continue;
            }
        };
        let info = match std::fs::symlink_metadata(&directory) {
            Ok(value) => value,
            Err(_) if directory == base => return Ok((None, false)),
            Err(_) => {
                complete = false;
                continue;
            }
        };
        if !contains(&base, &actual) || !info.is_dir() || info.file_type().is_symlink() {
            if directory == base {
                return Ok((None, false));
            }
            complete = false;
            continue;
        }
        let entries = match std::fs::read_dir(&directory) {
            Ok(value) => value,
            Err(_) if directory == base => return Ok((None, false)),
            Err(_) => {
                complete = false;
                continue;
            }
        };
        for entry in entries {
            if count >= 20_000 || Instant::now() >= deadline {
                return Ok((Some(size), false));
            }
            count += 1;
            let Ok(entry) = entry else {
                complete = false;
                continue;
            };
            let Ok(kind) = entry.file_type() else {
                complete = false;
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let full = entry.path();
            if kind.is_dir() {
                directories.push(full);
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            let Ok(meta) = std::fs::symlink_metadata(&full) else {
                complete = false;
                continue;
            };
            if !meta.is_file() {
                complete = false;
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if meta.nlink() > 1 && meta.ino() > 0 {
                    let key = (meta.dev(), meta.ino());
                    if !seen.insert(key) {
                        continue;
                    }
                }
            }
            size = size.saturating_add(meta.len());
        }
    }
    Ok((Some(size), complete))
}

async fn git(cwd: PathBuf, args: Vec<String>, tolerant: bool) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(std::env::vars().filter(|(key, _)| !key.to_ascii_uppercase().starts_with("GIT_")))
            .env("LC_ALL", "C")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| Error::Timeout)?
    .map_err(|_| Error::Invalid("git failed".into()))?;
    if !output.status.success() && (!tolerant || output.stdout.is_empty()) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.to_ascii_lowercase().contains("not a git repository") {
            return Err(Error::NotFound);
        }
        return Err(Error::Invalid(
            stderr.lines().take(3).collect::<Vec<_>>().join("\n"),
        ));
    }
    let bytes = if output.stdout.len() > MAX_GIT_OUTPUT {
        &output.stdout[..MAX_GIT_OUTPUT]
    } else {
        &output.stdout
    };
    Ok(String::from_utf8_lossy(bytes).to_string())
}

fn search_ignored(part: &str) -> bool {
    matches!(
        part,
        ".git"
            | "node_modules"
            | ".runtime"
            | "dist"
            | "out"
            | "build"
            | "target"
            | ".next"
            | ".venv"
            | "venv"
            | "__pycache__"
    )
}

fn is_word_char(ch: char) -> bool {
    ch == '_' || ch.is_alphanumeric()
}

fn line_match(line: &str, needle: &str, case_sensitive: bool, whole_word: bool) -> Option<usize> {
    let haystack = if case_sensitive {
        line.to_owned()
    } else {
        line.to_lowercase()
    };
    let mut from = 0;
    while from <= haystack.len() {
        let Some(byte_column) = haystack[from..].find(needle).map(|value| from + value) else {
            break;
        };
        let before = haystack[..byte_column].chars().next_back();
        let after = haystack[byte_column + needle.len()..].chars().next();
        if !whole_word || (!before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)) {
            return Some(haystack[..byte_column].encode_utf16().count() + 1);
        }
        from = byte_column + needle.len();
    }
    None
}

fn line_snippet(line: &str, column: usize) -> String {
    let chars = line.chars().collect::<Vec<_>>();
    let start = column.saturating_sub(101).min(chars.len());
    let end = (start + 400).min(chars.len());
    let prefix = if start > 0 { "…" } else { "" };
    format!("{prefix}{}", chars[start..end].iter().collect::<String>())
}

struct SearchContext<'a> {
    deadline: Instant,
    request: &'a ProjectSearchRequest,
    needle: &'a str,
}

fn inspect_search_file(
    root: &Path,
    rel: &str,
    needle: &str,
    case_sensitive: bool,
    whole_word: bool,
    result: &mut SearchResult,
) -> Result<()> {
    validate_desktop_rel_path(rel, false)?;
    let resolved = resolve_within(root, rel, false)?;
    let metadata = std::fs::symlink_metadata(&resolved).map_err(|_| Error::NotFound)?;
    if !metadata.is_file() || metadata.len() > MAX_EDIT_BYTES {
        result.skipped += 1;
        return Ok(());
    }
    let (content, _size, truncated, binary) = read_for_edit(root, rel)?;
    result.scanned += 1;
    if binary || truncated {
        result.skipped += 1;
        return Ok(());
    }
    let text = String::from_utf8_lossy(&content);
    for (index, line) in text.split('\n').enumerate() {
        if result.matches.len() >= 500 {
            result.truncated = true;
            return Ok(());
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(column) = line_match(line, needle, case_sensitive, whole_word) {
            result.matches.push(SearchMatch {
                path: rel.to_owned(),
                line: index + 1,
                column,
                text: line_snippet(line, column),
            });
        }
    }
    Ok(())
}

fn fallback_search_walk(
    root: &Path,
    dir: &str,
    depth: usize,
    visited: &mut usize,
    context: &SearchContext<'_>,
    result: &mut SearchResult,
) -> Result<()> {
    if depth > 30
        || *visited > 20_000
        || Instant::now() > context.deadline
        || result.scanned >= 10_000
        || result.matches.len() >= 500
    {
        result.truncated = true;
        return Ok(());
    }
    let full_dir = root.join(dir);
    let Ok(entries) = std::fs::read_dir(full_dir) else {
        result.skipped += 1;
        return Ok(());
    };
    for entry in entries {
        if Instant::now() > context.deadline
            || result.scanned >= 10_000
            || result.matches.len() >= 500
        {
            result.truncated = true;
            return Ok(());
        }
        *visited += 1;
        if *visited > 20_000 {
            result.truncated = true;
            return Ok(());
        }
        let Ok(entry) = entry else {
            result.skipped += 1;
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if search_ignored(&name) {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            result.skipped += 1;
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let rel = if dir.is_empty() {
            name
        } else {
            format!("{dir}/{name}")
        };
        if kind.is_dir() {
            fallback_search_walk(root, &rel, depth + 1, visited, context, result)?;
        } else if kind.is_file()
            && !(!context.request.path_filter.is_empty()
                && !rel.to_lowercase().contains(&context.request.path_filter))
        {
            let _ = inspect_search_file(
                root,
                &rel,
                context.needle,
                context.request.case_sensitive,
                context.request.whole_word,
                result,
            );
        }
    }
    Ok(())
}

fn search_files(
    root: &Path,
    files: Option<Vec<String>>,
    request: ProjectSearchRequest,
) -> Result<SearchResult> {
    if request.query.len() > 256
        || request.path_filter.len() > 256
        || request.query.contains('\0')
        || request.path_filter.contains('\0')
    {
        return Err(Error::Invalid("invalid search request".into()));
    }
    let mut result = SearchResult {
        matches: Vec::new(),
        scanned: 0,
        skipped: 0,
        truncated: false,
    };
    if request.query.trim().is_empty() {
        return Ok(result);
    }
    let root = std::fs::canonicalize(root).map_err(|_| Error::NotFound)?;
    let needle = if request.case_sensitive {
        request.query.clone()
    } else {
        request.query.to_lowercase()
    };
    let deadline = Instant::now() + Duration::from_millis(12_000);
    if let Some(files) = files {
        let mut seen = HashSet::new();
        for file in files {
            if Instant::now() > deadline || result.scanned >= 10_000 || result.matches.len() >= 500
            {
                result.truncated = true;
                break;
            }
            if !seen.insert(file.clone())
                || file.split('/').any(search_ignored)
                || (!request.path_filter.is_empty()
                    && !file.to_lowercase().contains(&request.path_filter))
            {
                continue;
            }
            let _ = inspect_search_file(
                &root,
                &file,
                &needle,
                request.case_sensitive,
                request.whole_word,
                &mut result,
            );
        }
    } else {
        let mut visited = 0;
        let context = SearchContext {
            deadline,
            request: &request,
            needle: &needle,
        };
        fallback_search_walk(&root, "", 0, &mut visited, &context, &mut result)?;
    }
    Ok(result)
}

pub async fn project_search(
    root: PathBuf,
    mut request: ProjectSearchRequest,
) -> Result<SearchResult> {
    request.path_filter = request.path_filter.to_lowercase();
    let files = git(
        root.clone(),
        vec![
            "ls-files".into(),
            "--cached".into(),
            "--others".into(),
            "--exclude-standard".into(),
            "-z".into(),
        ],
        false,
    )
    .await
    .ok()
    .map(|output| {
        output
            .split('\0')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    tokio::task::spawn_blocking(move || search_files(&root, files, request))
        .await
        .map_err(|_| Error::Closed)?
}

pub async fn workspace_branch(root: PathBuf) -> Result<Option<String>> {
    match git(
        root.clone(),
        vec![
            "symbolic-ref".into(),
            "--short".into(),
            "-q".into(),
            "HEAD".into(),
        ],
        false,
    )
    .await
    {
        Ok(value) => Ok((!value.trim().is_empty()).then(|| value.trim().to_owned())),
        Err(_) => match git(
            root,
            vec!["rev-parse".into(), "--short".into(), "HEAD".into()],
            false,
        )
        .await
        {
            Ok(value) => Ok(Some(format!("detached · {}", value.trim()))),
            Err(_) => Ok(None),
        },
    }
}

pub async fn git_status(sid: String, root: PathBuf) -> Result<GitStatusResult> {
    let branch;
    let mut ahead = 0_u32;
    let mut behind = 0_u32;
    match git(
        root.clone(),
        vec!["symbolic-ref".into(), "--short".into(), "HEAD".into()],
        false,
    )
    .await
    {
        Ok(value) => branch = Some(value.trim().to_owned()),
        Err(Error::NotFound) => {
            return Ok(GitStatusResult {
                r#type: "git.status.result".into(),
                sid,
                branch: None,
                ahead: 0,
                behind: 0,
                files: Vec::new(),
                staged: false,
            });
        }
        Err(_) => match git(
            root.clone(),
            vec!["rev-parse".into(), "--abbrev-ref".into(), "HEAD".into()],
            false,
        )
        .await
        {
            Ok(value) => branch = Some(value.trim().to_owned()),
            Err(Error::NotFound) => {
                return Ok(GitStatusResult {
                    r#type: "git.status.result".into(),
                    sid,
                    branch: None,
                    ahead: 0,
                    behind: 0,
                    files: Vec::new(),
                    staged: false,
                });
            }
            Err(error) => return Err(error),
        },
    }
    if let Ok(counts) = git(
        root.clone(),
        vec![
            "rev-list".into(),
            "--left-right".into(),
            "--count".into(),
            "@{upstream}...HEAD".into(),
        ],
        false,
    )
    .await
    {
        let mut parts = counts.split_whitespace();
        behind = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
        ahead = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    }
    let raw = git(
        root,
        vec![
            "status".into(),
            "--porcelain=v1".into(),
            "-z".into(),
            "--untracked-files=all".into(),
        ],
        false,
    )
    .await?;
    let parts = raw.split('\0').collect::<Vec<_>>();
    let mut files = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let entry = parts[index];
        index += 1;
        if entry.len() < 3 {
            continue;
        }
        let x = entry.chars().next().unwrap_or(' ');
        let y = entry.chars().nth(1).unwrap_or(' ');
        let original_path = if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            let original = parts
                .get(index)
                .filter(|value| !value.is_empty())
                .map(|value| (*value).to_owned());
            index += 1;
            original
        } else {
            None
        };
        files.push(GitFile {
            path: entry[3..].to_owned(),
            original_path,
            index: x.to_string(),
            worktree: y.to_string(),
            untracked: x == '?' && y == '?',
        });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let staged = files
        .iter()
        .any(|file| file.index != " " && file.index != "?");
    Ok(GitStatusResult {
        r#type: "git.status.result".into(),
        sid,
        branch,
        ahead,
        behind,
        files,
        staged,
    })
}

fn to_patch_body(raw: &str) -> String {
    let mut out = Vec::new();
    for line in raw.split('\n') {
        if line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
            || line.starts_with("new file mode")
            || line.starts_with("deleted file mode")
            || line.starts_with("old mode")
            || line.starts_with("new mode")
            || line.starts_with("similarity index")
            || line.starts_with("rename from")
            || line.starts_with("rename to")
        {
            continue;
        }
        if line.starts_with("@@") {
            if !out.is_empty() {
                out.push("@@".to_owned());
            }
            continue;
        }
        if line.starts_with("Binary files") {
            out.push(" (二进制文件,无法显示差异)".to_owned());
            continue;
        }
        if !line.is_empty() {
            out.push(line.to_owned());
        }
    }
    out.join("\n")
}

pub async fn git_diff(
    sid: String,
    root: PathBuf,
    rel: String,
    staged: bool,
) -> Result<GitDiffResult> {
    let _ = resolve_within(&root, &rel, false)?;
    let mut args = vec!["diff".into(), "--no-color".into(), "--no-ext-diff".into()];
    if staged {
        args.push("--cached".into());
    }
    args.extend(["--".into(), rel.clone()]);
    let output = git(root.clone(), args, false).await?;
    let patch = if output.trim().is_empty() && !staged {
        let untracked = git(
            root.clone(),
            vec![
                "ls-files".into(),
                "--others".into(),
                "--exclude-standard".into(),
                "-z".into(),
                "--".into(),
                rel.clone(),
            ],
            false,
        )
        .await?;
        if untracked.split('\0').any(|path| path == rel) {
            to_patch_body(
                &git(
                    root,
                    vec![
                        "diff".into(),
                        "--no-index".into(),
                        "--no-color".into(),
                        "--".into(),
                        "/dev/null".into(),
                        rel.clone(),
                    ],
                    true,
                )
                .await?,
            )
        } else {
            String::new()
        }
    } else {
        to_patch_body(&output)
    };
    Ok(GitDiffResult {
        r#type: "git.diff.result".into(),
        sid,
        path: rel,
        patch,
    })
}

pub async fn git_stage(root: PathBuf, rels: Vec<String>, unstage: bool) -> Result<()> {
    if rels.is_empty() || rels.len() > 500 {
        return Err(Error::Invalid("invalid path".into()));
    }
    for rel in &rels {
        let _ = resolve_within(&root, rel, false)?;
    }
    let mut args = if unstage {
        let has_head = git(
            root.clone(),
            vec!["rev-parse".into(), "--verify".into(), "HEAD".into()],
            false,
        )
        .await
        .is_ok();
        if has_head {
            vec!["restore".into(), "--staged".into(), "--".into()]
        } else {
            vec!["rm".into(), "--cached".into(), "--".into()]
        }
    } else {
        vec!["add".into(), "--".into()]
    };
    args.extend(rels);
    git(root, args, false).await.map(|_| ())
}

pub async fn git_discard(root: PathBuf, rel: String) -> Result<()> {
    let _ = resolve_within(&root, &rel, false)?;
    git(
        root,
        vec!["restore".into(), "--worktree".into(), "--".into(), rel],
        false,
    )
    .await
    .map(|_| ())
}

pub async fn git_history(sid: String, root: PathBuf) -> Result<GitHistoryResult> {
    if git(
        root.clone(),
        vec!["rev-parse".into(), "--verify".into(), "HEAD".into()],
        false,
    )
    .await
    .is_err()
    {
        return Ok(GitHistoryResult {
            r#type: "git.history.result".into(),
            sid,
            entries: Vec::new(),
        });
    }
    let output = git(
        root,
        vec![
            "log".into(),
            "-30".into(),
            "--format=%h%x00%s%x00%an%x00%aI%x00".into(),
        ],
        false,
    )
    .await?;
    let fields = output.split('\0').collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut index = 0;
    while index + 3 < fields.len() {
        let hash = fields[index].trim();
        let subject = fields[index + 1];
        let author = fields[index + 2];
        let date = fields[index + 3];
        if !hash.is_empty() {
            entries.push(GitHistoryEntry {
                hash: hash.into(),
                subject: subject.into(),
                author: author.into(),
                date: date.into(),
            });
        }
        index += 4;
    }
    Ok(GitHistoryResult {
        r#type: "git.history.result".into(),
        sid,
        entries,
    })
}

pub async fn git_commit(root: PathBuf, message: String) -> Result<String> {
    let message = message.trim().to_owned();
    if message.is_empty() || message.len() > 10_000 {
        return Err(Error::Invalid("invalid commit message".into()));
    }
    git(
        root.clone(),
        vec!["commit".into(), "-m".into(), message],
        false,
    )
    .await?;
    Ok(git(
        root,
        vec!["rev-parse".into(), "--short".into(), "HEAD".into()],
        false,
    )
    .await?
    .trim()
    .to_owned())
}
