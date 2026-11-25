//! Direct Antigravity (`agy`) CLI driver.
//!
//! Runs `agy -p <prompt> --output-format stream-json` per turn using the local
//! Antigravity subscription session (`~/.gemini/antigravity-cli` / Keychain).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::claude::{AdapterEvent, TurnOptions};
use super::lifecycle::{ChildGuard, ProcessLifecycle, Quiescence, await_child_exit};
use super::store::PermissionMode;
use super::turn_stream::TurnStreamStateMachine;
use super::{LaunchModelCatalog, LaunchModelInfo};
use crate::error::{Error, Result};
use crate::orchestration::reliability::ControlEffectState;

const CATALOG_CACHE_TTL: Duration = Duration::from_secs(600);
const CATALOG_CMD_TIMEOUT: Duration = Duration::from_secs(20);
const COLD_CATALOG_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const NEGATIVE_REFRESH_COOLDOWN: Duration = Duration::from_secs(30);

pub(crate) fn binary() -> String {
    if let Ok(explicit) = std::env::var("PROSPERO_AGY_BIN") {
        let trimmed = explicit.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let candidate = home.join(".local/bin/agy");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "agy".to_owned()
}

const KNOWN_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

pub(crate) fn split_model_effort_suffix(model_id: &str) -> (&str, Option<&str>) {
    let trimmed = model_id.trim();
    for &effort in KNOWN_EFFORTS {
        if let Some(base) = trimmed.strip_suffix(&format!("-{effort}"))
            && !base.is_empty()
        {
            return (base, Some(effort));
        }
    }
    (trimmed, None)
}

fn strip_label_effort_suffix(label: &str) -> String {
    let trimmed = label.trim();
    for suffix in [" (Low)", " (Medium)", " (High)", " (XHigh)", " (Max)"] {
        if let Some(base) = trimmed.strip_suffix(suffix) {
            return base.trim().to_owned();
        }
    }
    trimmed.to_owned()
}

fn effort_rank(raw: &str) -> Option<u8> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "none" | "minimal" | "low" => Some(0),
        "medium" => Some(1),
        "high" => Some(2),
        "xhigh" => Some(3),
        "max" | "ultra" => Some(4),
        _ => None,
    }
}

fn agy_effort_label(effort: &str) -> &'static str {
    match effort.trim().to_ascii_lowercase().as_str() {
        "low" => "Low",
        "medium" => "Medium",
        "high" => "High",
        "xhigh" => "XHigh",
        "max" => "Max",
        _ => "Medium",
    }
}

const ORCHESTRATOR_PLANNERS: &[(&str, &str, &str)] = &[
    (
        "gemini-pro-orchestrator-neon",
        "gemini-4-neon",
        "Gemini 4 Neon",
    ),
    (
        "gemini-pro-orchestrator",
        "gemini-4-carbon",
        "Gemini 4 Carbon",
    ),
    (
        "gemini-pro-orchestrator-argon",
        "gemini-4-argon",
        "Gemini 4 Argon",
    ),
    (
        "gemini-pro-orchestrator-claude-opus-5-5",
        "claude-opus-5-5",
        "Claude Opus 5.5",
    ),
];

fn orchestrator_planner_spec(id: &str) -> Option<(&'static str, &'static str)> {
    ORCHESTRATOR_PLANNERS
        .iter()
        .find(|(orch_id, _, _)| *orch_id == id)
        .map(|(_, planner_base, fallback_label)| (*planner_base, *fallback_label))
}

fn is_builtin_orchestrator_cli_slug(id: &str) -> bool {
    matches!(
        id,
        "gemini-pro-orchestrator"
            | "gemini-pro-orchestrator-neon"
            | "gemini-pro-orchestrator-argon"
    ) || (id.starts_with("gemini-pro-orchestrator-")
        && id != "gemini-pro-orchestrator-claude-opus-5-5")
}

fn default_effort_for_base(base_id: &str, supported: &[String]) -> String {
    let preferred = if base_id == "gemini-pro-orchestrator-neon" {
        "high"
    } else {
        "medium"
    };
    if supported.iter().any(|item| item == preferred) {
        return preferred.to_owned();
    }
    if supported.iter().any(|item| item == "medium") {
        return "medium".to_owned();
    }
    supported
        .first()
        .cloned()
        .unwrap_or_else(|| preferred.to_owned())
}

fn clamp_effort_to_supported(
    base_id: &str,
    effort: &str,
    supported: &[String],
    default_effort: Option<&str>,
) -> String {
    if supported.is_empty() {
        return default_effort.unwrap_or("medium").to_owned();
    }
    if let Some(target_rank) = effort_rank(effort) {
        if let Some(exact) = supported
            .iter()
            .find(|item| effort_rank(item) == Some(target_rank))
        {
            return exact.clone();
        }
        if let Some(at_or_below) = supported
            .iter()
            .filter_map(|item| {
                effort_rank(item)
                    .filter(|&rank| rank <= target_rank)
                    .map(|rank| (rank, item))
            })
            .max_by_key(|(rank, _)| *rank)
            .map(|(_, item)| item)
        {
            return at_or_below.clone();
        }
        if let Some(above) = supported
            .iter()
            .filter_map(|item| effort_rank(item).map(|rank| (rank, item)))
            .min_by_key(|(rank, _)| *rank)
            .map(|(_, item)| item)
        {
            return above.clone();
        }
    }
    default_effort
        .filter(|d| supported.iter().any(|item| item == *d))
        .map(str::to_owned)
        .unwrap_or_else(|| default_effort_for_base(base_id, supported))
}

fn slugify_token(text: &str) -> String {
    let mut slug = String::with_capacity(text.len());
    let mut prev_dash = false;
    for ch in text.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.') {
            slug.push(ch);
            prev_dash = false;
        } else if (ch == '-'
            || ch.is_whitespace()
            || matches!(ch, '·' | '/' | ':' | '(' | ')'))
            && !prev_dash
            && !slug.is_empty()
        {
            slug.push('-');
            prev_dash = true;
        }
    }
    slug.trim_end_matches('-').to_owned()
}

fn strip_ansi_and_spinner(line: &str) -> String {
    let segment = line.rsplit('\r').next().unwrap_or(line);
    let mut clean = String::with_capacity(segment.len());
    let mut chars = segment.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if matches!(chars.peek(), Some('[')) {
                chars.next();
                for seq in chars.by_ref() {
                    if ('@'..='~').contains(&seq) {
                        break;
                    }
                }
            }
            continue;
        }
        clean.push(ch);
    }
    clean
}

