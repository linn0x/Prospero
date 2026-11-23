use std::path::{Component, Path, PathBuf};

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PermissionTarget {
    /// Non-shell tool with zero or more target paths (e.g. Read, Glob, Grep, LS).
    Paths(Vec<String>),
    /// Untruncated shell command string (e.g. Claude Bash `input["command"]` or Codex string command).
    Command(String),
    /// Direct argv slice without outer shell (e.g. Codex `argv` / array `command`).
    Argv(Vec<String>),
    /// Explicit write/edit/patch/permission-elevation/unknown request.
    MutatingOrUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RiskDecision {
    AutoAllow(&'static str),
    RequireApproval(&'static str),
}

const MAX_COMMAND_BYTES: usize = 4096;
const MAX_PIPELINE_STAGES: usize = 8;

pub(super) fn classify_claude(tool: &str, input: &Value) -> PermissionTarget {
    let normalized = tool.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "bash" | "shell" | "run_command" => input
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|cmd| !cmd.is_empty())
            .map(|cmd| PermissionTarget::Command(cmd.to_owned()))
            .unwrap_or(PermissionTarget::MutatingOrUnknown),
        "read" | "glob" | "grep" | "ls" | "listdir" | "list_dir" | "notebookread" | "view"
        | "fileread" | "read_file" | "grep_search" | "find_by_name" | "view_file" => {
            let mut paths = Vec::new();
            for key in ["file_path", "path", "notebook_path", "directory", "dir"] {
                if let Some(value) = input.get(key) {
                    let Some(raw) = value.as_str() else {
                        return PermissionTarget::MutatingOrUnknown;
                    };
                    let trimmed = raw.trim();
                    if !trimmed.is_empty() {
                        paths.push(trimmed.to_owned());
                    }
                }
            }
            PermissionTarget::Paths(paths)
        }
        "todoread"
        | "todowrite"
        | "taskoutput"
        | "toolsearch"
        | "listmcpresourcestool"
        | "readmcpresourcetool"
        | "websearch" => PermissionTarget::Paths(Vec::new()),
        _ => PermissionTarget::MutatingOrUnknown,
    }
}

pub(super) fn classify_codex(method: &str, params: &Value) -> PermissionTarget {
    match method {
        "item/commandExecution/requestApproval" | "execCommandApproval" => {
            let Some(command) = params.get("command").or_else(|| params.get("argv")) else {
                return PermissionTarget::MutatingOrUnknown;
            };
            match command {
                Value::String(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        PermissionTarget::MutatingOrUnknown
                    } else {
                        PermissionTarget::Command(trimmed.to_owned())
                    }
                }
                Value::Array(items) => {
                    let mut argv = Vec::with_capacity(items.len());
                    for item in items {
                        let Some(s) = item.as_str() else {
                            return PermissionTarget::MutatingOrUnknown;
                        };
                        argv.push(s.to_owned());
                    }
                    if argv.is_empty() {
                        return PermissionTarget::MutatingOrUnknown;
                    }
                    if argv.len() == 3
                        && matches!(
                            shell_basename(&argv[0]).as_deref(),
                            Some("sh" | "bash" | "zsh")
                        )
                        && matches!(argv[1].as_str(), "-c" | "-lc")
                    {
                        PermissionTarget::Command(argv[2].clone())
                    } else {
                        PermissionTarget::Argv(argv)
                    }
                }
                _ => PermissionTarget::MutatingOrUnknown,
            }
        }
        _ => PermissionTarget::MutatingOrUnknown,
    }
}

pub(super) fn classify_opencode(action: &str, data: &Value) -> PermissionTarget {
    let normalized = action.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "bash" | "shell" | "command" => {
            if let Some(cmd) = data.get("command").and_then(Value::as_str) {
                let trimmed = cmd.trim();
                return if trimmed.is_empty() {
                    PermissionTarget::MutatingOrUnknown
                } else {
                    PermissionTarget::Command(trimmed.to_owned())
                };
            }
            if let Some(items) = data.get("resources").and_then(Value::as_array)
                && items.len() == 1
            {
                if let Some(cmd) = items[0].as_str() {
                    let trimmed = cmd.trim();
                    if !trimmed.is_empty() {
                        return PermissionTarget::Command(trimmed.to_owned());
                    }
                } else if let Some(cmd) = items[0].get("cmd").and_then(Value::as_str) {
                    let trimmed = cmd.trim();
                    if !trimmed.is_empty() {
                        return PermissionTarget::Command(trimmed.to_owned());
                    }
                }
            }
            PermissionTarget::MutatingOrUnknown
        }
        "read" | "glob" | "grep" | "list" | "ls" | "websearch" => {
            let mut paths = Vec::new();
            if let Some(resources) = data.get("resources") {
                let Some(items) = resources.as_array() else {
                    return PermissionTarget::MutatingOrUnknown;
                };
                for item in items {
                    let Some(raw) = item.as_str() else {
                        return PermissionTarget::MutatingOrUnknown;
                    };
                    let trimmed = raw.trim();
                    if !trimmed.is_empty() {
                        paths.push(trimmed.to_owned());
                    }
                }
            }
            PermissionTarget::Paths(paths)
        }
        _ => PermissionTarget::MutatingOrUnknown,
    }
}

pub(super) fn classify_deepseek(tool: &str, frame: &Value) -> PermissionTarget {
    if let Some(args) = frame.get("arguments").or_else(|| frame.get("input")) {
        if args.is_object() {
            return classify_claude(tool, args);
        }
        return PermissionTarget::MutatingOrUnknown;
    }
    let normalized = tool.trim().to_ascii_lowercase();
    if matches!(
        normalized.as_str(),
        "todoread"
            | "todowrite"
            | "taskoutput"
            | "toolsearch"
            | "listmcpresourcestool"
            | "readmcpresourcetool"
            | "websearch"
    ) {
        PermissionTarget::Paths(Vec::new())
    } else {
        PermissionTarget::MutatingOrUnknown
    }
}

