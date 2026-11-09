use std::collections::BTreeMap;

use super::claude::AdapterEvent;
use crate::protocol::FileDiff;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnPhase {
    Bootstrapping,
    Streaming,
    Finished,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolCallPhase {
    Running {
        subagent: Option<String>,
        name: String,
        summary: String,
    },
    Finished,
}

/// Shared explicit state machine for translating CLI / JSON-RPC turn streams into
/// normalized `AdapterEvent` sequences.
///
/// Guarantees:
/// - `AdapterEvent::NativeId` is emitted at most once per turn when a non-empty ID is observed.
/// - Step-indexed thinking and assistant text deltas/snapshots are aggregated deterministically
///   and only emit `AdapterEvent::Thinking` / `AdapterEvent::Text` when the combined output changes.
/// - Each `call_id` transitions strictly `Absent -> Running -> Finished`, preventing duplicate
///   `ToolCall` or `ToolResult` emissions.
/// - `finalize(...)` settles any still-`Running` tool calls before emitting `AdapterEvent::Finish`
///   at most once.
pub struct TurnStreamStateMachine {
    phase: TurnPhase,
    native_id: Option<String>,
    thinking_by_step: BTreeMap<i64, String>,
    last_emitted_thinking: String,
    text_by_step: BTreeMap<i64, String>,
    assistant_text: String,
    tools: BTreeMap<String, ToolCallPhase>,
    error: Option<String>,
    cost_usd: Option<f64>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    result_received: bool,
}

impl Default for TurnStreamStateMachine {
    fn default() -> Self {
        Self {
            phase: TurnPhase::Bootstrapping,
            native_id: None,
            thinking_by_step: BTreeMap::new(),
            last_emitted_thinking: String::new(),
            text_by_step: BTreeMap::new(),
            assistant_text: String::new(),
            tools: BTreeMap::new(),
            error: None,
            cost_usd: None,
            input_tokens: None,
            output_tokens: None,
            result_received: false,
        }
    }
}

impl TurnStreamStateMachine {
    #[cfg(test)]
    pub fn phase(&self) -> TurnPhase {
        self.phase
    }

    pub fn is_result_received(&self) -> bool {
        self.result_received
    }

    pub fn observe_native_id(&mut self, id: &str, out: &mut Vec<AdapterEvent>) {
        let trimmed = id.trim();
        if trimmed.is_empty() || self.native_id.is_some() {
            return;
        }
        self.native_id = Some(trimmed.to_owned());
        if self.phase == TurnPhase::Bootstrapping {
            self.phase = TurnPhase::Streaming;
        }
        out.push(AdapterEvent::NativeId(trimmed.to_owned()));
    }

    pub fn append_step_thinking(
        &mut self,
        step_index: i64,
        delta: &str,
        subagent: Option<String>,
        out: &mut Vec<AdapterEvent>,
    ) {
        if delta.is_empty() || self.phase == TurnPhase::Finished {
            return;
        }
        self.ensure_streaming();
        self.thinking_by_step
            .entry(step_index)
            .or_default()
            .push_str(delta);
        self.emit_thinking_if_changed(subagent, out);
    }

    pub fn set_step_thinking(
        &mut self,
        step_index: i64,
        thinking: &str,
        subagent: Option<String>,
        out: &mut Vec<AdapterEvent>,
    ) {
        if thinking.is_empty() || self.phase == TurnPhase::Finished {
            return;
        }
        self.ensure_streaming();
        let entry = self.thinking_by_step.entry(step_index).or_default();
        if entry != thinking {
            *entry = thinking.to_owned();
            self.emit_thinking_if_changed(subagent, out);
        }
    }

    fn emit_thinking_if_changed(
        &mut self,
        subagent: Option<String>,
        out: &mut Vec<AdapterEvent>,
    ) {
        let combined = self
            .thinking_by_step
            .values()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n\n");
        if !combined.is_empty() && combined != self.last_emitted_thinking {
            self.last_emitted_thinking = combined.clone();
            out.push(AdapterEvent::Thinking {
                subagent,
                text: combined,
            });
        }
    }

    pub fn append_step_text(
        &mut self,
        step_index: i64,
        delta: &str,
        subagent: Option<String>,
        out: &mut Vec<AdapterEvent>,
    ) {
        if delta.is_empty() || self.phase == TurnPhase::Finished {
            return;
        }
        self.ensure_streaming();
        self.text_by_step
            .entry(step_index)
            .or_default()
            .push_str(delta);
        self.emit_text_if_changed(subagent, out);
    }

    pub fn set_step_text(
        &mut self,
        step_index: i64,
        text: &str,
        subagent: Option<String>,
        out: &mut Vec<AdapterEvent>,
    ) {
        if text.is_empty() || self.phase == TurnPhase::Finished {
            return;
        }
        self.ensure_streaming();
        let prev = self.text_by_step.insert(step_index, text.to_owned());
        if prev.as_deref() != Some(text) {
            self.emit_text_if_changed(subagent, out);
        }
    }

    pub fn set_final_text(
        &mut self,
        text: &str,
        subagent: Option<String>,
        out: &mut Vec<AdapterEvent>,
    ) {
        let trimmed = text.trim();
        if trimmed.is_empty() || self.phase == TurnPhase::Finished {
            return;
        }
        self.ensure_streaming();
        if self.assistant_text.trim() != trimmed {
            self.assistant_text = trimmed.to_owned();
            out.push(AdapterEvent::Text {
                subagent,
                text: self.assistant_text.clone(),
            });
        }
    }

    fn emit_text_if_changed(&mut self, subagent: Option<String>, out: &mut Vec<AdapterEvent>) {
        let combined = self
            .text_by_step
            .values()
            .filter(|s| !s.trim().is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n\n");
        if !combined.is_empty() && combined != self.assistant_text {
            self.assistant_text = combined.clone();
            out.push(AdapterEvent::Text {
                subagent,
                text: combined,
            });
        }
    }

    pub fn begin_tool_call(
        &mut self,
        call_id: &str,
        name: &str,
        summary: &str,
        subagent: Option<String>,
        diff: Option<FileDiff>,
        out: &mut Vec<AdapterEvent>,
    ) {
        if call_id.is_empty() || self.phase == TurnPhase::Finished {
            return;
        }
        self.ensure_streaming();
        if self.tools.contains_key(call_id) {
            return;
        }
        self.tools.insert(
            call_id.to_owned(),
            ToolCallPhase::Running {
                subagent: subagent.clone(),
                name: name.to_owned(),
                summary: summary.to_owned(),
            },
        );
        out.push(AdapterEvent::ToolCall {
            subagent,
            call_id: call_id.to_owned(),
            name: name.to_owned(),
            summary: summary.to_owned(),
            diff,
        });
    }

    pub fn finish_tool_call(
        &mut self,
        call_id: &str,
        name: &str,
        summary: &str,
        error: bool,
        subagent: Option<String>,
        diff: Option<FileDiff>,
        has_more: bool,
        out: &mut Vec<AdapterEvent>,
    ) {
        if call_id.is_empty() || self.phase == TurnPhase::Finished {
            return;
        }
        self.ensure_streaming();
        if matches!(self.tools.get(call_id), Some(ToolCallPhase::Finished)) {
            return;
        }
        if !self.tools.contains_key(call_id) {
            self.begin_tool_call(call_id, name, summary, subagent.clone(), None, out);
        }
        self.tools
            .insert(call_id.to_owned(), ToolCallPhase::Finished);
        out.push(AdapterEvent::ToolResult {
            subagent,
            call_id: call_id.to_owned(),
            name: name.to_owned(),
            summary: summary.to_owned(),
            error,
            diff,
            has_more,
        });
    }

    pub fn record_usage(
        &mut self,
        cost_usd: Option<f64>,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
    ) {
        if cost_usd.is_some() {
            self.cost_usd = cost_usd;
        }
        if input_tokens.is_some() {
            self.input_tokens = input_tokens;
        }
        if output_tokens.is_some() {
            self.output_tokens = output_tokens;
        }
    }

    pub fn record_error(&mut self, error: impl Into<String>) {
        let message = error.into();
        if !message.trim().is_empty() {
            self.error = Some(message);
        }
    }

    pub fn mark_result_received(&mut self) {
        self.ensure_streaming();
        self.result_received = true;
    }

    /// Settles any still-running tool calls and emits `AdapterEvent::Finish` at most once.
    pub fn finalize(
        &mut self,
        interrupted: bool,
        fallback_error: Option<String>,
        diffs: Vec<FileDiff>,
    ) -> Vec<AdapterEvent> {
        if self.phase == TurnPhase::Finished {
            return Vec::new();
        }
        let mut out = Vec::new();
        let error = self.error.clone().or(fallback_error);
        let settle_as_error = interrupted || error.is_some();

        let open_tools: Vec<(String, Option<String>, String, String)> = self
            .tools
            .iter()
            .filter_map(|(call_id, phase)| match phase {
                ToolCallPhase::Running {
                    subagent,
                    name,
                    summary,
                } => Some((
                    call_id.clone(),
                    subagent.clone(),
                    name.clone(),
                    summary.clone(),
                )),
                ToolCallPhase::Finished => None,
            })
            .collect();

        for (call_id, subagent, name, summary) in open_tools {
            self.tools.insert(call_id.clone(), ToolCallPhase::Finished);
            out.push(AdapterEvent::ToolResult {
                subagent,
                call_id,
                name,
                summary,
                error: settle_as_error,
                diff: None,
                has_more: false,
            });
        }

        self.phase = TurnPhase::Finished;
        out.push(AdapterEvent::Finish {
            interrupted,
            error,
            cost_usd: self.cost_usd,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            diffs,
        });
        out
    }

    fn ensure_streaming(&mut self) {
        if self.phase == TurnPhase::Bootstrapping {
            self.phase = TurnPhase::Streaming;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InFlightTool {
    subagent: Option<String>,
    call_id: String,
    name: String,
}

/// Tracks in-flight tool calls in insertion order so non-`agy` turn streams can
/// settle any unfinished tool calls with `AdapterEvent::ToolResult { error: true }`
/// before emitting `AdapterEvent::Finish`.
#[derive(Debug, Default, Clone)]
pub(crate) struct InFlightTools {
    entries: Vec<InFlightTool>,
}

impl InFlightTools {
    pub fn record_start(&mut self, id: &str, name: &str) {
        self.record_start_with_subagent(None, id, name);
    }

    pub fn record_start_with_subagent(&mut self, subagent: Option<&str>, id: &str, name: &str) {
        if id.is_empty() {
            return;
        }
        let normalized_name = if name.is_empty() { "tool" } else { name };
        if let Some(existing) = self
            .entries
            .iter_mut()
            .find(|entry| entry.call_id == id && entry.subagent.as_deref() == subagent)
        {
            existing.name = normalized_name.to_owned();
            return;
        }
        self.entries.push(InFlightTool {
            subagent: subagent.map(str::to_owned),
            call_id: id.to_owned(),
            name: normalized_name.to_owned(),
        });
    }

    pub fn record_result(&mut self, id: &str) {
        self.record_result_with_subagent(None, id);
    }

    pub fn record_result_with_subagent(&mut self, subagent: Option<&str>, id: &str) {
        if id.is_empty() {
            return;
        }
        self.entries.retain(|entry| {
            !(entry.call_id == id
                && (subagent.is_none() || entry.subagent.as_deref() == subagent))
        });
    }

    pub fn drain_unfinished(&mut self, reason: &str) -> Vec<AdapterEvent> {
        let summary = if reason.trim().is_empty() {
            "工具调用未返回结果".to_owned()
        } else {
            reason.to_owned()
        };
        self.entries
            .drain(..)
            .map(|entry| AdapterEvent::ToolResult {
                subagent: entry.subagent,
                call_id: entry.call_id,
                name: entry.name,
                summary: summary.clone(),
                error: true,
                diff: None,
                has_more: false,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_flight_tools_drains_unfinished_in_order() {
        let mut tools = InFlightTools::default();
        tools.record_start("call-1", "Bash");
        tools.record_start_with_subagent(Some("sub-1"), "call-2", "Read");
        tools.record_start("call-3", "Edit");
        tools.record_result("call-1");

        let drained = tools.drain_unfinished("turn interrupted");
        assert_eq!(drained.len(), 2);
        assert!(matches!(
            &drained[0],
            AdapterEvent::ToolResult {
                subagent: Some(sub),
                call_id,
                name,
                summary,
                error: true,
                ..
            } if sub == "sub-1" && call_id == "call-2" && name == "Read" && summary == "turn interrupted"
        ));
        assert!(matches!(
            &drained[1],
            AdapterEvent::ToolResult {
                subagent: None,
                call_id,
                name,
                summary,
                error: true,
                ..
            } if call_id == "call-3" && name == "Edit" && summary == "turn interrupted"
        ));
        assert!(tools.drain_unfinished("again").is_empty());
    }

    #[test]
    fn emits_native_id_once_and_settles_open_tools_on_finalize() {
        let mut sm = TurnStreamStateMachine::default();
        assert_eq!(sm.phase(), TurnPhase::Bootstrapping);

        let mut events = Vec::new();
        sm.observe_native_id("conv-123", &mut events);
        sm.observe_native_id("conv-123", &mut events);
        sm.observe_native_id("conv-456", &mut events);
        assert_eq!(sm.phase(), TurnPhase::Streaming);
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], AdapterEvent::NativeId(id) if id == "conv-123"));

        events.clear();
        sm.begin_tool_call("call-1", "Bash", "cargo test", None, None, &mut events);
        sm.begin_tool_call("call-1", "Bash", "cargo test", None, None, &mut events);
        assert_eq!(events.len(), 1);

        let final_events = sm.finalize(false, Some("stream died".into()), Vec::new());
        assert_eq!(sm.phase(), TurnPhase::Finished);
        assert_eq!(final_events.len(), 2);
        assert!(matches!(
            &final_events[0],
            AdapterEvent::ToolResult {
                call_id,
                error: true,
                ..
            } if call_id == "call-1"
        ));
        assert!(matches!(
            &final_events[1],
            AdapterEvent::Finish {
                interrupted: false,
                error: Some(err),
                ..
            } if err == "stream died"
        ));

        // Second finalize is idempotent
        assert!(sm.finalize(false, None, Vec::new()).is_empty());
    }
}