fn normalize_model_alias(raw_model: &str) -> String {
    let mut text = raw_model.trim().to_ascii_lowercase();
    if let Some(stripped) = text.strip_prefix("antigravity/") {
        text = stripped.trim().to_owned();
    } else if let Some(stripped) = text.strip_prefix("agy/") {
        text = stripped.trim().to_owned();
    }
    let mut trailing_paren_effort = None;
    for effort in KNOWN_EFFORTS {
        let paren = format!("({effort})");
        if let Some(prefix) = text.strip_suffix(&paren) {
            text = prefix.trim().to_owned();
            trailing_paren_effort = Some(*effort);
            break;
        }
    }
    let slug = slugify_token(&text);
    let (raw_base, suffix_effort) = split_model_effort_suffix(&slug);
    let canonical_base = match raw_base {
        "neon" | "neon-4" | "gemini-neon" | "gemini-neon-4" => "gemini-4-neon",
        "argon-4" | "argon" | "gemini-argon-4" => "gemini-4-argon",
        "carbon-4" | "carbon" | "gemini-carbon-4" => "gemini-4-carbon",
        "hydrogen" | "gemini-hydrogen" | "gemini-hydrogen-4" | "hydrogen-4" => "gemini-4-hydrogen",
        "orchestrator"
        | "orchestrator-carbon"
        | "orchestrator-gemini-4-carbon"
        | "gemini-pro-orchestrator-carbon" => "gemini-pro-orchestrator",
        "orchestrator-argon" | "orchestrator-gemini-4-argon" => "gemini-pro-orchestrator-argon",
        "orchestrator-neon" | "orchestrator-gemini-4-neon" => "gemini-pro-orchestrator-neon",
        "orchestrator-claude-opus-5.5"
        | "orchestrator-claude-opus-5-5"
        | "orchestrator-opus"
        | "orchestrator-opus-5.5"
        | "orchestrator-opus-5-5"
        | "gemini-pro-orchestrator-claude-opus-5.5"
        | "gemini-pro-orchestrator-opus" => "gemini-pro-orchestrator-claude-opus-5-5",
        "claude-opus-5.5" => "claude-opus-5-5",
        "claude-sonnet-5.5" => "claude-sonnet-5-5",
        other => other,
    };
    match suffix_effort.or(trailing_paren_effort) {
        Some(effort) => format!("{canonical_base}-{effort}"),
        None => canonical_base.to_owned(),
    }
}

fn find_catalog_entry<'a>(
    normalized: &str,
    base_id: &str,
    catalog: &'a [LaunchModelInfo],
) -> Option<&'a LaunchModelInfo> {
    catalog
        .iter()
        .find(|entry| entry.id == normalized)
        .or_else(|| catalog.iter().find(|entry| entry.id == base_id))
        .or_else(|| {
            catalog.iter().find(|entry| {
                let label_slug = slugify_token(&entry.label);
                label_slug == normalized || label_slug == base_id
            })
        })
}

pub(crate) fn resolve_cli_model_and_effort_with_catalog(
    model: Option<&str>,
    effort: Option<&str>,
    catalog: &[LaunchModelInfo],
) -> (Option<String>, Option<String>, Vec<String>) {
    resolve_cli_model_and_effort_with_catalog_match(model, effort, catalog).1
}

fn resolve_cli_model_and_effort_with_catalog_match(
    model: Option<&str>,
    effort: Option<&str>,
    catalog: &[LaunchModelInfo],
) -> (bool, (Option<String>, Option<String>, Vec<String>)) {
    let clean_model = model.map(str::trim).filter(|s| !s.is_empty());
    let clean_effort = effort.map(str::trim).filter(|s| !s.is_empty());

    let Some(raw_model) = clean_model else {
        if let Some(raw_effort) = clean_effort {
            let clamped = clamp_effort_to_supported(
                "gemini-4-neon",
                raw_effort,
                &[
                    "low".to_owned(),
                    "medium".to_owned(),
                    "high".to_owned(),
                    "xhigh".to_owned(),
                ],
                Some("medium"),
            );
            return (
                true,
                (
                    None,
                    Some(clamped.clone()),
                    vec!["--effort".into(), clamped],
                ),
            );
        }
        return (true, (None, None, Vec::new()));
    };

    let normalized_model = normalize_model_alias(raw_model);
    let (base_id, embedded_effort) = split_model_effort_suffix(&normalized_model);
    if let Some(entry) = find_catalog_entry(&normalized_model, base_id, catalog) {
        if entry.id.starts_with("gemini-pro-orchestrator") {
            if !entry.supported_efforts.is_empty()
                && let Some((planner_base, fallback_planner_label)) =
                    orchestrator_planner_spec(&entry.id)
            {
                let effective_effort = match clean_effort.or(embedded_effort) {
                    Some(chosen) => clamp_effort_to_supported(
                        &entry.id,
                        chosen,
                        &entry.supported_efforts,
                        entry.default_effort.as_deref(),
                    ),
                    None => entry
                        .default_effort
                        .clone()
                        .filter(|d| entry.supported_efforts.iter().any(|s| s == d))
                        .unwrap_or_else(|| {
                            default_effort_for_base(&entry.id, &entry.supported_efforts)
                        }),
                };
                let planner_display_base = catalog
                    .iter()
                    .find(|candidate| candidate.id == planner_base)
                    .map(|candidate| candidate.label.as_str())
                    .unwrap_or(fallback_planner_label);
                let planner_label = format!(
                    "{planner_display_base} ({})",
                    agy_effort_label(&effective_effort)
                );
                let cli_slug = if is_builtin_orchestrator_cli_slug(&entry.id) {
                    entry.id.clone()
                } else {
                    catalog
                        .iter()
                        .find(|candidate| candidate.id == "gemini-pro-orchestrator-neon")
                        .or_else(|| {
                            catalog
                                .iter()
                                .find(|candidate| candidate.id == "gemini-pro-orchestrator")
                        })
                        .or_else(|| {
                            catalog
                                .iter()
                                .find(|candidate| is_builtin_orchestrator_cli_slug(&candidate.id))
                        })
                        .map(|candidate| candidate.id.clone())
                        .unwrap_or_else(|| "gemini-pro-orchestrator".to_owned())
                };
                let settings = serde_json::json!({
                    "orchestrator": { "planner": planner_label }
                })
                .to_string();
                return (
                    true,
                    (
                        Some(entry.id.clone()),
                        Some(effective_effort),
                        vec!["--model".into(), cli_slug, "--settings".into(), settings],
                    ),
                );
            }
            return (
                true,
                (
                    Some(entry.id.clone()),
                    None,
                    vec!["--model".into(), entry.id.clone()],
                ),
            );
        }
        if !entry.supported_efforts.is_empty() {
            let effective_effort = match clean_effort.or(embedded_effort) {
                Some(chosen) => clamp_effort_to_supported(
                    &entry.id,
                    chosen,
                    &entry.supported_efforts,
                    entry.default_effort.as_deref(),
                ),
                None => entry
                    .default_effort
                    .clone()
                    .filter(|d| entry.supported_efforts.iter().any(|s| s == d))
                    .unwrap_or_else(|| {
                        default_effort_for_base(&entry.id, &entry.supported_efforts)
                    }),
            };
            let concrete_slug = format!("{}-{effective_effort}", entry.id);
            return (
                true,
                (
                    Some(entry.id.clone()),
                    Some(effective_effort),
                    vec!["--model".into(), concrete_slug],
                ),
            );
        }
        return (
            true,
            (
                Some(entry.id.clone()),
                None,
                vec!["--model".into(), entry.id.clone()],
            ),
        );
    }

    (
        false,
        (
            Some(raw_model.to_owned()),
            None,
            vec!["--model".into(), raw_model.to_owned()],
        ),
    )
}

fn effective_catalog_snapshot() -> Vec<LaunchModelInfo> {
    catalog_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|(_, models)| models.clone()))
        .unwrap_or_else(fallback_models)
}

async fn wait_for_catalog_refresh(
    timeout: Duration,
    force_after: Option<Duration>,
) -> Option<Vec<LaunchModelInfo>> {
    // Detach the fetch task on timeout so `agy models` finishes warming the cache
    // instead of getting killed mid-request via `kill_on_drop`.
    let handle = tokio::spawn(fetch_live_catalog_once(force_after));
    tokio::time::timeout(timeout, handle)
        .await
        .ok()
        .and_then(std::result::Result::ok)
        .flatten()
}