pub(super) fn classify(tool: &str, target: &PermissionTarget, workspace: &str) -> RiskDecision {
    let Ok(workspace_canon) = canonical_workspace_root(workspace) else {
        return RiskDecision::RequireApproval("invalid_workspace");
    };
    match target {
        PermissionTarget::MutatingOrUnknown => RiskDecision::RequireApproval("mutating_or_unknown"),
        PermissionTarget::Paths(paths) => {
            let normalized = tool.trim().to_ascii_lowercase();
            if !is_readonly_non_shell_tool(&normalized) {
                return RiskDecision::RequireApproval("tool_not_readonly");
            }
            if paths
                .iter()
                .all(|path| is_safe_workspace_path(path, &workspace_canon, &workspace_canon))
            {
                RiskDecision::AutoAllow("readonly_tool")
            } else {
                RiskDecision::RequireApproval("sensitive_or_outside_workspace")
            }
        }
        PermissionTarget::Command(cmd) => {
            if is_safe_readonly_command(cmd, &workspace_canon) {
                RiskDecision::AutoAllow("readonly_command")
            } else {
                RiskDecision::RequireApproval("unsafe_or_mutating_command")
            }
        }
        PermissionTarget::Argv(argv) => {
            if is_safe_readonly_stage(argv, &workspace_canon, &workspace_canon) {
                RiskDecision::AutoAllow("readonly_argv")
            } else {
                RiskDecision::RequireApproval("unsafe_or_mutating_argv")
            }
        }
    }
}

fn is_readonly_non_shell_tool(normalized: &str) -> bool {
    matches!(
        normalized,
        "read"
            | "glob"
            | "grep"
            | "ls"
            | "listdir"
            | "list_dir"
            | "notebookread"
            | "view"
            | "fileread"
            | "read_file"
            | "grep_search"
            | "find_by_name"
            | "view_file"
            | "todoread"
            | "todowrite"
            | "taskoutput"
            | "toolsearch"
            | "listmcpresourcestool"
            | "readmcpresourcetool"
            | "websearch"
            | "list"
    )
}

fn canonical_workspace_root(workspace: &str) -> Result<PathBuf, ()> {
    let trimmed = workspace.trim();
    if trimmed.is_empty() {
        return Err(());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(());
    }
    if let Ok(canon) = std::fs::canonicalize(path) {
        Ok(canon)
    } else {
        Ok(lexical_normalize(path))
    }
}

