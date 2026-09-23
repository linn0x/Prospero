//! Model-visible contract for Prospero's cross-model child-session CLI.
//!
//! Codex has its own sub-agent catalog.  Without an explicit contract a parent
//! interprets requests for Gemini/DeepSeek as requests for a Codex-internal
//! sub-agent and rejects models absent from that catalog.  Prospero-managed
//! Codex sessions receive the short developer instruction below, while
//! isolated Codex homes also receive the full skill for native discovery.

use std::path::Path;

use crate::error::Result;

#[doc(hidden)]
pub const CODEX_DEVELOPER_INSTRUCTIONS: &str = r#"Prospero cross-model child tool is available in this session. When the user asks to delegate or dispatch work through Prospero, or asks for a child using a named external model/source such as Gemini or DeepSeek, use the shell CLI `prospero child sources` and then `prospero child start`; do not use Codex's internal sub-agent/Task model catalog for that request. Always discover sourceId, routeId, revision, and agent live from `prospero child sources`; require an exact requested source/model match and never hardcode IDs. Start with `prospero child start --source <sourceId> --route <routeId> --revision <revision> --agent <agent> --task <complete task>`. To give more work to an existing completed Prospero child, reuse its session with `prospero child follow-up --child <sessionId> --task <complete follow-up>` instead of starting a replacement. PROSPERO_SESSION_ID supplies the parent automatically. Each child is YOLO/auto-approved. Do not send premature stop, summarize-now, or no-more-exploration instructions. End the parent turn after dispatch; Prospero waits for every child to complete, fail, or time out, injects one fan-in report, and then you must continue by synthesizing that report for the user."#;

pub(crate) const SKILL_NAME: &str = "prospero-cross-model";

const SKILL: &str = r#"---
name: prospero-cross-model
description: Dispatch independent YOLO child sessions through Prospero to a requested external model source or route, including Gemini and DeepSeek, then continue after Prospero fan-in. Use whenever the user asks to delegate, dispatch, send a task to, or run work with a named model/source through Prospero. Do not use Codex internal sub-agents for these requests.
---
# Prospero cross-model child orchestration

Use Prospero's own child-session layer for cross-model delegation.

1. Run `prospero child sources`. Treat its JSON output as the live source of truth.
2. Match the user's requested source and model/route using `sourceName`, `routeName`, and `model`. Never cache or hardcode IDs or revisions.
3. For each independent task, run:

   `prospero child start --source <sourceId> --route <routeId> --revision <revision> --agent <agent> --task <complete task>`

   `PROSPERO_SESSION_ID` supplies the parent session. Only pass `--parent` when explicitly operating for another session. Use the `agent` value returned by `prospero child sources`.
4. Children always run in YOLO/auto-approval mode. Give each child a complete objective and acceptance criteria. Do not tell it to stop exploring, summarize immediately, or otherwise force an early answer.
5. The fan-in report includes each child's Prospero session id. When the user asks an existing completed child to continue or refine its work, reuse its context with `prospero child follow-up --child <sessionId> --task <complete follow-up>`. Do not create a replacement session.
6. After all requested children are started, end the current parent turn. Do not poll or use Codex internal Task/sub-agent tools. Prospero waits until every child completes, fails, or reaches its explicit timeout, then injects a single fan-in report into the parent.
7. When that fan-in report arrives, continue the parent work and synthesize the child results for the user.

If no route matches, report the live routes returned by `prospero child sources` and ask the user to choose.
"#;

/// Install the built-in skill into an isolated Codex home. Existing content is
/// only rewritten when Prospero ships a newer contract.
pub(crate) fn install_codex_skill(codex_home: &Path) -> Result<()> {
    let directory = codex_home.join("skills").join(SKILL_NAME);
    std::fs::create_dir_all(&directory)?;
    let path = directory.join("SKILL.md");
    if !matches!(std::fs::read_to_string(&path), Ok(existing) if existing == SKILL) {
        std::fs::write(&path, SKILL)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Encode a possibly-long fan-in report as bounded PTY writes. Bracketed
/// paste keeps intermediate newlines from submitting partial prompts; the
/// final carriage return submits exactly once.
pub(crate) fn terminal_fan_in_chunks(report: &str, maximum: usize) -> Vec<Vec<u8>> {
    assert!(maximum >= 16);
    let prefix = b"\x1b[200~\n\n";
    let suffix = b"\n\x1b[201~\r";
    let mut stream = Vec::with_capacity(prefix.len() + report.len() + suffix.len());
    stream.extend_from_slice(prefix);
    stream.extend_from_slice(report.as_bytes());
    stream.extend_from_slice(suffix);
    stream
        .chunks(maximum)
        .map(<[u8]>::to_vec)
        .collect::<Vec<_>>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_discoverable_skill_idempotently() {
        let root = tempfile::tempdir().unwrap();
        install_codex_skill(root.path()).unwrap();
        install_codex_skill(root.path()).unwrap();
        let body =
            std::fs::read_to_string(root.path().join("skills/prospero-cross-model/SKILL.md"))
                .unwrap();
        assert_eq!(body, SKILL);
        assert!(body.contains("prospero child sources"));
        assert!(body.contains("PROSPERO_SESSION_ID"));
    }

    #[test]
    fn long_terminal_fan_in_is_bounded_and_submits_once() {
        let report = "结果🙂\n".repeat(10_000);
        let chunks = terminal_fan_in_chunks(&report, 8192);
        assert!(chunks.len() > 1);
        assert!(
            chunks
                .iter()
                .all(|chunk| !chunk.is_empty() && chunk.len() <= 8192)
        );
        let joined = chunks.concat();
        assert!(joined.starts_with(b"\x1b[200~\n\n"));
        assert!(joined.ends_with(b"\n\x1b[201~\r"));
        assert_eq!(joined.iter().filter(|byte| **byte == b'\r').count(), 1);
        assert_eq!(
            &joined[b"\x1b[200~\n\n".len()..joined.len() - b"\n\x1b[201~\r".len()],
            report.as_bytes()
        );
    }

    #[test]
    fn model_contract_exposes_completed_child_follow_up() {
        assert!(CODEX_DEVELOPER_INSTRUCTIONS.contains("prospero child follow-up --child"));
        assert!(SKILL.contains("Prospero session id"));
        assert!(SKILL.contains("Do not create a replacement session"));
    }
}