pub(crate) async fn resolve_cli_model_and_effort_async(
    model: Option<&str>,
    effort: Option<&str>,
) -> (Option<String>, Option<String>, Vec<String>) {
    if model.map(str::trim).is_none_or(str::is_empty) {
        return resolve_cli_model_and_effort_with_catalog(model, effort, &[]);
    }
    let had_cache = catalog_cache()
        .lock()
        .ok()
        .is_some_and(|guard| guard.is_some());
    if !had_cache {
        let _ = wait_for_catalog_refresh(COLD_CATALOG_WAIT_TIMEOUT, None).await;
    }
    let snapshot = effective_catalog_snapshot();
    let (matched, resolved) =
        resolve_cli_model_and_effort_with_catalog_match(model, effort, &snapshot);
    if matched {
        return resolved;
    }
    let can_refresh = catalog_cache().lock().ok().is_some_and(|guard| {
        guard
            .as_ref()
            .is_some_and(|(updated_at, _)| updated_at.elapsed() >= NEGATIVE_REFRESH_COOLDOWN)
    });
    if can_refresh {
        let _ = wait_for_catalog_refresh(
            COLD_CATALOG_WAIT_TIMEOUT,
            Some(NEGATIVE_REFRESH_COOLDOWN),
        )
        .await;
        return resolve_cli_model_and_effort_with_catalog(
            model,
            effort,
            &effective_catalog_snapshot(),
        );
    }
    resolved
}