fn shell_basename(executable: &str) -> Option<String> {
    let trimmed = executable.trim();
    if matches!(trimmed, "sh" | "bash" | "zsh") {
        return Some(trimmed.to_owned());
    }
    if matches!(
        trimmed,
        "/bin/sh"
            | "/bin/bash"
            | "/bin/zsh"
            | "/usr/bin/sh"
            | "/usr/bin/bash"
            | "/usr/bin/zsh"
            | "/opt/homebrew/bin/bash"
            | "/opt/homebrew/bin/zsh"
            | "/usr/local/bin/bash"
            | "/usr/local/bin/zsh"
    ) {
        Path::new(trimmed)
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
    } else {
        None
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Token {
    Word(String),
    Pipe,
    And,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuoteState {
    Unquoted,
    Single,
    Double,
}

fn tokenize_safe_posix(input: &str) -> Option<Vec<Token>> {
    let trimmed = input.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_COMMAND_BYTES {
        return None;
    }
    if trimmed
        .chars()
        .any(|c| c == '\n' || c == '\r' || c == '\0')
    {
        return None;
    }

    let chars: Vec<char> = trimmed.chars().collect();
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_token = false;
    let mut state = QuoteState::Unquoted;
    let mut i = 0;

    let flush_word = |tokens: &mut Vec<Token>, current: &mut String, in_token: &mut bool| {
        if *in_token {
            tokens.push(Token::Word(std::mem::take(current)));
            *in_token = false;
        }
    };

    while i < chars.len() {
        let ch = chars[i];
        match state {
            QuoteState::Single => {
                if ch == '\'' {
                    state = QuoteState::Unquoted;
                } else {
                    current.push(ch);
                }
                i += 1;
            }
            QuoteState::Double => {
                if ch == '"' {
                    state = QuoteState::Unquoted;
                    i += 1;
                } else if ch == '`' || ch == '$' {
                    return None;
                } else if ch == '\\' {
                    let next = *chars.get(i + 1)?;
                    if matches!(next, '$' | '`' | '"' | '\\') {
                        current.push(next);
                        i += 2;
                    } else {
                        current.push('\\');
                        current.push(next);
                        i += 2;
                    }
                } else {
                    current.push(ch);
                    i += 1;
                }
            }
            QuoteState::Unquoted => {
                if !in_token {
                    // Strip benign standalone stderr redirection tokens before starting a word.
                    let rest: String = chars[i..].iter().collect();
                    let mut stripped = false;
                    for redirect in ["2>/dev/null", "2>&1"] {
                        if let Some(after) = rest.strip_prefix(redirect)
                            && (after.is_empty()
                                || after.starts_with([' ', '\t', '|', '&']))
                        {
                            i += redirect.chars().count();
                            stripped = true;
                            break;
                        }
                    }
                    if stripped {
                        continue;
                    }
                }
                let ch = chars[i];
                if ch == ' ' || ch == '\t' {
                    flush_word(&mut tokens, &mut current, &mut in_token);
                    i += 1;
                } else if ch == '\'' {
                    state = QuoteState::Single;
                    in_token = true;
                    i += 1;
                } else if ch == '"' {
                    state = QuoteState::Double;
                    in_token = true;
                    i += 1;
                } else if ch == '\\' {
                    let next = *chars.get(i + 1)?;
                    if next == '$' || next == '`' {
                        return None;
                    }
                    in_token = true;
                    current.push(next);
                    i += 2;
                } else if ch == '|' {
                    if matches!(chars.get(i + 1), Some('|' | '&')) {
                        return None;
                    }
                    flush_word(&mut tokens, &mut current, &mut in_token);
                    tokens.push(Token::Pipe);
                    i += 1;
                } else if ch == '&' {
                    if chars.get(i + 1) == Some(&'&') {
                        flush_word(&mut tokens, &mut current, &mut in_token);
                        tokens.push(Token::And);
                        i += 2;
                    } else {
                        return None;
                    }
                } else if matches!(ch, ';' | '<' | '>' | '`' | '$' | '(' | ')' | '{' | '}') {
                    return None;
                } else {
                    in_token = true;
                    current.push(ch);
                    i += 1;
                }
            }
        }
    }

    if state != QuoteState::Unquoted {
        return None;
    }
    flush_word(&mut tokens, &mut current, &mut in_token);
    if tokens.is_empty() {
        return None;
    }
    Some(tokens)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StageSep {
    Start,
    Pipe,
    And,
}

fn is_safe_readonly_command(raw_cmd: &str, workspace: &Path) -> bool {
    is_safe_readonly_command_depth(raw_cmd, workspace, 0)
}

fn is_safe_readonly_command_depth(raw_cmd: &str, workspace: &Path, depth: u8) -> bool {
    let Some(tokens) = tokenize_safe_posix(raw_cmd) else {
        return false;
    };

    // Unwrap a single outer `sh -c '...'` / `bash -lc "..."` / `zsh -c '...'` wrapper.
    if depth == 0
        && tokens.len() == 3
        && let (Token::Word(prog), Token::Word(flag), Token::Word(inner)) =
            (&tokens[0], &tokens[1], &tokens[2])
        && shell_basename(prog).is_some()
        && matches!(flag.as_str(), "-c" | "-lc")
    {
        return is_safe_readonly_command_depth(inner, workspace, 1);
    }

    let mut stages: Vec<(StageSep, Vec<String>)> = Vec::new();
    let mut current_words: Vec<String> = Vec::new();
    let mut next_sep = StageSep::Start;

    for token in tokens {
        match token {
            Token::Word(word) => current_words.push(word),
            Token::Pipe | Token::And => {
                if current_words.is_empty() {
                    return false;
                }
                stages.push((next_sep, std::mem::take(&mut current_words)));
                next_sep = match token {
                    Token::Pipe => StageSep::Pipe,
                    Token::And => StageSep::And,
                    Token::Word(_) => unreachable!(),
                };
            }
        }
    }
    if current_words.is_empty() || stages.len() >= MAX_PIPELINE_STAGES {
        return false;
    }
    stages.push((next_sep, current_words));

    let mut current_dir = workspace.to_path_buf();
    for (sep, stage) in &stages {
        if sep == &StageSep::Pipe {
            // `cd` inside a pipeline runs in a subshell and doesn't affect sibling stages cleanly;
            // still validate with current_dir.
        }
        if stage.len() == 2 && stage[0] == "cd" {
            let target = &stage[1];
            if target == "-" || target.starts_with('-') || target.starts_with('~') {
                return false;
            }
            if !is_safe_workspace_path(target, &current_dir, workspace) {
                return false;
            }
            if sep != &StageSep::Pipe {
                current_dir = resolve_lexical_dir(&current_dir, target);
            }
            continue;
        }
        if !is_safe_readonly_stage(stage, &current_dir, workspace) {
            return false;
        }
    }
    true
}

fn resolve_lexical_dir(cwd: &Path, raw: &str) -> PathBuf {
    let candidate = if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        cwd.join(raw)
    };
    if let Ok(canon) = std::fs::canonicalize(&candidate) {
        canon
    } else {
        lexical_normalize(&candidate)
    }
}

fn normalized_command_name(program: &str) -> Option<&str> {
    if program.is_empty() || program.contains('=') {
        return None;
    }
    if !program.contains('/') {
        return Some(program);
    }
    for prefix in [
        "/bin/",
        "/usr/bin/",
        "/opt/homebrew/bin/",
        "/usr/local/bin/",
    ] {
        if let Some(rest) = program.strip_prefix(prefix)
            && !rest.is_empty()
            && !rest.contains('/')
        {
            return Some(rest);
        }
    }
    None
}

fn is_safe_readonly_stage(tokens: &[String], cwd: &Path, workspace: &Path) -> bool {
    let Some(first) = tokens.first() else {
        return false;
    };
    let Some(cmd) = normalized_command_name(first) else {
        return false;
    };
    let args = &tokens[1..];

    match cmd {
        "pwd" | "uname" | "whoami" | "id" | "hostname" | "date" | "uptime" | "true" | "false"
        | "echo" | "printf" | "tr" => {
            if matches!(cmd, "pwd" | "uname" | "whoami" | "id" | "hostname") {
                return args
                    .iter()
                    .all(|a| !a.contains('/') && !a.contains(".."));
            }
            true
        }
        "which" | "type" => {
            !args.is_empty()
                && args
                    .iter()
                    .all(|a| !a.contains('/') && !a.contains("..") && !a.starts_with('~'))
        }
        "ls" | "cat" | "wc" | "file" | "stat" | "diff" | "cmp" | "nl" | "tac" | "rev"
        | "uniq" | "comm" | "md5" | "md5sum" | "shasum" | "sha256sum" | "cksum" | "realpath"
        | "readlink" | "dirname" | "basename" => check_simple_path_args(args, cwd, workspace, true),
        "du" | "tree" => {
            // Disallow `-L` symlink following flag on recursive traversers.
            if has_flag(args, "-L") || has_flag(args, "-l") && cmd == "tree" {
                return false;
            }
            check_simple_path_args(args, cwd, workspace, true)
        }
        "df" => check_simple_path_args(args, cwd, workspace, true),
        "head" | "tail" => check_head_tail(cmd, args, cwd, workspace),
        "cut" => check_cut(args, cwd, workspace),
        "sort" => check_sort(args, cwd, workspace),
        "rg" | "grep" | "egrep" | "fgrep" | "ag" | "ack" => {
            check_grep_like(cmd, args, cwd, workspace)
        }
        "fd" | "fdfind" => check_fd(args, cwd, workspace),
        "find" => check_find(args, cwd, workspace),
        "sed" => check_sed(args, cwd, workspace),
        "jq" => check_jq(args, cwd, workspace),
        "ps" => check_ps(args),
        "git" => check_git(args, cwd, workspace),
        "node" | "npm" | "npx" | "pnpm" | "yarn" | "cargo" | "rustc" | "rustup" | "python"
        | "python3" | "go" | "java" | "javac" | "ruby" | "php" | "swift" | "clang" | "gcc"
        | "cmake" | "make" | "docker" | "kubectl" | "gh" | "claude" | "codex" => {
            args.len() == 1
                && matches!(
                    args[0].as_str(),
                    "--version" | "-v" | "-V" | "version" | "--help" | "-h"
                )
        }
        _ => false,
    }
}

fn has_flag(args: &[String], flag: &str) -> bool {
    for arg in args {
        if arg == "--" {
            break;
        }
        if arg == flag {
            return true;
        }
    }
    false
}

fn check_simple_path_args(
    args: &[String],
    cwd: &Path,
    workspace: &Path,
    allow_short_flags: bool,
) -> bool {
    let mut after_double_dash = false;
    for arg in args {
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') && arg != "-" {
            if !allow_short_flags && !arg.starts_with("--") {
                return false;
            }
            if let Some((_, val)) = arg.split_once('=')
                && looks_like_path_or_sensitive(val)
                && !is_safe_workspace_path(val, cwd, workspace)
            {
                return false;
            }
            continue;
        }
        if arg == "-" {
            continue;
        }
        if !is_safe_workspace_path(arg, cwd, workspace) {
            return false;
        }
    }
    true
}

fn is_count_value(val: &str) -> bool {
    let trimmed = val.trim_start_matches(['+', '-']);
    !trimmed.is_empty()
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'k' | b'K' | b'm' | b'M' | b'b' | b'g'))
}