pub(crate) fn fallback_models() -> Vec<LaunchModelInfo> {
    let std_efforts: Vec<String> = vec!["low".into(), "medium".into(), "high".into()];
    let xhigh_efforts: Vec<String> =
        vec!["low".into(), "medium".into(), "high".into(), "xhigh".into()];
    vec![
        LaunchModelInfo {
            id: "gemini-4-neon".into(),
            label: "Gemini 4 Neon".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: xhigh_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: true,
        },
        LaunchModelInfo {
            id: "gemini-4-carbon".into(),
            label: "Gemini 4 Carbon".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "gemini-4-argon".into(),
            label: "Gemini 4 Argon".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "gemini-4-hydrogen".into(),
            label: "Gemini 4 Hydrogen".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: xhigh_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "gemini-pro-orchestrator-neon".into(),
            label: "Orchestrator · Gemini 4 Neon".into(),
            description: Some("Orchestrator 规划模型 · 执行由 Gemini 4 Hydrogen 完成".into()),
            supported_efforts: xhigh_efforts,
            default_effort: Some("high".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "gemini-pro-orchestrator".into(),
            label: "Orchestrator · Gemini 4 Carbon".into(),
            description: Some("Orchestrator 规划模型 · 执行由 Gemini 4 Hydrogen 完成".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "gemini-pro-orchestrator-argon".into(),
            label: "Orchestrator · Gemini 4 Argon".into(),
            description: Some("Orchestrator 规划模型 · 执行由 Gemini 4 Hydrogen 完成".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "gemini-pro-orchestrator-claude-opus-5-5".into(),
            label: "Orchestrator · Claude Opus 5.5".into(),
            description: Some("Orchestrator 规划模型 · 执行由 Gemini 4 Hydrogen 完成".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "gemini-3.8-flash".into(),
            label: "Gemini 3.8 Flash".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "claude-opus-5-5".into(),
            label: "Claude Opus 5.5".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: std_efforts.clone(),
            default_effort: Some("medium".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "claude-sonnet-5-5".into(),
            label: "Claude Sonnet 5.5".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: std_efforts,
            default_effort: Some("medium".into()),
            is_default: false,
        },
        LaunchModelInfo {
            id: "gpt-oss-120b".into(),
            label: "GPT-OSS 120B".into(),
            description: Some("Antigravity 订阅模型".into()),
            supported_efforts: vec!["medium".into()],
            default_effort: Some("medium".into()),
            is_default: false,
        },
    ]
}

pub(crate) fn parse_models_output(output: &str) -> Vec<LaunchModelInfo> {
    let mut standalone: Vec<LaunchModelInfo> = Vec::new();
    let mut raw_orchestrators: Vec<LaunchModelInfo> = Vec::new();
    let mut first_orchestrator_index: Option<usize> = None;

    for line in output.lines() {
        let sanitized = strip_ansi_and_spinner(line);
        let trimmed = sanitized.trim();
        if trimmed.is_empty()
            || trimmed.starts_with("Available models")
            || trimmed.starts_with("Usage:")
            || trimmed.starts_with("Fetching available models")
        {
            continue;
        }
        // Each row looks like: `  gemini-4-argon-high              Gemini 4 Argon (High)`
        let mut parts = trimmed.splitn(2, char::is_whitespace);
        let Some(id) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        if !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        {
            continue;
        }
        let raw_label = parts
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id);
        let (base_id, suffix_effort) = split_model_effort_suffix(id);
        let base_label = strip_label_effort_suffix(raw_label);

        if base_id.starts_with("gemini-pro-orchestrator") {
            if first_orchestrator_index.is_none() {
                first_orchestrator_index = Some(standalone.len());
            }
            if !raw_orchestrators.iter().any(|model| model.id == base_id) {
                raw_orchestrators.push(LaunchModelInfo {
                    id: base_id.to_owned(),
                    label: base_label,
                    description: Some("Antigravity 订阅模型".into()),
                    supported_efforts: Vec::new(),
                    default_effort: None,
                    is_default: false,
                });
            }
            continue;
        }

        if let Some(existing) = standalone.iter_mut().find(|model| model.id == base_id) {
            if let Some(effort) = suffix_effort
                && !existing.supported_efforts.iter().any(|item| item == effort)
            {
                existing.supported_efforts.push(effort.to_owned());
            }
        } else {
            let mut supported_efforts = Vec::new();
            if let Some(effort) = suffix_effort {
                supported_efforts.push(effort.to_owned());
            }
            standalone.push(LaunchModelInfo {
                id: base_id.to_owned(),
                label: base_label,
                description: Some("Antigravity 订阅模型".into()),
                supported_efforts,
                default_effort: None,
                is_default: false,
            });
        }
    }

    for model in &mut standalone {
        if model.supported_efforts.is_empty() {
            model.default_effort = None;
        } else {
            model.supported_efforts.sort_by_key(|effort| {
                KNOWN_EFFORTS
                    .iter()
                    .position(|&known| known == effort)
                    .unwrap_or(usize::MAX)
            });
            model.default_effort =
                Some(default_effort_for_base(&model.id, &model.supported_efforts));
        }
    }

    let has_consumer_orchestrator = raw_orchestrators.iter().any(|model| {
        model.id == "gemini-pro-orchestrator-neon" || model.id == "gemini-pro-orchestrator-argon"
    }) || raw_orchestrators.len() > 1;

    let mut orchestrators = if has_consumer_orchestrator {
        let mut expanded = Vec::new();
        for &(orch_id, planner_base, fallback_label) in ORCHESTRATOR_PLANNERS {
            let planner = standalone.iter().find(|model| model.id == planner_base);
            let in_raw = raw_orchestrators.iter().any(|model| model.id == orch_id);
            if planner.is_some() || in_raw {
                let supported_efforts = planner
                    .map(|model| model.supported_efforts.clone())
                    .unwrap_or_default();
                let default_effort = (!supported_efforts.is_empty())
                    .then(|| default_effort_for_base(orch_id, &supported_efforts));
                let planner_label = planner
                    .map(|model| model.label.as_str())
                    .unwrap_or(fallback_label);
                expanded.push(LaunchModelInfo {
                    id: orch_id.to_owned(),
                    label: format!("Orchestrator · {planner_label}"),
                    description: Some("Orchestrator 规划模型 · 执行由 Gemini 4 Hydrogen 完成".into()),
                    supported_efforts,
                    default_effort,
                    is_default: false,
                });
            }
        }
        for raw in raw_orchestrators {
            if !ORCHESTRATOR_PLANNERS
                .iter()
                .any(|(orch_id, _, _)| *orch_id == raw.id)
            {
                expanded.push(raw);
            }
        }
        expanded
    } else {
        raw_orchestrators
    };

    let mut models = standalone;
    let insert_at = first_orchestrator_index
        .unwrap_or(models.len())
        .min(models.len());
    models.splice(insert_at..insert_at, orchestrators.drain(..));

    for model in &mut models {
        model.is_default = false;
    }
    if let Some(neon) = models.iter_mut().find(|model| model.id == "gemini-4-neon") {
        neon.is_default = true;
    } else if let Some(carbon) = models.iter_mut().find(|model| model.id == "gemini-4-carbon") {
        carbon.is_default = true;
    } else if let Some(first) = models.first_mut() {
        first.is_default = true;
    }
    models
}

type AgyCatalogCache = Mutex<Option<(Instant, Vec<LaunchModelInfo>)>>;

fn catalog_cache() -> &'static AgyCatalogCache {
    static CACHE: OnceLock<AgyCatalogCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn fetch_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

async fn fetch_live_catalog_once(force_after: Option<Duration>) -> Option<Vec<LaunchModelInfo>> {
    let _guard = fetch_lock().lock().await;
    if let Ok(guard) = catalog_cache().lock()
        && let Some((updated_at, models)) = guard.as_ref()
    {
        let fresh_window = force_after.unwrap_or(CATALOG_CACHE_TTL);
        if updated_at.elapsed() < fresh_window {
            return Some(models.clone());
        }
    }
    let mut command = Command::new(binary());
    command
        .arg("models")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Ok(Ok(output)) = tokio::time::timeout(CATALOG_CMD_TIMEOUT, command.output()).await
        && output.status.success()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed = parse_models_output(&stdout);
        if !parsed.is_empty() {
            if let Ok(mut guard) = catalog_cache().lock() {
                *guard = Some((Instant::now(), parsed.clone()));
            }
            return Some(parsed);
        }
    }
    None
}

pub(crate) fn warm_catalog_in_background() {
    static WARMING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if WARMING
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::SeqCst,
            std::sync::atomic::Ordering::SeqCst,
        )
        .is_err()
    {
        return;
    }
    tokio::spawn(async move {
        let _ = fetch_live_catalog_once(None).await;
        WARMING.store(false, std::sync::atomic::Ordering::SeqCst);
    });
}

pub(crate) async fn launch_catalog() -> Result<LaunchModelCatalog> {
    let cached = catalog_cache().lock().ok().and_then(|guard| guard.clone());
    let models = match cached {
        Some((updated_at, models)) if updated_at.elapsed() < CATALOG_CACHE_TTL => models,
        Some((_, models)) => {
            warm_catalog_in_background();
            models
        }
        None => wait_for_catalog_refresh(COLD_CATALOG_WAIT_TIMEOUT, None)
            .await
            .unwrap_or_else(fallback_models),
    };
    let default_model = models
        .iter()
        .find(|model| model.is_default)
        .or_else(|| models.first());
    let current_model = default_model.map(|model| model.id.clone());
    let current_effort = default_model.and_then(|model| model.default_effort.clone());
    Ok(LaunchModelCatalog {
        models,
        presets: Vec::new(),
        current_preset: None,
        current_model,
        current_effort,
    })
}

pub(super) struct AgyTurn {
    events: Option<mpsc::Receiver<AdapterEvent>>,
    lifecycle: ProcessLifecycle,
    interrupted: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl AgyTurn {
    pub(super) fn take_events(&mut self) -> Option<mpsc::Receiver<AdapterEvent>> {
        self.events.take()
    }

    pub(super) async fn interrupt(&self) -> ControlEffectState {
        self.interrupted
            .store(true, std::sync::atomic::Ordering::Release);
        self.lifecycle.request_termination().await
    }

    pub(super) async fn kill(&self) -> ControlEffectState {
        self.interrupted
            .store(true, std::sync::atomic::Ordering::Release);
        self.lifecycle.request_termination().await
    }

    pub(super) fn lifecycle(&self) -> ProcessLifecycle {
        self.lifecycle.clone()
    }
}

fn build_prompt_with_attachments(prompt: &str, temp_files: &[PathBuf]) -> String {
    if temp_files.is_empty() {
        return prompt.to_owned();
    }
    let trimmed = prompt.trim();
    let base = if trimmed.is_empty() {
        "Please inspect the attached image(s)."
    } else {
        trimmed
    };
    let mut out = String::from(base);
    out.push_str("\n\n[Attached image files — inspect with read_file before answering]\n");
    for path in temp_files {
        out.push_str("- ");
        out.push_str(&path.to_string_lossy());
        out.push('\n');
    }
    out
}

pub(super) async fn spawn_turn(
    workspace: &str,
    prompt: &str,
    attachments: &[crate::agent::AttachmentInput],
    native_id: Option<&str>,
    options: &TurnOptions,
) -> Result<AgyTurn> {
    let mut temp_dir: Option<PathBuf> = None;
    let mut temp_files = Vec::new();
    if !attachments.is_empty() {
        let dir = std::env::temp_dir().join(format!("prospero-agy-att-{}", uuid::Uuid::new_v4()));
        if tokio::fs::create_dir_all(&dir).await.is_ok() {
            for (idx, attachment) in attachments.iter().enumerate() {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(attachment.data_b64.trim()) {
                    let ext = match attachment.mime_type.as_str() {
                        "image/png" => "png",
                        "image/gif" => "gif",
                        "image/webp" => "webp",
                        _ => "jpg",
                    };
                    let file_path = dir.join(format!("image-{}.{ext}", idx + 1));
                    if tokio::fs::write(&file_path, bytes).await.is_ok() {
                        temp_files.push(file_path);
                    }
                }
            }
            if temp_files.is_empty() {
                let _ = tokio::fs::remove_dir_all(&dir).await;
            } else {
                temp_dir = Some(dir);
            }
        }
    }

    let effective_prompt = build_prompt_with_attachments(prompt, &temp_files);

    let mut command = Command::new(binary());
    command
        .arg(format!("-p={effective_prompt}"))
        .args(["--output-format", "stream-json"])
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    for (key, value) in &options.environment {
        command.env(key, value);
    }
    if let Some(id) = native_id.map(str::trim).filter(|id| !id.is_empty()) {
        command.args(["--conversation", id]);
    }
    let (_, _, model_effort_args) = if let Some(profile) = options.api_profile.as_ref() {
        let model = options
            .model
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| (!profile.model.trim().is_empty()).then_some(profile.model.trim()));
        match model {
            Some(model) => (
                Some(model.to_owned()),
                None,
                vec!["--model".into(), model.to_owned()],
            ),
            None => (None, None, Vec::new()),
        }
    } else {
        resolve_cli_model_and_effort_async(options.model.as_deref(), options.effort.as_deref())
            .await
    };
    command.args(model_effort_args);
    if options.mode == PermissionMode::Plan {
        command.args(["--mode", "plan"]);
    } else {
        // Headless `agy -p --output-format stream-json` has no interactive stdin
        // permission channel; without `--dangerously-skip-permissions`, tool calls
        // block indefinitely waiting for terminal approval.
        command.arg("--dangerously-skip-permissions");
    }
    if let Some(dir) = temp_dir.as_ref() {
        command.arg("--add-dir").arg(dir);
    }

    super::lifecycle::configure_process_group(&mut command);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            cleanup_temp_dir(temp_dir.as_deref()).await;
            return Err(Error::Invalid(format!("无法启动 Antigravity CLI (agy): {err}")));
        }
    };
    let mut guard = match ChildGuard::new(child) {
        Ok(guard) => guard,
        Err(err) => {
            cleanup_temp_dir(temp_dir.as_deref()).await;
            return Err(err);
        }
    };
    let lifecycle = guard.lifecycle();
    let stdout = match guard.child_mut().stdout.take() {
        Some(stdout) => stdout,
        None => {
            cleanup_temp_dir(temp_dir.as_deref()).await;
            return Err(Error::Closed);
        }
    };
    let stderr = match guard.child_mut().stderr.take() {
        Some(stderr) => stderr,
        None => {
            cleanup_temp_dir(temp_dir.as_deref()).await;
            return Err(Error::Closed);
        }
    };

    let (events_tx, events_rx) = mpsc::channel::<AdapterEvent>(64);
    let reader_lifecycle = lifecycle.clone();
    let interrupted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader_interrupted = interrupted.clone();
    let (mut child, _) = guard.into_child();

    tokio::spawn(async move {
        let stderr_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut buf = Vec::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if buf.len() < 20 {
                    buf.push(line);
                }
            }
            buf.join("\n")
        });

        let mut lines = BufReader::new(stdout).lines();
        let mut translator = AgyTranslator::default();
        while let Ok(Some(line)) = lines.next_line().await {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            for outgoing in translator.feed(&message) {
                if events_tx.send(outgoing).await.is_err() {
                    reader_lifecycle.request_termination().await;
                    await_child_exit(&mut child, &reader_lifecycle).await;
                    cleanup_temp_dir(temp_dir.as_deref()).await;
                    return;
                }
            }
            if translator.is_result_received() {
                let _ = reader_lifecycle.request_termination().await;
                break;
            }
        }

        if !translator.is_result_received() {
            reader_lifecycle.request_termination().await;
        }
        let quiescence = await_child_exit(&mut child, &reader_lifecycle).await;
        let stderr_text = stderr_task.await.unwrap_or_default();
        cleanup_temp_dir(temp_dir.as_deref()).await;

        let interrupted = reader_interrupted.load(std::sync::atomic::Ordering::Acquire)
            && !translator.is_result_received();
        let wait_error = match quiescence {
            Quiescence::Confirmed | Quiescence::DirectChildExited
                if translator.is_result_received() || interrupted =>
            {
                None
            }
            Quiescence::Confirmed | Quiescence::DirectChildExited => {
                let detail = stderr_text.trim();
                if !detail.is_empty() {
                    Some(format!("Antigravity CLI 执行异常: {detail}"))
                } else {
                    Some("Antigravity CLI 事件流在返回结果前结束".into())
                }
            }
            Quiescence::Unknown => Some("Antigravity CLI 进程组退出状态未知".into()),
        };

        for outgoing in translator.finalize(interrupted, wait_error) {
            if events_tx.send(outgoing).await.is_err() {
                break;
            }
        }
    });

    Ok(AgyTurn {
        events: Some(events_rx),
        lifecycle,
        interrupted,
    })
}