fn check_head_tail(cmd: &str, args: &[String], cwd: &Path, workspace: &Path) -> bool {
    let mut after_double_dash = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            i += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') && arg != "-" {
            if cmd == "tail"
                && (arg == "-f"
                    || arg == "-F"
                    || arg == "--follow"
                    || arg.starts_with("--follow=")
                    || (arg.len() > 1 && !arg.starts_with("--") && arg[1..].contains(['f', 'F'])))
            {
                return false;
            }
            if arg == "-n" || arg == "-c" || arg == "--lines" || arg == "--bytes" {
                let Some(next) = args.get(i + 1) else {
                    return false;
                };
                if !is_count_value(next) {
                    return false;
                }
                i += 2;
                continue;
            }
            if let Some((_, val)) = arg.split_once('=') {
                if !is_count_value(val) {
                    return false;
                }
                i += 1;
                continue;
            }
            i += 1;
            continue;
        }
        if arg != "-" && !is_safe_workspace_path(arg, cwd, workspace) {
            return false;
        }
        i += 1;
    }
    true
}

fn check_cut(args: &[String], cwd: &Path, workspace: &Path) -> bool {
    let mut after_double_dash = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            i += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') && arg != "-" {
            if matches!(
                arg.as_str(),
                "-b" | "-c" | "-d" | "-f" | "--bytes" | "--characters" | "--delimiter" | "--fields"
            ) {
                if args.get(i + 1).is_none() {
                    return false;
                }
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if arg != "-" && !is_safe_workspace_path(arg, cwd, workspace) {
            return false;
        }
        i += 1;
    }
    true
}

fn check_sort(args: &[String], cwd: &Path, workspace: &Path) -> bool {
    let mut after_double_dash = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            i += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') && arg != "-" {
            if arg == "-o"
                || arg.starts_with("--output")
                || arg == "-T"
                || arg.starts_with("--temporary-directory")
                || arg.starts_with("--compress-program")
                || (arg.len() > 1 && !arg.starts_with("--") && arg[1..].contains(['o', 'T']))
            {
                return false;
            }
            if matches!(arg.as_str(), "-k" | "-t" | "-S" | "--key" | "--field-separator") {
                if args.get(i + 1).is_none() {
                    return false;
                }
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if arg != "-" && !is_safe_workspace_path(arg, cwd, workspace) {
            return false;
        }
        i += 1;
    }
    true
}

fn check_grep_like(cmd: &str, args: &[String], cwd: &Path, workspace: &Path) -> bool {
    let mut after_double_dash = false;
    let mut has_explicit_pattern = false;
    let mut seen_pattern = false;
    let mut i = 0;

    while i < args.len() {
        let arg = &args[i];
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            i += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') && arg != "-" {
            if arg == "--pre"
                || arg.starts_with("--pre=")
                || arg == "--pre-glob"
                || arg.starts_with("--pre-glob=")
                || arg == "--follow"
                || arg == "-L"
                || arg == "-R"
                || arg == "--dereference-recursive"
            {
                return false;
            }
            if cmd != "rg"
                && arg.len() > 1
                && !arg.starts_with("--")
                && arg[1..].contains(['L', 'R'])
            {
                return false;
            }
            if cmd == "rg"
                && arg.len() > 1
                && !arg.starts_with("--")
                && arg[1..].contains('L')
            {
                return false;
            }
            if arg == "-f" || arg == "--file" || arg == "--ignore-file" {
                let Some(path) = args.get(i + 1) else {
                    return false;
                };
                if path != "-" && !is_safe_workspace_path(path, cwd, workspace) {
                    return false;
                }
                if arg == "-f" || arg == "--file" {
                    has_explicit_pattern = true;
                }
                i += 2;
                continue;
            }
            if !arg.starts_with("--") && arg.len() > 2 && arg[1..].contains('f') {
                // Reject attached `-f<path>` or combined flags like `-rf<path>` unless strictly checked.
                if let Some(rest) = arg.strip_prefix("-f")
                    && is_safe_workspace_path(rest, cwd, workspace)
                {
                    has_explicit_pattern = true;
                    i += 1;
                    continue;
                }
                return false;
            }
            if !arg.starts_with("--") && arg.starts_with("-e") && arg.len() > 2 {
                has_explicit_pattern = true;
                i += 1;
                continue;
            }
            if !arg.starts_with("--") && arg.ends_with('e') {
                if args.get(i + 1).is_none() {
                    return false;
                }
                has_explicit_pattern = true;
                i += 2;
                continue;
            }
            if let Some((flag, val)) = arg.split_once('=') {
                if matches!(flag, "--file" | "--ignore-file")
                    && !is_safe_workspace_path(val, cwd, workspace)
                {
                    return false;
                }
                if flag == "--regexp" {
                    has_explicit_pattern = true;
                }
                i += 1;
                continue;
            }
            if arg == "-e" || arg == "--regexp" {
                if args.get(i + 1).is_none() {
                    return false;
                }
                has_explicit_pattern = true;
                i += 2;
                continue;
            }
            if matches!(
                arg.as_str(),
                "-A" | "-B"
                    | "-C"
                    | "-m"
                    | "-t"
                    | "-T"
                    | "-g"
                    | "-j"
                    | "-M"
                    | "-E"
                    | "--after-context"
                    | "--before-context"
                    | "--context"
                    | "--max-count"
                    | "--type"
                    | "--type-not"
                    | "--glob"
                    | "--iglob"
                    | "--max-depth"
                    | "--threads"
                    | "--max-columns"
                    | "--color"
                    | "--encoding"
                    | "--sort"
                    | "--sortr"
                    | "--engine"
                    | "--include"
                    | "--exclude"
                    | "--exclude-dir"
            ) {
                if args.get(i + 1).is_none() {
                    return false;
                }
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        // Positional argument
        if !has_explicit_pattern && !seen_pattern {
            seen_pattern = true;
            i += 1;
            continue;
        }
        if arg != "-" && !is_safe_workspace_path(arg, cwd, workspace) {
            return false;
        }
        i += 1;
    }
    true
}

fn check_fd(args: &[String], cwd: &Path, workspace: &Path) -> bool {
    let mut after_double_dash = false;
    let mut seen_pattern = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            i += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') {
            if matches!(
                arg.as_str(),
                "-x" | "--exec" | "-X" | "--exec-batch" | "-L" | "--follow"
            ) || arg.starts_with("--exec=")
                || arg.starts_with("--exec-batch=")
                || (arg.len() > 1 && !arg.starts_with("--") && arg[1..].contains(['x', 'X', 'L']))
            {
                return false;
            }
            if matches!(
                arg.as_str(),
                "-e" | "--extension"
                    | "-t"
                    | "--type"
                    | "-d"
                    | "--max-depth"
                    | "--min-depth"
                    | "-E"
                    | "--exclude"
                    | "-j"
                    | "--threads"
                    | "--base-directory"
                    | "--search-path"
            ) {
                let Some(val) = args.get(i + 1) else {
                    return false;
                };
                if matches!(arg.as_str(), "--base-directory" | "--search-path")
                    && !is_safe_workspace_path(val, cwd, workspace)
                {
                    return false;
                }
                i += 2;
                continue;
            }
            if let Some((flag, val)) = arg.split_once('=')
                && matches!(flag, "--base-directory" | "--search-path")
                && !is_safe_workspace_path(val, cwd, workspace)
            {
                return false;
            }
            i += 1;
            continue;
        }
        if !seen_pattern {
            seen_pattern = true;
            i += 1;
            continue;
        }
        if !is_safe_workspace_path(arg, cwd, workspace) {
            return false;
        }
        i += 1;
    }
    true
}

fn check_find(args: &[String], cwd: &Path, workspace: &Path) -> bool {
    let mut in_paths = true;
    for arg in args {
        if matches!(
            arg.as_str(),
            "-exec"
                | "-execdir"
                | "-ok"
                | "-okdir"
                | "-delete"
                | "-fprint"
                | "-fprint0"
                | "-fprintf"
                | "-fls"
                | "-L"
                | "-H"
                | "-follow"
        ) {
            return false;
        }
        if in_paths {
            if arg.starts_with('-') || arg == "!" || arg == "(" || arg == ")" {
                in_paths = false;
                continue;
            }
            if !is_safe_workspace_path(arg, cwd, workspace) {
                return false;
            }
        }
    }
    true
}

fn check_sed(args: &[String], cwd: &Path, workspace: &Path) -> bool {
    let mut quiet = false;
    let mut script: Option<&str> = None;
    let mut files: Vec<&str> = Vec::new();
    let mut i = 0;

    while i < args.len() {
        let arg = &args[i];
        if arg.starts_with('-') && arg != "-" {
            if arg == "--in-place"
                || arg.starts_with("--in-place=")
                || arg == "--file"
                || arg.starts_with("--file=")
                || (arg.len() > 1 && !arg.starts_with("--") && arg[1..].contains(['i', 'f']))
            {
                return false;
            }
            if arg == "-n"
                || arg == "--quiet"
                || arg == "--silent"
                || (arg.len() > 1 && !arg.starts_with("--") && arg[1..].chars().all(|c| c == 'n'))
            {
                quiet = true;
                i += 1;
                continue;
            }
            if arg == "-e" || arg == "--expression" {
                let Some(expr) = args.get(i + 1) else {
                    return false;
                };
                if script.is_some() {
                    return false;
                }
                script = Some(expr.as_str());
                i += 2;
                continue;
            }
            return false;
        }
        if script.is_none() {
            script = Some(arg.as_str());
        } else {
            files.push(arg.as_str());
        }
        i += 1;
    }

    let Some(expr) = script else {
        return false;
    };
    if !quiet || files.is_empty() || !is_simple_sed_print_expr(expr) {
        return false;
    }
    files
        .into_iter()
        .all(|file| is_safe_workspace_path(file, cwd, workspace))
}

fn is_simple_sed_print_expr(expr: &str) -> bool {
    let Some(addr) = expr.strip_suffix('p') else {
        return false;
    };
    !addr.is_empty() && addr.bytes().all(|b| b.is_ascii_digit() || b == b',' || b == b'$')
}