async fn cleanup_temp_dir(dir: Option<&Path>) {
    if let Some(dir) = dir {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}

#[derive(Default)]
struct AgyTranslator {
    sm: TurnStreamStateMachine,
}

impl AgyTranslator {
    fn is_result_received(&self) -> bool {
        self.sm.is_result_received()
    }

    fn finalize(&mut self, interrupted: bool, wait_error: Option<String>) -> Vec<AdapterEvent> {
        self.sm.finalize(interrupted, wait_error, Vec::new())
    }

    fn feed(&mut self, message: &Value) -> Vec<AdapterEvent> {
        let mut out = Vec::new();
        let event_kind = message
            .get("event")
            .or_else(|| message.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");

        if let Some(cid) = message
            .get("conversation_id")
            .or_else(|| message.get("conversationId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            self.sm.observe_native_id(cid, &mut out);
        }

        match event_kind {
            "init" => {
                if let Some(cid) = message
                    .get("init")
                    .and_then(|init| {
                        init.get("conversation_id")
                            .or_else(|| init.get("conversationId"))
                    })
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    self.sm.observe_native_id(cid, &mut out);
                }
            }
            "step_update" => {
                if let Some(step) = message
                    .get("step_update")
                    .or_else(|| message.get("stepUpdate"))
                {
                    self.feed_step_update(step, &mut out);
                }
            }
            "result" => {
                if let Some(result) = message.get("result") {
                    self.feed_result(result, &mut out);
                } else {
                    self.feed_result(message, &mut out);
                }
            }
            _ => {}
        }
        out
    }

    fn feed_step_update(&mut self, step: &Value, out: &mut Vec<AdapterEvent>) {
        if let Some(cid) = step
            .get("conversation_id")
            .or_else(|| step.get("conversationId"))
            .or_else(|| step.get("cascade_id"))
            .or_else(|| step.get("cascadeId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            self.sm.observe_native_id(cid, out);
        }

        let step_index = step
            .get("step_index")
            .or_else(|| step.get("stepIndex"))
            .and_then(Value::as_i64)
            .unwrap_or(0);
        let step_type = step
            .get("step_type")
            .or_else(|| step.get("stepType"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let source = step.get("source").and_then(Value::as_str).unwrap_or("");
        let state = step.get("state").and_then(Value::as_str).unwrap_or("");

        // Thinking delta or full thinking text
        if let Some(thinking_delta) = step
            .get("thinking_delta")
            .or_else(|| step.get("thinkingDelta"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            self.sm
                .append_step_thinking(step_index, thinking_delta, None, out);
        } else if let Some(thinking) = step
            .get("thinking")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            self.sm.set_step_thinking(step_index, thinking, None, out);
        }

        // Assistant text delta or full text (skip user_input echoes)
        let is_user_step = step_type.eq_ignore_ascii_case("user_input")
            || source.eq_ignore_ascii_case("SOURCE_USER")
            || source.eq_ignore_ascii_case("user");
        if !is_user_step {
            if let Some(text_delta) = step
                .get("text_delta")
                .or_else(|| step.get("textDelta"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                self.sm.append_step_text(step_index, text_delta, None, out);
            } else if let Some(text) = step
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                self.sm.set_step_text(step_index, text, None, out);
            }
        }

        // Tool calls / results inside step_update
        if let Some((tool_name, call_summary, result_summary)) = extract_step_tool(step, step_type)
        {
            let call_id = format!("agy-step-{step_index}-{tool_name}");
            let is_done = state.contains("DONE") || state.contains("COMPLETE");
            let is_error = state.contains("ERROR") || state.contains("FAIL");
            self.sm
                .begin_tool_call(&call_id, &tool_name, &call_summary, None, None, out);
            if is_done || is_error {
                self.sm.finish_tool_call(
                    &call_id,
                    &tool_name,
                    &result_summary,
                    is_error,
                    None,
                    None,
                    false,
                    out,
                );
            }
        }
    }

    fn feed_result(&mut self, result: &Value, out: &mut Vec<AdapterEvent>) {
        if let Some(cid) = result
            .get("conversation_id")
            .or_else(|| result.get("conversationId"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            self.sm.observe_native_id(cid, out);
        }

        if let Some(usage) = result.get("usage") {
            let input_tokens = usage
                .get("input_tokens")
                .or_else(|| usage.get("inputTokens"))
                .and_then(Value::as_i64);
            let output_tokens = usage
                .get("output_tokens")
                .or_else(|| usage.get("outputTokens"))
                .and_then(Value::as_i64);
            self.sm.record_usage(None, input_tokens, output_tokens);
        }

        let status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("SUCCESS");
        let response = result
            .get("response")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");

        if status.eq_ignore_ascii_case("ERROR") || status.eq_ignore_ascii_case("FAILED") {
            let err_msg = result
                .get("error")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(if !response.is_empty() {
                    response
                } else {
                    "Antigravity CLI 返回错误状态"
                });
            self.sm.record_error(err_msg);
        } else if !response.is_empty() {
            self.sm.set_final_text(response, None, out);
        }

        self.sm.mark_result_received();
    }
}

fn extract_step_tool(step: &Value, step_type: &str) -> Option<(String, String, String)> {
    let tool_info = step.get("tool_info").or_else(|| step.get("toolInfo"));
    let raw_tool_name = step
        .get("tool_name")
        .or_else(|| step.get("toolName"))
        .and_then(Value::as_str)
        .or_else(|| {
            tool_info
                .and_then(|info| info.get("name"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let Some(raw_name) = raw_tool_name {
        let display_name = normalize_agy_tool_name(raw_name);
        let params = tool_info
            .and_then(|info| info.get("parameters").or_else(|| info.get("args")))
            .unwrap_or(step);
        let call_summary = summarize_tool_payload(params, &display_name);
        let result_summary = tool_info
            .and_then(|info| info.get("output").or_else(|| info.get("error")))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(240).collect::<String>())
            .unwrap_or_else(|| call_summary.clone());
        return Some((display_name, call_summary, result_summary));
    }

    let candidates = [
        ("run_command", "runCommand", "Bash"),
        ("view_file", "viewFile", "Read"),
        ("edit_file", "editFile", "Edit"),
        ("create_file", "createFile", "Write"),
        ("delete_file", "deleteFile", "Delete"),
        ("list_directory", "listDirectory", "Ls"),
        ("find_file", "findFile", "Find"),
        ("search_directory", "searchDirectory", "Grep"),
        ("search_web", "searchWeb", "WebSearch"),
        ("read_url_content", "readUrlContent", "WebFetch"),
        ("mcp_tool", "mcpTool", "MCP"),
        ("custom_tool", "customTool", "Tool"),
        ("skill_lookup", "skillLookup", "Skill"),
        ("invoke_subagent", "invokeSubagent", "Subagent"),
    ];
    for (snake, camel, display_name) in candidates {
        if let Some(payload) = step.get(snake).or_else(|| step.get(camel)) {
            let summary = summarize_tool_payload(payload, display_name);
            return Some((display_name.to_owned(), summary.clone(), summary));
        }
    }
    if !step_type.is_empty()
        && !matches!(
            step_type,
            "user_input" | "agent_response" | "planner_response" | "thinking" | "text"
        )
    {
        return Some((
            step_type.to_owned(),
            step_type.to_owned(),
            step_type.to_owned(),
        ));
    }
    None
}

fn normalize_agy_tool_name(raw_name: &str) -> String {
    match raw_name {
        "run_command" | "send_command_input" | "command_status" => "Bash".into(),
        "read_file" | "view_file" | "read_resource" => "Read".into(),
        "edit_file" | "replace_file_content" | "multi_replace_file_content" | "sed_file" => {
            "Edit".into()
        }
        "write_file" | "write_to_file" | "create_file" => "Write".into(),
        "grep_search" | "search_directory" => "Grep".into(),
        "find_by_name" | "find_file" => "Find".into(),
        "list_dir" | "list_directory" | "list_resources" => "Ls".into(),
        "search_web" | "search_marketplace" => "WebSearch".into(),
        "read_url_content" => "WebFetch".into(),
        "call_mcp_tool" | "mcp_tool" => "MCP".into(),
        "invoke_subagent" | "manage_subagents" | "browser_subagent" => "Subagent".into(),
        other => other.to_owned(),
    }
}

fn summarize_tool_payload(payload: &Value, fallback: &str) -> String {
    for key in [
        "CommandLine",
        "command_line",
        "commandLine",
        "command",
        "Path",
        "TargetFile",
        "FilePath",
        "file_path",
        "filePath",
        "path",
        "DirectoryPath",
        "SearchPath",
        "directory_path",
        "directoryPath",
        "Query",
        "Pattern",
        "query",
        "Url",
        "url",
        "toolSummary",
        "tool_name",
        "toolName",
        "skill_name",
        "skillName",
        "Role",
        "Prompt",
        "summary",
    ] {
        if let Some(val) = payload
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return val.chars().take(240).collect();
        }
    }
    fallback.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agy_models_table_output() {
        let sample = "\
\r\x1b[2K⠋ Fetching available models...\r
Available models (18):

  gemini-4-neon-high               Gemini 4 Neon (High)
  gemini-4-neon-xhigh              Gemini 4 Neon (XHigh)
  gemini-4-neon-medium             Gemini 4 Neon (Medium)
  gemini-4-neon-low                Gemini 4 Neon (Low)
  gemini-4-carbon-medium           Gemini 4 Carbon (Medium)
  gemini-4-argon-high              Gemini 4 Argon (High)
  gemini-4-argon-medium            Gemini 4 Argon (Medium)
  gemini-4-hydrogen-low            Gemini 4 Hydrogen (Low)
  gemini-4-hydrogen-medium         Gemini 4 Hydrogen (Medium)
  gemini-4-hydrogen-high           Gemini 4 Hydrogen (High)
  gemini-4-hydrogen-xhigh          Gemini 4 Hydrogen (XHigh)
  gemini-pro-orchestrator-neon\tOrchestrator (Neon)
  gemini-pro-orchestrator          Orchestrator (Carbon)
  gemini-pro-orchestrator-argon    Orchestrator (Argon)
  claude-opus-5-5-low              Claude Opus 5.5 (Low)
  claude-opus-5-5-medium           Claude Opus 5.5 (Medium)
  claude-opus-5-5-high             Claude Opus 5.5 (High)

Usage: agy --model <id> [prompt]
";
        let models = parse_models_output(sample);
        assert_eq!(models.len(), 9);

        assert_eq!(models[0].id, "gemini-4-neon");
        assert_eq!(models[0].label, "Gemini 4 Neon");
        assert_eq!(models[0].default_effort.as_deref(), Some("medium"));
        assert_eq!(
            models[0].supported_efforts,
            vec![
                "low".to_owned(),
                "medium".to_owned(),
                "high".to_owned(),
                "xhigh".to_owned(),
            ]
        );
        assert!(models[0].is_default);

        assert_eq!(models[1].id, "gemini-4-carbon");
        assert!(!models[1].is_default);
        assert_eq!(models[2].id, "gemini-4-argon");
        assert_eq!(models[2].label, "Gemini 4 Argon");
        assert_eq!(models[2].default_effort.as_deref(), Some("medium"));
        assert_eq!(
            models[2].supported_efforts,
            vec!["medium".to_owned(), "high".to_owned()]
        );
        assert!(!models[2].is_default);

        assert_eq!(models[3].id, "gemini-4-hydrogen");
        assert_eq!(models[3].label, "Gemini 4 Hydrogen");
        assert_eq!(models[3].default_effort.as_deref(), Some("medium"));
        assert_eq!(
            models[3].supported_efforts,
            vec![
                "low".to_owned(),
                "medium".to_owned(),
                "high".to_owned(),
                "xhigh".to_owned(),
            ]
        );

        assert_eq!(models[4].id, "gemini-pro-orchestrator-neon");
        assert_eq!(models[4].label, "Orchestrator · Gemini 4 Neon");
        assert_eq!(
            models[4].supported_efforts,
            vec![
                "low".to_owned(),
                "medium".to_owned(),
                "high".to_owned(),
                "xhigh".to_owned(),
            ]
        );
        assert_eq!(models[4].default_effort.as_deref(), Some("high"));

        assert_eq!(models[5].id, "gemini-pro-orchestrator");
        assert_eq!(models[5].label, "Orchestrator · Gemini 4 Carbon");
        assert_eq!(models[5].supported_efforts, vec!["medium".to_owned()]);
        assert_eq!(models[5].default_effort.as_deref(), Some("medium"));

        assert_eq!(models[6].id, "gemini-pro-orchestrator-argon");
        assert_eq!(models[6].label, "Orchestrator · Gemini 4 Argon");
        assert_eq!(
            models[6].supported_efforts,
            vec!["medium".to_owned(), "high".to_owned()]
        );
        assert_eq!(models[6].default_effort.as_deref(), Some("medium"));

        assert_eq!(models[7].id, "gemini-pro-orchestrator-claude-opus-5-5");
        assert_eq!(models[7].label, "Orchestrator · Claude Opus 5.5");
        assert_eq!(
            models[7].supported_efforts,
            vec!["low".to_owned(), "medium".to_owned(), "high".to_owned()]
        );
        assert_eq!(models[7].default_effort.as_deref(), Some("medium"));

        assert_eq!(models[8].id, "claude-opus-5-5");
        assert_eq!(models[8].label, "Claude Opus 5.5");
        assert_eq!(models[8].default_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn parses_enterprise_orchestrator_without_consumer_planners() {
        let sample = "\
  gemini-4-carbon-high             Gemini 4 Carbon (High)
  gemini-4-hydrogen-high           Gemini 4 Hydrogen (High)
  gemini-pro-orchestrator          Orchestrator
";
        let models = parse_models_output(sample);
        let orchestrator = models
            .iter()
            .find(|model| model.id == "gemini-pro-orchestrator")
            .unwrap();
        assert_eq!(orchestrator.label, "Orchestrator");
        assert!(orchestrator.supported_efforts.is_empty());
        assert_eq!(orchestrator.default_effort, None);

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("gemini-pro-orchestrator"),
            Some("high"),
            &models,
        );
        assert_eq!(model.as_deref(), Some("gemini-pro-orchestrator"));
        assert_eq!(effort, None);
        assert_eq!(args, vec!["--model", "gemini-pro-orchestrator"]);
    }

    #[test]
    fn resolves_cli_model_and_effort_without_conflict() {
        let catalog = fallback_models();

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("gemini-4-argon-medium"),
            Some("max"),
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-4-argon"));
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(args, vec!["--model", "gemini-4-argon-high"]);

        let (model, effort, args) =
            resolve_cli_model_and_effort_with_catalog(Some("gpt-oss-120b"), Some("high"), &catalog);
        assert_eq!(model.as_deref(), Some("gpt-oss-120b"));
        assert_eq!(effort.as_deref(), Some("medium"));
        assert_eq!(args, vec!["--model", "gpt-oss-120b-medium"]);

        let (model, effort, args) =
            resolve_cli_model_and_effort_with_catalog(None, Some("max"), &catalog);
        assert_eq!(model, None);
        assert_eq!(effort.as_deref(), Some("xhigh"));
        assert_eq!(args, vec!["--effort", "xhigh"]);

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("Gemini 4 Argon (High)"),
            None,
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-4-argon"));
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(args, vec!["--model", "gemini-4-argon-high"]);

        let (model, effort, args) =
            resolve_cli_model_and_effort_with_catalog(Some("Argon 4 High"), None, &catalog);
        assert_eq!(model.as_deref(), Some("gemini-4-argon"));
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(args, vec!["--model", "gemini-4-argon-high"]);

        let (model, effort, args) =
            resolve_cli_model_and_effort_with_catalog(Some("gemini-4-carbon"), None, &catalog);
        assert_eq!(model.as_deref(), Some("gemini-4-carbon"));
        assert_eq!(effort.as_deref(), Some("medium"));
        assert_eq!(args, vec!["--model", "gemini-4-carbon-medium"]);

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("gemini-4-hydrogen"),
            Some("xhigh"),
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-4-hydrogen"));
        assert_eq!(effort.as_deref(), Some("xhigh"));
        assert_eq!(args, vec!["--model", "gemini-4-hydrogen-xhigh"]);

        let (model, effort, args) =
            resolve_cli_model_and_effort_with_catalog(Some("gemini-4-hydrogen"), None, &catalog);
        assert_eq!(model.as_deref(), Some("gemini-4-hydrogen"));
        assert_eq!(effort.as_deref(), Some("medium"));
        assert_eq!(args, vec!["--model", "gemini-4-hydrogen-medium"]);

        let (model, effort, args) =
            resolve_cli_model_and_effort_with_catalog(Some("gemini-4-neon"), None, &catalog);
        assert_eq!(model.as_deref(), Some("gemini-4-neon"));
        assert_eq!(effort.as_deref(), Some("medium"));
        assert_eq!(args, vec!["--model", "gemini-4-neon-medium"]);

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("Gemini 4 Neon (XHigh)"),
            None,
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-4-neon"));
        assert_eq!(effort.as_deref(), Some("xhigh"));
        assert_eq!(args, vec!["--model", "gemini-4-neon-xhigh"]);

        let (model, effort, args) =
            resolve_cli_model_and_effort_with_catalog(Some("neon"), Some("max"), &catalog);
        assert_eq!(model.as_deref(), Some("gemini-4-neon"));
        assert_eq!(effort.as_deref(), Some("xhigh"));
        assert_eq!(args, vec!["--model", "gemini-4-neon-xhigh"]);

        // Consumer Orchestrator planners emit a valid built-in orchestrator CLI slug plus `--settings` override.
        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("gemini-pro-orchestrator-neon"),
            Some("xhigh"),
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-pro-orchestrator-neon"));
        assert_eq!(effort.as_deref(), Some("xhigh"));
        assert_eq!(
            args,
            vec![
                "--model",
                "gemini-pro-orchestrator-neon",
                "--settings",
                r#"{"orchestrator":{"planner":"Gemini 4 Neon (XHigh)"}}"#,
            ]
        );

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("gemini-pro-orchestrator"),
            Some("high"),
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-pro-orchestrator"));
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(
            args,
            vec![
                "--model",
                "gemini-pro-orchestrator",
                "--settings",
                r#"{"orchestrator":{"planner":"Gemini 4 Carbon (High)"}}"#,
            ]
        );

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("gemini-pro-orchestrator-argon"),
            Some("low"),
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-pro-orchestrator-argon"));
        assert_eq!(effort.as_deref(), Some("low"));
        assert_eq!(
            args,
            vec![
                "--model",
                "gemini-pro-orchestrator-argon",
                "--settings",
                r#"{"orchestrator":{"planner":"Gemini 4 Argon (Low)"}}"#,
            ]
        );

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("gemini-pro-orchestrator-claude-opus-5-5"),
            Some("high"),
            &catalog,
        );
        assert_eq!(
            model.as_deref(),
            Some("gemini-pro-orchestrator-claude-opus-5-5")
        );
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(
            args,
            vec![
                "--model",
                "gemini-pro-orchestrator-neon",
                "--settings",
                r#"{"orchestrator":{"planner":"Claude Opus 5.5 (High)"}}"#,
            ]
        );

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("Orchestrator · Claude Opus 5.5"),
            None,
            &catalog,
        );
        assert_eq!(
            model.as_deref(),
            Some("gemini-pro-orchestrator-claude-opus-5-5")
        );
        assert_eq!(effort.as_deref(), Some("medium"));
        assert_eq!(
            args,
            vec![
                "--model",
                "gemini-pro-orchestrator-neon",
                "--settings",
                r#"{"orchestrator":{"planner":"Claude Opus 5.5 (Medium)"}}"#,
            ]
        );

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("Orchestrator (Neon)"),
            Some("high"),
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-pro-orchestrator-neon"));
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(
            args,
            vec![
                "--model",
                "gemini-pro-orchestrator-neon",
                "--settings",
                r#"{"orchestrator":{"planner":"Gemini 4 Neon (High)"}}"#,
            ]
        );

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("gemini-pro-orchestrator-neon-high"),
            None,
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-pro-orchestrator-neon"));
        assert_eq!(effort.as_deref(), Some("high"));
        assert_eq!(
            args,
            vec![
                "--model",
                "gemini-pro-orchestrator-neon",
                "--settings",
                r#"{"orchestrator":{"planner":"Gemini 4 Neon (High)"}}"#,
            ]
        );

        // Custom / gateway models are passed through verbatim without appending -{effort}.
        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("deepseek-chat"),
            Some("high"),
            &catalog,
        );
        assert_eq!(model.as_deref(), Some("deepseek-chat"));
        assert_eq!(effort, None);
        assert_eq!(args, vec!["--model", "deepseek-chat"]);

        let (model, effort, args) =
            resolve_cli_model_and_effort_with_catalog(Some("gpt-5.4"), None, &catalog);
        assert_eq!(model.as_deref(), Some("gpt-5.4"));
        assert_eq!(effort, None);
        assert_eq!(args, vec!["--model", "gpt-5.4"]);
    }

    #[test]
    fn resolves_unseen_future_models_dynamically_from_parsed_catalog() {
        let future_catalog = parse_models_output(
            "\
  gemini-5-krypton-low              Gemini 5 Krypton (Low)
  gemini-5-krypton-medium           Gemini 5 Krypton (Medium)
  gemini-5-krypton-high             Gemini 5 Krypton (High)
  gemini-5-krypton-xhigh            Gemini 5 Krypton (XHigh)
  gemini-5-krypton-max              Gemini 5 Krypton (Max)
  gemini-pro-orchestrator-krypton   Orchestrator (Krypton)
",
        );

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("Gemini 5 Krypton"),
            Some("ultra"),
            &future_catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-5-krypton"));
        assert_eq!(effort.as_deref(), Some("max"));
        assert_eq!(args, vec!["--model", "gemini-5-krypton-max"]);

        let (model, effort, args) = resolve_cli_model_and_effort_with_catalog(
            Some("Orchestrator (Krypton)"),
            Some("high"),
            &future_catalog,
        );
        assert_eq!(model.as_deref(), Some("gemini-pro-orchestrator-krypton"));
        assert_eq!(effort, None);
        assert_eq!(args, vec!["--model", "gemini-pro-orchestrator-krypton"]);
    }

    #[test]
    fn translates_stream_json_init_step_and_result() {
        let mut translator = AgyTranslator::default();
        let init: Value = serde_json::from_str(
            r#"{"event":"init","conversation_id":"f54fdff9-fc4a-4cf8-8cf8-be185b18c06c","init":{"model":"MODEL_PLACEHOLDER_M47","cwd":"/private/tmp"}}"#,
        )
        .unwrap();
        let events = translator.feed(&init);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::NativeId(id)] if id == "f54fdff9-fc4a-4cf8-8cf8-be185b18c06c"
        ));

        let result: Value = serde_json::from_str(
            r#"{"event":"result","result":{"conversation_id":"f54fdff9-fc4a-4cf8-8cf8-be185b18c06c","status":"SUCCESS","response":"PONG","duration_seconds":2.5,"usage":{"input_tokens":10,"output_tokens":5}}}"#,
        )
        .unwrap();
        let events = translator.feed(&result);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::Text { subagent: None, text }] if text == "PONG"
        ));
        assert!(translator.is_result_received());
        let final_events = translator.finalize(false, None);
        assert!(matches!(
            final_events.as_slice(),
            [AdapterEvent::Finish {
                interrupted: false,
                error: None,
                input_tokens: Some(10),
                output_tokens: Some(5),
                ..
            }]
        ));
    }

    #[test]
    fn translates_tool_call_and_agent_response_steps() {
        let mut translator = AgyTranslator::default();
        let step1: Value = serde_json::from_str(
            r#"{"event":"step_update","step_update":{"conversation_id":"0339b39c","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":1.0}}"#,
        )
        .unwrap();
        let events = translator.feed(&step1);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::NativeId(id)] if id == "0339b39c"
        ));

        let tool_active: Value = serde_json::from_str(
            r#"{"event":"step_update","step_update":{"conversation_id":"0339b39c","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"name":"read_file","parameters":{"EndLine":5,"Path":"/workspace/Prospero/Cargo.toml","StartLine":1}}}}"#,
        )
        .unwrap();
        let events = translator.feed(&tool_active);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::ToolCall { name, summary, .. }]
                if name == "Read" && summary == "/workspace/Prospero/Cargo.toml"
        ));

        let tool_done: Value = serde_json::from_str(
            r#"{"event":"step_update","step_update":{"conversation_id":"0339b39c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","duration_seconds":0.11,"tool_info":{"name":"read_file","parameters":{"EndLine":5,"Path":"/workspace/Prospero/Cargo.toml","StartLine":1},"output":"21 lines, 362 bytes"}}}"#,
        )
        .unwrap();
        let events = translator.feed(&tool_done);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::ToolResult { name, summary, error: false, .. }]
                if name == "Read" && summary == "21 lines, 362 bytes"
        ));

        let step3: Value = serde_json::from_str(
            r#"{"event":"step_update","step_update":{"conversation_id":"0339b39c","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}"#,
        )
        .unwrap();
        let events = translator.feed(&step3);
        assert!(matches!(
            events.as_slice(),
            [AdapterEvent::Text { subagent: None, text }] if text == "OK"
        ));
    }

    #[test]
    fn builds_prompt_with_attached_image_paths() {
        assert_eq!(build_prompt_with_attachments("hello", &[]), "hello");

        let paths = vec![
            PathBuf::from("/tmp/prospero-agy-att-1/image-1.png"),
            PathBuf::from("/tmp/prospero-agy-att-1/image-2.jpg"),
        ];
        let with_text = build_prompt_with_attachments("What is in these screenshots?", &paths);
        assert!(with_text.starts_with("What is in these screenshots?"));
        assert!(with_text.contains("[Attached image files — inspect with read_file before answering]"));
        assert!(with_text.contains("- /tmp/prospero-agy-att-1/image-1.png"));
        assert!(with_text.contains("- /tmp/prospero-agy-att-1/image-2.jpg"));

        let empty_prompt = build_prompt_with_attachments("   ", &paths[..1]);
        assert!(empty_prompt.starts_with("Please inspect the attached image(s)."));
        assert!(empty_prompt.contains("- /tmp/prospero-agy-att-1/image-1.png"));
    }
}