fn check_jq(args: &[String], cwd: &Path, workspace: &Path) -> bool {
    let mut after_double_dash = false;
    let mut seen_filter = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            i += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') && arg != "-" {
            if matches!(
                arg.as_str(),
                "--argfile" | "--rawfile" | "--slurpfile" | "-f" | "--from-file"
            ) || arg.starts_with("--argfile=")
                || arg.starts_with("--rawfile=")
                || arg.starts_with("--slurpfile=")
                || arg.starts_with("--from-file=")
                || (arg.len() > 1 && !arg.starts_with("--") && arg[1..].contains('f'))
            {
                return false;
            }
            if matches!(arg.as_str(), "--arg" | "--argjson") {
                if args.get(i + 2).is_none() {
                    return false;
                }
                i += 3;
                continue;
            }
            i += 1;
            continue;
        }
        if !seen_filter {
            seen_filter = true;
            i += 1;
            continue;
        }
        if arg != "-" && !is_safe_workspace_path(arg, cwd, workspace) {
            return false;
        }
        i += 1;
    }
    true
}

fn check_ps(args: &[String]) -> bool {
    for arg in args {
        if arg.contains('/') || arg.contains("..") {
            return false;
        }
        // Reject BSD `e` / `E` env-dump flags (e.g. `ps eww`, `ps -eww`, `ps auxe`), while allowing `-e`/`-ef`? Wait: on macOS `-e` selects all processes, while `-E` or trailing `e` prints env! Keeping `-e` only if exact `-e`/`-ef`? Safest: allow standard forms and block `E` or standalone/combined BSD `e` except exact `-e`/`-ef`!
        if arg == "-E" || arg.contains('E') {
            return false;
        }
        if !arg.starts_with('-') && arg.contains('e') {
            return false;
        }
        if arg.starts_with('-') && !arg.starts_with("--") && arg != "-e" && arg != "-ef" && arg[1..].contains('e') {
            return false;
        }
    }
    true
}

fn check_git(args: &[String], cwd: &Path, workspace: &Path) -> bool {
    let mut current_dir = cwd.to_path_buf();
    let mut i = 0;

    // Parse only explicitly safe global flags before the subcommand.
    while i < args.len() {
        let arg = &args[i];
        if matches!(
            arg.as_str(),
            "--no-pager" | "-P" | "--no-optional-locks" | "--literal-pathspecs"
        ) {
            i += 1;
        } else if arg == "-C" {
            let Some(dir) = args.get(i + 1) else {
                return false;
            };
            if !is_safe_workspace_path(dir, &current_dir, workspace) {
                return false;
            }
            current_dir = resolve_lexical_dir(&current_dir, dir);
            i += 2;
        } else if arg == "--version" || arg == "-v" || arg == "version" || arg == "help" {
            return i + 1 == args.len()
                || (arg == "help" && args.len() == i + 2 && !args[i + 1].contains('/'));
        } else if arg.starts_with('-') {
            // Reject `-c`, `--git-dir`, `--work-tree`, `--exec-path`, `--upload-pack`, etc.
            return false;
        } else {
            break;
        }
    }

    let Some(subcmd) = args.get(i) else {
        return false;
    };
    let rest = &args[i + 1..];

    match subcmd.as_str() {
        "status" | "diff" | "log" | "show" | "blame" | "shortlog" | "describe" | "rev-parse"
        | "rev-list" | "ls-files" | "ls-tree" | "cat-file" | "merge-base" | "name-rev"
        | "count-objects" | "grep" | "diff-tree" | "diff-index" | "diff-files"
        | "for-each-ref" | "show-ref" => check_git_readonly_args(subcmd, rest, &current_dir, workspace),
        "symbolic-ref" => {
            let mut count = 0;
            for arg in rest {
                if matches!(arg.as_str(), "-d" | "--delete") || arg.starts_with("--output") {
                    return false;
                }
                if !arg.starts_with('-') {
                    count += 1;
                }
            }
            count <= 1
        }
        "branch" => {
            let mut explicit_list = false;
            let mut positionals = 0;
            let mut after_double_dash = false;
            for arg in rest {
                if !after_double_dash && arg == "--" {
                    after_double_dash = true;
                    continue;
                }
                if !after_double_dash && arg.starts_with('-') {
                    if arg == "--list" || arg == "-l" {
                        explicit_list = true;
                        continue;
                    }
                    if matches!(
                        arg.as_str(),
                        "-a" | "--all"
                            | "-r"
                            | "--remotes"
                            | "-v"
                            | "-vv"
                            | "--verbose"
                            | "--show-current"
                            | "--no-color"
                            | "--color"
                            | "--abbrev"
                            | "--no-abbrev"
                    ) || arg.starts_with("--sort=")
                        || arg.starts_with("--format=")
                        || arg.starts_with("--color=")
                        || arg.starts_with("--abbrev=")
                        || arg == "--contains"
                        || arg == "--no-contains"
                        || arg == "--merged"
                        || arg == "--no-merged"
                        || arg == "--points-at"
                    {
                        continue;
                    }
                    return false;
                }
                positionals += 1;
            }
            positionals == 0 || explicit_list
        }
        "tag" => {
            let mut after_double_dash = false;
            let mut positionals = 0;
            let mut explicit_list = false;
            for arg in rest {
                if !after_double_dash && arg == "--" {
                    after_double_dash = true;
                    continue;
                }
                if !after_double_dash && arg.starts_with('-') {
                    if arg == "-l" || arg == "--list" {
                        explicit_list = true;
                        continue;
                    }
                    if matches!(
                        arg.as_str(),
                        "--sort"
                            | "--contains"
                            | "--no-contains"
                            | "--merged"
                            | "--no-merged"
                            | "--points-at"
                    ) || arg.starts_with("--sort=")
                        || arg.starts_with("--format=")
                        || arg.starts_with("-n")
                    {
                        continue;
                    }
                    return false;
                }
                positionals += 1;
            }
            positionals == 0 || explicit_list
        }
        "remote" => {
            rest.is_empty()
                || (rest.len() == 1 && matches!(rest[0].as_str(), "-v" | "--verbose" | "show"))
                || (rest.len() == 2
                    && matches!(rest[0].as_str(), "show" | "get-url")
                    && !rest[1].starts_with('-'))
        }
        "stash" => rest
            .first()
            .is_some_and(|first| matches!(first.as_str(), "list" | "show"))
            && check_git_readonly_args("stash", &rest[1..], &current_dir, workspace),
        _ => false,
    }
}

fn check_git_readonly_args(
    subcmd: &str,
    args: &[String],
    cwd: &Path,
    workspace: &Path,
) -> bool {
    let mut after_double_dash = false;
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if !after_double_dash && arg == "--" {
            after_double_dash = true;
            i += 1;
            continue;
        }
        if !after_double_dash && arg.starts_with('-') {
            if matches!(
                arg.as_str(),
                "--no-index" | "--ext-diff" | "--open-files-in-pager"
            ) || arg == "-o"
                || arg == "--output"
                || arg.starts_with("--output=")
            {
                return false;
            }
            if subcmd == "grep" && (arg == "-f" || arg == "--file") {
                let Some(path) = args.get(i + 1) else {
                    return false;
                };
                if !is_safe_workspace_path(path, cwd, workspace) {
                    return false;
                }
                i += 2;
                continue;
            }
            if let Some((_, val)) = arg.split_once('=')
                && looks_like_path_or_sensitive(val)
                && !is_safe_workspace_path(val, cwd, workspace)
            {
                return false;
            }
            i += 1;
            continue;
        }
        if let Some((_, obj_path)) = arg.split_once(':')
            && !obj_path.is_empty()
            && !is_safe_workspace_path(obj_path, cwd, workspace)
        {
            return false;
        }
        if after_double_dash || looks_like_path_or_sensitive(arg) {
            if !is_safe_workspace_path(arg, cwd, workspace) {
                return false;
            }
        }
        i += 1;
    }
    true
}

fn looks_like_path_or_sensitive(raw: &str) -> bool {
    raw.contains('/')
        || raw.starts_with('.')
        || raw.starts_with('~')
        || is_sensitive_path(Path::new(raw))
}

fn is_safe_workspace_path(raw: &str, cwd: &Path, workspace: &Path) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed == "/dev/null" {
        return true;
    }
    if trimmed.starts_with('~') {
        return false;
    }
    if is_sensitive_path(Path::new(trimmed)) {
        return false;
    }
    let joined = if Path::new(trimmed).is_absolute() {
        PathBuf::from(trimmed)
    } else {
        cwd.join(trimmed)
    };
    let lexical = lexical_normalize(&joined);
    if !lexical.starts_with(workspace) || is_sensitive_path(&lexical) {
        return false;
    }
    if let Some(canon) = canonicalize_existing_prefix(&joined) {
        if !canon.starts_with(workspace) || is_sensitive_path(&canon) {
            return false;
        }
    }
    true
}

fn canonicalize_existing_prefix(path: &Path) -> Option<PathBuf> {
    if let Ok(canon) = std::fs::canonicalize(path) {
        return Some(canon);
    }
    let mut ancestor = path.parent();
    while let Some(dir) = ancestor {
        if let Ok(canon) = std::fs::canonicalize(dir) {
            return Some(canon);
        }
        ancestor = dir.parent();
    }
    None
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

fn is_sensitive_path(path: &Path) -> bool {
    let raw_lower = path.to_string_lossy().to_ascii_lowercase();
    if raw_lower.contains("prospero rust")
        || raw_lower.contains("application support/prospero")
        || matches!(
            raw_lower.as_str(),
            "/etc/shadow" | "/etc/gshadow" | "/etc/sudoers" | "/etc/master.passwd"
        )
    {
        return true;
    }

    for component in path.components() {
        let Component::Normal(segment) = component else {
            continue;
        };
        let lower = segment.to_string_lossy().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            ".ssh"
                | ".aws"
                | ".gnupg"
                | ".kube"
                | ".gcp"
                | ".azure"
                | "keychains"
                | ".password-store"
                | ".1password"
                | ".netrc"
                | ".npmrc"
                | ".pypirc"
                | ".pgpass"
                | ".my.cnf"
                | ".git-credentials"
                | "auth.json"
                | "credentials"
                | "credentials.json"
                | "secrets.yaml"
                | "secrets.yml"
                | "secrets.json"
                | "secrets.toml"
                | ".secrets"
                | "master.key"
                | "id_rsa"
                | "id_ed25519"
                | "id_ecdsa"
                | "id_dsa"
                | "control.token"
                | "local.token"
                | "connection.json"
                | "prospero.sqlite"
                | "prospero.sqlite-wal"
                | "prospero.sqlite-shm"
                | "bots.json"
                | "secrets.key"
        ) {
            return true;
        }
        if (lower == ".env" || lower.starts_with(".env."))
            && !matches!(
                lower.as_str(),
                ".env.example" | ".env.sample" | ".env.template" | ".env.dist"
            )
        {
            return true;
        }
    }

    if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
        let ext_lower = ext.to_ascii_lowercase();
        if matches!(
            ext_lower.as_str(),
            "pem" | "key" | "p12" | "pfx" | "jks" | "keystore"
        ) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn temp_workspace() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("apps/web")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        let workspace = std::fs::canonicalize(dir.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        (dir, workspace)
    }

    #[test]
    fn claude_readonly_and_mutating_tools_classify_correctly() {
        let (_dir, ws) = temp_workspace();
        let read_target = classify_claude("Read", &json!({ "file_path": "src/main.rs" }));
        assert!(matches!(
            classify("Read", &read_target, &ws),
            RiskDecision::AutoAllow(_)
        ));

        let glob_target = classify_claude("Glob", &json!({ "path": ws.clone(), "pattern": "**/*.rs" }));
        assert!(matches!(
            classify("Glob", &glob_target, &ws),
            RiskDecision::AutoAllow(_)
        ));

        let edit_target = classify_claude("Edit", &json!({ "file_path": "src/main.rs" }));
        assert!(matches!(
            classify("Edit", &edit_target, &ws),
            RiskDecision::RequireApproval(_)
        ));

        let write_target = classify_claude("Write", &json!({ "file_path": "src/main.rs" }));
        assert!(matches!(
            classify("Write", &write_target, &ws),
            RiskDecision::RequireApproval(_)
        ));

        let fetch_target = classify_claude("WebFetch", &json!({ "url": "https://example.com" }));
        assert!(matches!(
            classify("WebFetch", &fetch_target, &ws),
            RiskDecision::RequireApproval(_)
        ));
    }

    #[test]
    fn sensitive_and_outside_workspace_paths_require_approval() {
        let (_dir, ws) = temp_workspace();
        for path in [
            ".env",
            ".env.local",
            "config/secrets.json",
            "certs/server.pem",
            "id_rsa",
            "../other/file.rs",
            "/etc/passwd",
            "~/.ssh/id_rsa",
        ] {
            let target = classify_claude("Read", &json!({ "file_path": path }));
            assert!(
                matches!(classify("Read", &target, &ws), RiskDecision::RequireApproval(_)),
                "expected RequireApproval for {path}"
            );
        }

        let env_example = classify_claude("Read", &json!({ "file_path": ".env.example" }));
        assert!(matches!(
            classify("Read", &env_example, &ws),
            RiskDecision::AutoAllow(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escaping_workspace_requires_approval() {
        let (ws_dir, ws) = temp_workspace();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("secret.txt");
        std::fs::write(&outside_file, "secret").unwrap();
        let link = ws_dir.path().join("src/escape.txt");
        std::os::unix::fs::symlink(&outside_file, &link).unwrap();

        let read_target = classify_claude("Read", &json!({ "file_path": "src/escape.txt" }));
        assert!(matches!(
            classify("Read", &read_target, &ws),
            RiskDecision::RequireApproval(_)
        ));

        let cat_target = classify_claude("Bash", &json!({ "command": "cat src/escape.txt" }));
        assert!(matches!(
            classify("Bash", &cat_target, &ws),
            RiskDecision::RequireApproval(_)
        ));
    }

    #[test]
    fn safe_readonly_shell_commands_and_pipes_auto_allow() {
        let (_dir, ws) = temp_workspace();
        for cmd in [
            "ls -la",
            "cat src/main.rs",
            "head -n 50 src/main.rs",
            "tail -n 20 src/main.rs",
            "rg '/v1/health' src",
            "rg '$HOME' src/main.rs",
            "cd apps/web && git status | head -n 20",
            "sed -n '1,50p' src/main.rs",
            "find src -maxdepth 2 -name '*.rs'",
            "git log --oneline -n 10",
            "git diff HEAD~1 -- src/main.rs",
            "git status 2>/dev/null | head -n 5",
            "node --version",
            "cargo --version",
            "sh -c 'git status | head -n 10'",
            "/bin/zsh -lc \"ls -la src\"",
        ] {
            let target = classify_claude("Bash", &json!({ "command": cmd }));
            assert!(
                matches!(classify("Bash", &target, &ws), RiskDecision::AutoAllow(_)),
                "expected AutoAllow for safe command: {cmd}"
            );
        }
    }

    #[test]
    fn dangerous_shell_injections_and_mutations_require_approval() {
        let (_dir, ws) = temp_workspace();
        for cmd in [
            "rm -rf src",
            "mv src/main.rs src/old.rs",
            "touch src/new.rs",
            "mkdir -p tmp",
            "curl https://example.com",
            "python3 -c 'print(1)'",
            "ls; rm -rf /",
            "ls && rm src/main.rs",
            "ls || echo fallback",
            "cat $(whoami)",
            "echo `id`",
            "cat \"$HOME/.ssh/id_rsa\"",
            "cat src/main.rs > out.txt",
            "cat .env",
            "cat /etc/passwd",
            "cat ../outside.rs",
            "sed -i 's/a/b/' src/main.rs",
            "find src -delete",
            "find src -exec rm {} +",
            "rg --pre cat foo src",
            "tail -f src/main.rs",
            "sort -o src/main.rs src/main.rs",
            "git push origin main",
            "git commit -m 'msg'",
            "git checkout -- src/main.rs",
            "git branch -D feature",
            "git -c diff.external=cat diff",
            "git diff --no-index /etc/passwd /dev/null",
            "git show HEAD:.env",
            "LD_PRELOAD=/tmp/x.so ls",
            "cargo test",
            "npm install",
            "bash -c 'ls; id'",
        ] {
            let target = classify_claude("Bash", &json!({ "command": cmd }));
            assert!(
                matches!(
                    classify("Bash", &target, &ws),
                    RiskDecision::RequireApproval(_)
                ),
                "expected RequireApproval for dangerous command: {cmd}"
            );
        }
    }

    #[test]
    fn codex_and_opencode_extractors_enforce_tiering() {
        let (_dir, ws) = temp_workspace();
        let codex_safe = classify_codex(
            "item/commandExecution/requestApproval",
            &json!({ "command": ["/bin/zsh", "-lc", "git status | head -n 5"] }),
        );
        assert!(matches!(
            classify("commandExecution", &codex_safe, &ws),
            RiskDecision::AutoAllow(_)
        ));

        let codex_argv = classify_codex(
            "item/commandExecution/requestApproval",
            &json!({ "argv": ["rg", "main", "src"] }),
        );
        assert!(matches!(
            classify("commandExecution", &codex_argv, &ws),
            RiskDecision::AutoAllow(_)
        ));

        let codex_file_change = classify_codex(
            "item/fileChange/requestApproval",
            &json!({ "changes": { "src/main.rs": {} } }),
        );
        assert!(matches!(
            classify("fileChange", &codex_file_change, &ws),
            RiskDecision::RequireApproval(_)
        ));

        let oc_read = classify_opencode("read", &json!({ "resources": ["src/main.rs"] }));
        assert!(matches!(
            classify("read", &oc_read, &ws),
            RiskDecision::AutoAllow(_)
        ));

        let oc_edit = classify_opencode("edit", &json!({ "resources": ["src/main.rs"] }));
        assert!(matches!(
            classify("edit", &oc_edit, &ws),
            RiskDecision::RequireApproval(_)
        ));
    }
}
