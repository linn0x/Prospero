#![cfg(unix)]
//! Agent runtime tests use a tiny fake `claude` CLI (Python) speaking the
//! headless stream-json protocol. Scenario is selected by a `scenario` file
//! in the turn workspace so the process-global PROSPERO_CLAUDE_BIN variable
//! can point at one shared script.

use std::time::Duration;

use prosperod_rs::{
    agent::{Agents, ApprovalPolicy, CreateAgentSession, PermissionMode, ResumeInput},
    protocol::{MessageRole, TimelineBody, TimelineQuery},
    worker::Database,
};
use tempfile::TempDir;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const CATALOG_MODELS: &str = r#"[{"value":"default","displayName":"Default",
   "supportedEffortLevels":["low","medium","high"]},
  {"value":"opus[1m]","displayName":"Opus (1M)","description":"long context",
   "supportedEffortLevels":["low","high","max"]}]"#;

const FAKE_CLI: &str = r#"#!/usr/bin/env python3
import json, os, sys, time

# Catalog-only handshake: exact five headless args, one initialize frame.
if sys.argv[1:] == ["-p", "--output-format", "stream-json",
                    "--input-format", "stream-json", "--verbose"]:
    line = sys.stdin.readline()
    frame = json.loads(line)
    assert frame["type"] == "control_request", frame
    assert frame["request"]["subtype"] == "initialize", frame
    sys.stdout.write(json.dumps({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": frame["request_id"],
                     "response": {"models": __MODELS__}}}) + "\n")
    sys.stdout.flush()
    sys.exit(0)

cwd = os.getcwd()
scenario = open(os.path.join(cwd, "scenario")).read().strip()
resume = None
for arg in sys.argv[1:]:
    if arg.startswith("--resume="):
        resume = arg.split("=", 1)[1]

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

emit({"type": "system", "subtype": "init", "session_id": "native-1"})

def read_line_raw():
    # Read straight from fd 0: a BufferedReader readline can pull coalesced
    # later frames into userspace, which hides them from a subsequent select.
    data = bytearray()
    while True:
        chunk = os.read(0, 1)
        if not chunk or chunk == b"\n":
            break
        data.extend(chunk)
    return data.decode("utf-8", "replace")

line = read_line_raw()
with open(os.path.join(cwd, "turns.log"), "a") as log:
    log.write(("resume=" + str(resume)) + "\n")

def text_block(text):
    emit({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}})
    emit({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}}})
    emit({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}})

def result(error=None, reason=None, input_tokens=None, output_tokens=None, cost_usd=None):
    payload = {"type": "result", "subtype": "success", "is_error": bool(error)}
    if error:
        payload["errors"] = [error]
    if reason:
        payload["terminal_reason"] = reason
    if cost_usd is not None:
        payload["total_cost_usd"] = cost_usd
    if input_tokens is not None or output_tokens is not None:
        payload["usage"] = {}
        if input_tokens is not None:
            payload["usage"]["input_tokens"] = input_tokens
        if output_tokens is not None:
            payload["usage"]["output_tokens"] = output_tokens
    emit(payload)
    sys.stdout.flush()
    time.sleep(0.2)

if scenario == "chat":
    text_block("hello from fake claude")
    result()
elif scenario == "usage":
    text_block("usage counted")
    result(input_tokens=12, output_tokens=7, cost_usd=0.25)
elif scenario == "resume":
    text_block("second turn" if resume else "first turn")
    result()
elif scenario == "approval":
    emit({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "call_1", "name": "Bash", "input": {"command": "rm -rf /"}}]}})
    emit({"type": "control_request", "request_id": "req-1",
          "request": {"subtype": "can_use_tool", "tool_name": "Bash",
                      "input": {"command": "rm -rf /"}}})
    answer = sys.stdin.readline()
    allowed = '"allow"' in answer
    emit({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call_1",
         "is_error": not allowed,
         "content": "removed" if allowed else "denied by user"}]}})
    result()
elif scenario == "question":
    emit({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "call_q", "name": "AskUserQuestion",
         "input": {"questions": []}}]}})
    emit({"type": "control_request", "request_id": "req-q",
          "request": {"subtype": "can_use_tool", "tool_name": "AskUserQuestion",
                      "input": {"questions": [
                          {"header": "选择方案", "question": "用哪种方案",
                           "multiSelect": False,
                           "options": [{"label": "方案 A", "description": "更快"},
                                       {"label": "方案 B", "description": "更稳"}]},
                          {"header": "补充", "question": "还要什么",
                           "multiSelect": True,
                           "options": [{"label": "测试"}]}]}}})
    answer = sys.stdin.readline()
    with open(os.path.join(cwd, "answers.log"), "w") as log:
        log.write(answer)
    emit({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call_q",
         "is_error": '"deny"' in answer,
         "content": "question answered"}]}})
    result()
elif scenario == "interrupt":
    emit({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "call_1", "name": "Bash", "input": {"command": "sleep"}}]}})
    emit({"type": "control_request", "request_id": "req-9",
          "request": {"subtype": "can_use_tool", "tool_name": "Bash",
                      "input": {"command": "sleep"}}})
    while True:
        frame = sys.stdin.readline()
        if not frame:
            break
        if '"interrupt"' in frame:
            result(reason="aborted_streaming")
            break
elif scenario == "failure":
    result(error="boom")
elif scenario == "planflag":
    with open(os.path.join(cwd, "args.log"), "w") as log:
        log.write("\n".join(sys.argv[1:]))
    text_block("planned")
    result()
elif scenario == "modelflag":
    with open(os.path.join(cwd, "args.log"), "a") as log:
        log.write("\n".join(sys.argv[1:]) + "\n--\n")
    text_block("picked model")
    result()
elif scenario == "compact":
    frame = line
    if "/compact" not in frame:
        frame = read_line_raw()
    with open(os.path.join(cwd, "compact.log"), "w") as log:
        log.write(frame)
    if "/compact" in frame:
        emit({"type": "system", "subtype": "status", "compact_result": "success"})
    else:
        emit({"type": "system", "subtype": "status", "compact_result": "failed",
              "compact_error": "missing compact command"})
    result()
elif scenario == "setmodel":
    if resume is not None:
        # Chained turn: record argv so the test can prove the persisted
        # selection is applied via --model/--effort after --resume.
        with open(os.path.join(cwd, "args.log"), "a") as log:
            log.write("\n".join(sys.argv[1:]) + "\n--\n")
        text_block("second turn with switched model")
        result()
    else:
        captured = []
        def serve_controls():
            while True:
                raw = sys.stdin.readline()
                if not raw:
                    break
                frame = json.loads(raw)
                subtype = frame.get("request", {}).get("subtype")
                if subtype in ("set_model", "apply_flag_settings"):
                    captured.append(raw)
                    emit({"type": "control_response", "response": {
                        "subtype": "success",
                        "request_id": frame["request_id"], "response": {}}})
        import threading
        thread = threading.Thread(target=serve_controls, daemon=True)
        thread.start()
        text_block("working on it")
        time.sleep(1.5)
        with open(os.path.join(cwd, "controls.log"), "w") as log:
            log.write("".join(captured))
        result()
        time.sleep(0.5)
elif scenario == "subagent":
    # Main turn invokes the Task tool; the nested stream is attributed to the
    # task via parent_tool_use_id, exactly like the real headless CLI.
    emit({"type": "system", "subtype": "task_started", "task_id": "task-1",
          "tool_use_id": "toolu_1", "subagent_type": "Explore",
          "task_type": "search", "description": "find things",
          "prompt": "search the repo"})
    emit({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "toolu_1", "name": "Task",
         "input": {"description": "find things", "prompt": "search the repo"}}]}})
    emit({"type": "stream_event", "parent_tool_use_id": "toolu_1",
          "event": {"type": "content_block_start", "index": 0,
                    "content_block": {"type": "text", "text": ""}}})
    emit({"type": "stream_event", "parent_tool_use_id": "toolu_1",
          "event": {"type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": "subagent whispers"}}})
    emit({"type": "stream_event", "parent_tool_use_id": "toolu_1",
          "event": {"type": "content_block_stop", "index": 0}})
    emit({"type": "assistant", "parent_tool_use_id": "toolu_1",
          "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "call_sub", "name": "Bash",
         "input": {"command": "ls"}}]}})
    emit({"type": "user", "parent_tool_use_id": "toolu_1",
          "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "call_sub",
         "is_error": False, "content": "done"}]}})
    emit({"type": "system", "subtype": "task_progress", "task_id": "task-1",
          "summary": "halfway"})
    emit({"type": "system", "subtype": "task_notification", "task_id": "task-1",
          "status": "completed", "summary": "found things"})
    emit({"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "toolu_1",
         "is_error": False, "content": "task finished"}]}})
    result()
elif scenario == "backgroundtask":
    # A task without subagent_type (background shell task) is not a subagent:
    # its attributed stream stays on the main timeline and no card appears.
    emit({"type": "system", "subtype": "task_started", "task_id": "bg-1",
          "tool_use_id": "bgtool_1"})
    emit({"type": "stream_event", "parent_tool_use_id": "bgtool_1",
          "event": {"type": "content_block_start", "index": 0,
                    "content_block": {"type": "text", "text": ""}}})
    emit({"type": "stream_event", "parent_tool_use_id": "bgtool_1",
          "event": {"type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": "background output"}}})
    emit({"type": "stream_event", "parent_tool_use_id": "bgtool_1",
          "event": {"type": "content_block_stop", "index": 0}})
    emit({"type": "system", "subtype": "task_notification", "task_id": "bg-1",
          "status": "completed"})
    result()
elif scenario == "hang":
    with open(os.path.join(cwd, "fake.pid"), "w") as pid:
        pid.write(str(os.getpid()))
    time.sleep(30)
elif scenario == "queuedrain":
    # Each chained turn is a fresh process (with --resume); log every prompt
    # so tests can prove FIFO queue dispatch reached the CLI.
    with open(os.path.join(cwd, "prompts.log"), "a") as log:
        log.write(line + "\n")
    text_block("second turn" if resume else "first turn")
    result()
elif scenario == "steer":
    # After the opening prompt, keep reading stdin for extra user frames
    # (live steers) for a short window, then answer. Reads hit fd 0 directly so
    # no userspace buffer can hide coalesced frames from select.
    import select
    extras = []
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], 2.0)
        if not ready:
            break
        frame = read_line_raw()
        if not frame:
            break
        extras.append(frame)
    with open(os.path.join(cwd, "steered.log"), "w") as log:
        log.write("\n".join(extras))
    text_block("steered turn")
    result()
elif scenario == "pipeclosed":
    if resume:
        # Chained drain turn: consume the guide prompt normally.
        with open(os.path.join(cwd, "prompts.log"), "a") as log:
            log.write(line + "\n")
        text_block("drained guide")
        result()
    else:
        # Let the test submit an oversized steer: it fills the pipe and blocks
        # in the writer. Closing the read end then delivers EPIPE to that
        # blocked write *while this process is still alive*, so the runtime
        # deterministically falls back to the queue front before this turn
        # ends. (A small write would just sit in the kernel buffer.)
        open(os.path.join(cwd, "ready.flag"), "w").close()
        time.sleep(0.5)
        os.close(0)
        open(os.path.join(cwd, "closed.flag"), "w").close()
        time.sleep(2.0)
        text_block("closed turn")
        result()
elif scenario == "attach":
    # Log the initial user frame so the test can assert image blocks are
    # ordered images-first with the text block trailing.
    with open(os.path.join(cwd, "frame.log"), "w") as log:
        log.write(line)
    text_block("seen your images")
    result()
else:
    result(error="unknown scenario")
"#;

const FAKE_CODEX: &str = r#"#!/usr/bin/env python3
import json, os, sys, time

next_thread = "thread-created"
turn_id = "turn-native-1"
scenario = open(os.path.join(os.getcwd(), "scenario")).read().strip()
seen = []

def emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()

def respond(rpc_id, result):
    emit({"jsonrpc": "2.0", "id": rpc_id, "result": result})

for line in sys.stdin:
    if not line.strip():
        continue
    msg = json.loads(line)
    method = msg.get("method")
    rpc_id = msg.get("id")
    params = msg.get("params") or {}
    if method == "initialize":
        respond(rpc_id, {"protocolVersion": 1})
    elif method == "initialized":
        pass
    elif method == "thread/start":
        with open(os.path.join(os.getcwd(), "thread-start.json"), "w") as log:
            log.write(json.dumps(params))
        respond(rpc_id, {"thread": {"id": next_thread}})
    elif method == "thread/resume":
        respond(rpc_id, {"thread": {"id": params.get("threadId", "thread-resumed")}})
    elif method == "thread/read":
        with open(os.path.join(os.getcwd(), "thread-read.json"), "w") as log:
            log.write(json.dumps(params))
        if scenario != "codexhistory":
            respond(rpc_id, {})
            continue
        patch = "diff --git a/src/history.rs b/src/history.rs\nindex 000..111\n--- a/src/history.rs\n+++ b/src/history.rs\n@@ -1 +1,2 @@\n-old\n+new\n+line\n"
        respond(rpc_id, {"thread": {"id": params.get("threadId"), "parentThreadId": next_thread, "turns": [{"id": "sub-turn-history", "status": "completed", "items": [
            {"id": "u1", "type": "userMessage", "content": [{"type": "text", "text": "history prompt"}, {"type": "skill", "name": "audit"}]},
            {"id": "r1", "type": "reasoning", "summary": ["history thinking"]},
            {"id": "t1", "type": "commandExecution", "command": "pwd", "aggregatedOutput": "/tmp", "status": "completed"},
            {"id": "f1", "type": "fileChange", "status": "completed", "changes": [{"path": "src/history.rs", "diff": patch}]},
            {"id": "a1", "type": "agentMessage", "text": "history answer", "phase": "final_answer"}
        ]}]}})
    elif method == "turn/start":
        with open(os.path.join(os.getcwd(), "turn-start.json"), "w") as log:
            log.write(json.dumps(params))
        emit({"jsonrpc": "2.0", "method": "turn/started", "params": {"threadId": params.get("threadId"), "turn": {"id": turn_id}}})
        if scenario == "codexapproval":
            emit({"jsonrpc": "2.0", "method": "item/started", "params": {"threadId": params.get("threadId"), "item": {"id": "tool-1", "type": "commandExecution", "command": "echo ok"}}})
            emit({"jsonrpc": "2.0", "id": "approval-1", "method": "item/commandExecution/requestApproval", "params": {"threadId": params.get("threadId"), "itemId": "tool-1", "command": "echo ok"}})
            reply = json.loads(sys.stdin.readline())
            with open(os.path.join(os.getcwd(), "approval-response.json"), "w") as log:
                log.write(json.dumps(reply))
            emit({"jsonrpc": "2.0", "method": "item/completed", "params": {"threadId": params.get("threadId"), "item": {"id": "tool-1", "type": "commandExecution", "status": "completed", "aggregatedOutput": "ok"}}})
        if scenario == "codexquestion":
            emit({"jsonrpc": "2.0", "id": "question-req", "method": "item/tool/requestUserInput", "params": {"threadId": params.get("threadId"), "approvalId": "ask-1", "questions": [{"id": "q1", "header": "Pick", "question": "Choose", "options": [{"label": "A", "description": "Alpha"}], "multiSelect": True}]}})
            reply = json.loads(sys.stdin.readline())
            with open(os.path.join(os.getcwd(), "question-response.json"), "w") as log:
                log.write(json.dumps(reply))
        if scenario == "codexlegacyapproval":
            emit({"jsonrpc": "2.0", "id": 42, "method": "execCommandApproval", "params": {"threadId": params.get("threadId"), "callId": "legacy-call", "command": "pwd"}})
            reply = json.loads(sys.stdin.readline())
            with open(os.path.join(os.getcwd(), "legacy-approval-response.json"), "w") as log:
                log.write(json.dumps(reply))
        if scenario == "codexsubagent" or scenario == "codexhistory" or scenario == "codexsubsteer":
            emit({"jsonrpc": "2.0", "method": "item/started", "params": {"threadId": params.get("threadId"), "item": {"id": "collab-1", "type": "collabAgentToolCall", "receiverThreadId": "sub-thread-1", "prompt": "inspect repo"}}})
            emit({"jsonrpc": "2.0", "method": "thread/started", "params": {"threadId": "sub-thread-1", "thread": {"id": "sub-thread-1", "parentThreadId": params.get("threadId"), "agentNickname": "Scout", "agentRole": "Explore", "preview": "inspect repo", "status": "running"}}})
            if scenario == "codexsubsteer":
                emit({"jsonrpc": "2.0", "method": "turn/started", "params": {"threadId": "sub-thread-1", "turn": {"id": "sub-turn-live"}}})
            emit({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"threadId": "sub-thread-1", "itemId": "sub-msg-1", "delta": "subagent says hi"}})
            emit({"jsonrpc": "2.0", "method": "item/completed", "params": {"threadId": params.get("threadId"), "item": {"id": "collab-1", "type": "collabAgentToolCall", "status": "completed", "receiverThreadId": "sub-thread-1"}}})
            if scenario == "codexsubsteer":
                emit({"jsonrpc": "2.0", "method": "thread/status/changed", "params": {"threadId": "sub-thread-1", "status": "idle"}})
                steer = json.loads(sys.stdin.readline())
                with open(os.path.join(os.getcwd(), "subagent-steer.json"), "w") as log:
                    log.write(json.dumps(steer.get("params") or {}))
                respond(steer.get("id"), {})
        if scenario == "codexsubsend" and params.get("threadId") == next_thread:
            emit({"jsonrpc": "2.0", "method": "item/started", "params": {"threadId": params.get("threadId"), "item": {"id": "collab-1", "type": "collabAgentToolCall", "receiverThreadId": "sub-thread-1", "prompt": "inspect repo"}}})
            emit({"jsonrpc": "2.0", "method": "thread/started", "params": {"threadId": "sub-thread-1", "thread": {"id": "sub-thread-1", "parentThreadId": params.get("threadId"), "agentNickname": "Scout", "agentRole": "Explore", "preview": "inspect repo", "status": "idle"}}})
            respond(rpc_id, {"turn": {"id": turn_id}})
            continue
        if scenario == "codexsubsend" and params.get("threadId") == "sub-thread-1":
            with open(os.path.join(os.getcwd(), "subagent-turn.json"), "w") as log:
                log.write(json.dumps(params))
            emit({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"threadId": "sub-thread-1", "itemId": "sub-msg-2", "delta": "direct reply"}})
            respond(rpc_id, {"turn": {"id": "sub-turn-2"}})
            continue
        if scenario == "codexdiff":
            patch = "diff --git a/src/lib.rs b/src/lib.rs\nindex 000..111\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1,2 @@\n-old\n+new\n+line\n"
            emit({"jsonrpc": "2.0", "method": "item/started", "params": {"threadId": params.get("threadId"), "item": {"id": "edit-1", "type": "fileChange", "changes": [{"path": "src/lib.rs", "diff": patch}]}}})
            emit({"jsonrpc": "2.0", "method": "item/fileChange/patchUpdated", "params": {"threadId": params.get("threadId"), "itemId": "edit-1", "path": "src/lib.rs", "patch": patch}})
            emit({"jsonrpc": "2.0", "method": "item/completed", "params": {"threadId": params.get("threadId"), "item": {"id": "edit-1", "type": "fileChange", "status": "completed", "changes": [{"path": "src/lib.rs", "diff": patch}]}}})
            emit({"jsonrpc": "2.0", "method": "turn/diff/updated", "params": {"threadId": params.get("threadId"), "turnId": turn_id, "diff": patch}})
        emit({"jsonrpc": "2.0", "method": "item/agentMessage/delta", "params": {"threadId": params.get("threadId"), "itemId": "msg-1", "delta": "hello "}})
        emit({"jsonrpc": "2.0", "method": "item/reasoning/textDelta", "params": {"threadId": params.get("threadId"), "itemId": "think-1", "delta": "thinking"}})
        emit({"jsonrpc": "2.0", "method": "item/completed", "params": {"threadId": params.get("threadId"), "item": {"id": "msg-1", "type": "agentMessage", "text": "hello from fake codex"}}})
        emit({"jsonrpc": "2.0", "method": "thread/tokenUsage/updated", "params": {"threadId": params.get("threadId"), "tokenUsage": {"last": {"inputTokens": 3, "outputTokens": 5}}}})
        emit({"jsonrpc": "2.0", "method": "turn/completed", "params": {"threadId": params.get("threadId"), "turn": {"id": turn_id, "status": "completed"}}})
        respond(rpc_id, {"turn": {"id": turn_id}})
        time.sleep(0.1)
        break
    elif method == "turn/steer":
        with open(os.path.join(os.getcwd(), "subagent-steer.json"), "w") as log:
            log.write(json.dumps(params))
        respond(rpc_id, {})
    elif method == "model/list":
        respond(rpc_id, {"data": [{"model": "gpt-test", "displayName": "GPT Test", "supportedReasoningEfforts": ["low", "high"], "isDefault": True}]})
    else:
        respond(rpc_id, {})
"#;

struct Harness {
    _data: TempDir,
    workspace: TempDir,
    database: Database,
    agents: Agents,
}

impl Harness {
    async fn new(scenario: &str) -> Self {
        let data = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        std::fs::write(workspace.path().join("scenario"), scenario).unwrap();
        let cli = data.path().join("fake-claude.py");
        std::fs::write(&cli, FAKE_CLI.replace("__MODELS__", CATALOG_MODELS)).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        unsafe {
            std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
        }
        let database = Database::open(data.path().to_path_buf()).await.unwrap();
        let agents = Agents::new(database.clone());
        Self {
            _data: data,
            workspace,
            database,
            agents,
        }
    }

    async fn create(&self) -> prosperod_rs::protocol::SessionHead {
        self.agents
            .create(CreateAgentSession {
                agent: prosperod_rs::protocol::AgentKind::Claude,
                title: "Agent test".into(),
                workspace: self.workspace.path().to_str().unwrap().into(),
                auto_approve: false,
                mode: None,
                model: None,
                effort: None,
                account_id: None,
                resume: None,
            })
            .await
            .unwrap()
    }

    async fn create_codex(&self) -> prosperod_rs::protocol::SessionHead {
        self.agents
            .create(CreateAgentSession {
                agent: prosperod_rs::protocol::AgentKind::Codex,
                title: "Codex test".into(),
                workspace: self.workspace.path().to_str().unwrap().into(),
                auto_approve: false,
                mode: Some("plan".into()),
                model: Some("gpt-test".into()),
                effort: Some("high".into()),
                account_id: Some("native-codex".into()),
                resume: None,
            })
            .await
            .unwrap()
    }

    async fn records(&self, id: &str) -> Vec<(String, TimelineBody, String)> {
        let id = id.to_owned();
        self.database
            .call(move |store| {
                let page = store.timeline(&id, TimelineQuery::default())?;
                Ok(page
                    .items
                    .into_iter()
                    .map(|record| (record.id, record.body, record.preview))
                    .collect::<Vec<_>>())
            })
            .await
            .unwrap()
    }

    async fn status(&self, id: &str) -> prosperod_rs::protocol::SessionStatus {
        let id = id.to_owned();
        self.database
            .call(move |store| Ok(store.session(&id)?.status))
            .await
            .unwrap()
    }

    async fn wait_for(
        &self,
        id: &str,
        predicate: impl Fn(&[(String, TimelineBody, String)]) -> bool,
    ) -> Vec<(String, TimelineBody, String)> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let records = self.records(id).await;
            if predicate(&records) {
                return records;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "timeline predicate timed out"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        unsafe {
            std::env::remove_var("PROSPERO_CLAUDE_BIN");
            std::env::remove_var("PROSPERO_CODEX_BIN");
        }
    }
}

#[tokio::test]
async fn single_turn_streams_into_timeline() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("chat").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "hi".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    assert!(records.iter().any(|(id, body, _)| matches!(
        body,
        TimelineBody::Message {
            role: prosperod_rs::protocol::MessageRole::User,
            ..
        }
    ) && id.ends_with("-user")));
    assert!(records.iter().any(|(_, body, preview)| matches!(
        body,
        TimelineBody::Message {
            role: prosperod_rs::protocol::MessageRole::Assistant,
            ..
        }
    ) && preview == "hello from fake claude"));
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::Idle
    );
}

#[tokio::test]
async fn codex_structured_turn_streams_into_timeline() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("chat").await;
    let cli = harness.workspace.path().join("fake-codex.py");
    std::fs::write(&cli, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
    }
    let head = harness.create_codex().await;
    harness
        .agents
        .send(&head.id, "hi codex".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            })
        })
        .await;
    assert!(records.iter().any(|(id, body, preview)| matches!(
        body,
        TimelineBody::Message {
            role: prosperod_rs::protocol::MessageRole::User,
            ..
        }
    ) && id.ends_with("-user")
        && preview == "hi codex"));
    assert!(records.iter().any(|(_, body, preview)| matches!(
        body,
        TimelineBody::Message {
            role: prosperod_rs::protocol::MessageRole::Assistant,
            ..
        }
    ) && preview == "hello from fake codex"));
    assert!(records.iter().any(|(_, body, preview)| {
        matches!(body, TimelineBody::Reasoning) && preview == "thinking"
    }));
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::Idle
    );
    let turn_start: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(harness.workspace.path().join("turn-start.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(turn_start["model"], "gpt-test");
    assert_eq!(turn_start["effort"], "high");
    assert_eq!(turn_start["collaborationMode"]["mode"], "plan");
}

#[tokio::test]
async fn codex_permission_roundtrip_responds_to_app_server() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("codexapproval").await;
    let cli = harness.workspace.path().join("fake-codex.py");
    std::fs::write(&cli, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
    }
    let head = harness.create_codex().await;
    harness
        .agents
        .send(&head.id, "needs approval".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::PermissionRequest {
                        resolved: false,
                        ..
                    }
                )
            })
        })
        .await;
    let request_id = records
        .iter()
        .find_map(|(_, body, _)| match body {
            TimelineBody::PermissionRequest {
                request_id,
                resolved: false,
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(request_id, "tool-1");
    harness
        .agents
        .respond_permission(&head.id, &request_id, true)
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            })
        })
        .await;
    assert!(records.iter().any(|(_, body, preview)| matches!(
        body,
        TimelineBody::PermissionRequest {
            tool,
            resolved: true,
            ..
        } if tool == "commandExecution"
    ) && preview.contains("运行命令:echo ok")));
    assert!(records.iter().any(|(_, body, preview)| matches!(
        body,
        TimelineBody::Tool {
            state: prosperod_rs::protocol::ToolState::Success,
            ..
        }
    ) && preview == "ok"));
    let response: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(harness.workspace.path().join("approval-response.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(response["id"], "approval-1");
    assert_eq!(response["result"]["decision"], "accept");
}

#[tokio::test]
async fn codex_question_roundtrip_responds_to_app_server() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("codexquestion").await;
    let cli = harness.workspace.path().join("fake-codex.py");
    std::fs::write(&cli, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
    }
    let head = harness.create_codex().await;
    harness
        .agents
        .send(&head.id, "needs input".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::Question {
                        resolved: false,
                        ..
                    }
                )
            })
        })
        .await;
    let request_id = records
        .iter()
        .find_map(|(_, body, _)| match body {
            TimelineBody::Question {
                request_id,
                questions,
                resolved: false,
                ..
            } => {
                assert_eq!(questions[0].id, "q1");
                assert_eq!(questions[0].question, "Choose");
                Some(request_id.clone())
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(request_id, "ask-1");
    harness
        .agents
        .respond_question(
            &head.id,
            &request_id,
            vec![prosperod_rs::agent::QuestionAnswer {
                question_id: "q1".into(),
                values: vec!["A".into(), "custom".into()],
            }],
            false,
        )
        .await
        .unwrap();

    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            })
        })
        .await;
    let response: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(harness.workspace.path().join("question-response.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(response["id"], "question-req");
    assert_eq!(response["result"]["answers"]["q1"]["answers"][0], "A");
    assert_eq!(response["result"]["answers"]["q1"]["answers"][1], "custom");
}

#[tokio::test]
async fn codex_collab_agent_events_create_subagent_timeline() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("codexsubagent").await;
    let cli = harness.workspace.path().join("fake-codex.py");
    std::fs::write(&cli, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
    }
    let head = harness.create_codex().await;
    harness
        .agents
        .send(&head.id, "spawn codex subagent".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            })
        })
        .await;
    assert!(records.iter().any(|(_, body, _)| matches!(
        body,
        TimelineBody::Subagent {
            subagent_id,
            name,
            status,
            ..
        } if subagent_id == "sub-thread-1" && name == "Scout" && status == "completed"
    )));
    assert!(
        !records.iter().any(|(_, body, preview)| matches!(
            body,
            TimelineBody::Message {
                role: prosperod_rs::protocol::MessageRole::Assistant,
                ..
            }
        ) && preview == "subagent says hi"),
        "subagent transcript stays collapsed behind the card"
    );
    let detail = harness
        .agents
        .subagent_snapshot(&head.id, "sub-thread-1")
        .await
        .unwrap();
    assert!(
        detail
            .events
            .iter()
            .any(|event| event.to_string().contains("subagent says hi"))
    );
}

#[tokio::test]
async fn codex_subagent_snapshot_uses_thread_read_history() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("codexhistory").await;
    let cli = harness.workspace.path().join("fake-codex.py");
    std::fs::write(&cli, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
    }
    let head = harness.create_codex().await;
    harness
        .agents
        .send(&head.id, "spawn codex subagent".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            })
        })
        .await;

    let detail = harness
        .agents
        .subagent_snapshot(&head.id, "sub-thread-1")
        .await
        .unwrap();
    let raw = detail
        .events
        .iter()
        .map(|event| event.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(raw.contains("history prompt"));
    assert!(raw.contains("history thinking"));
    assert!(raw.contains("history answer"));
    assert!(raw.contains("src/history.rs"));
    assert!(raw.contains("turn.end"));
    let request: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(harness.workspace.path().join("thread-read.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(request["threadId"], "sub-thread-1");
    assert_eq!(request["includeTurns"], true);
}

#[tokio::test]
async fn codex_legacy_approval_uses_call_id_and_review_decision_shape() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("codexlegacyapproval").await;
    let cli = harness.workspace.path().join("fake-codex.py");
    std::fs::write(&cli, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
    }
    let head = harness.create_codex().await;
    harness
        .agents
        .send(&head.id, "legacy approval".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::PermissionRequest {
                        resolved: false,
                        ..
                    }
                )
            })
        })
        .await;
    let request_id = records
        .iter()
        .find_map(|(_, body, _)| match body {
            TimelineBody::PermissionRequest {
                request_id,
                resolved: false,
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(request_id, "legacy-call");
    harness
        .agents
        .respond_permission(&head.id, &request_id, true)
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            })
        })
        .await;
    let response: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            harness
                .workspace
                .path()
                .join("legacy-approval-response.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(response["id"], 42);
    assert_eq!(response["result"]["decision"], "approved");
}

#[tokio::test]
async fn codex_file_changes_attach_diffs_to_tool_and_turn_end() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("codexdiff").await;
    let cli = harness.workspace.path().join("fake-codex.py");
    std::fs::write(&cli, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
    }
    let head = harness.create_codex().await;
    harness
        .agents
        .send(&head.id, "edit file".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            })
        })
        .await;
    let tool_diff = records
        .iter()
        .find_map(|(_, body, _)| match body {
            TimelineBody::Tool {
                state: prosperod_rs::protocol::ToolState::Success,
                diff: Some(diff),
                ..
            } => Some(diff),
            _ => None,
        })
        .unwrap();
    assert_eq!(tool_diff.path, "src/lib.rs");
    assert_eq!(tool_diff.additions, 2);
    assert_eq!(tool_diff.deletions, 1);
    assert!(tool_diff.patch.contains("+new"));
    let turn_diffs = records
        .iter()
        .find_map(|(_, body, _)| match body {
            TimelineBody::TurnEnd { diffs, .. } => Some(diffs),
            _ => None,
        })
        .unwrap();
    assert_eq!(turn_diffs.len(), 1);
    assert_eq!(turn_diffs[0].path, "src/lib.rs");
}

#[tokio::test]
async fn codex_send_to_subagent_posts_turn_start_to_child_thread() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("codexsubsend").await;
    let cli = harness.workspace.path().join("fake-codex.py");
    std::fs::write(&cli, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
    }
    let head = harness.create_codex().await;
    harness
        .agents
        .send(&head.id, "spawn child".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::Subagent {
                        subagent_id,
                        can_message: true,
                        ..
                    } if subagent_id == "sub-thread-1"
                )
            })
        })
        .await;
    harness
        .agents
        .send_to_subagent(&head.id, "sub-thread-1", "hello child".into())
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(raw) =
            std::fs::read_to_string(harness.workspace.path().join("subagent-turn.json"))
        {
            let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(value["threadId"], "sub-thread-1");
            assert_eq!(value["input"][0]["text"], "hello child");
            assert_eq!(value["model"], "gpt-test");
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "subagent turn not sent"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn codex_send_to_subagent_steers_live_child_turn() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("codexsubsteer").await;
    let cli = harness.workspace.path().join("fake-codex.py");
    std::fs::write(&cli, FAKE_CODEX).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CODEX_BIN", &cli);
    }
    let head = harness.create_codex().await;
    harness
        .agents
        .send(&head.id, "spawn live child".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::Subagent { subagent_id, can_message: true, .. } if subagent_id == "sub-thread-1")
            })
        })
        .await;
    harness
        .agents
        .send_to_subagent(&head.id, "sub-thread-1", "steer child".into())
        .await
        .unwrap();
    let raw =
        std::fs::read_to_string(harness.workspace.path().join("subagent-steer.json")).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["threadId"], "sub-thread-1");
    assert_eq!(value["expectedTurnId"], "sub-turn-live");
    assert_eq!(value["input"][0]["text"], "steer child");
    assert!(!harness.workspace.path().join("subagent-turn.json").exists());
}

#[tokio::test]
async fn multi_turn_resumes_native_session() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("resume").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "one".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    harness
        .agents
        .send(&head.id, "two".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records
                .iter()
                .filter(|(_, body, _)| matches!(body, TimelineBody::TurnEnd { .. }))
                .count()
                == 2
        })
        .await;
    assert!(
        harness
            .records(&head.id)
            .await
            .iter()
            .any(|(_, body, preview)| matches!(
                body,
                TimelineBody::Message {
                    role: prosperod_rs::protocol::MessageRole::Assistant,
                    ..
                }
            ) && preview == "second turn")
    );
    let log = std::fs::read_to_string(harness.workspace.path().join("turns.log")).unwrap();
    let turns: Vec<&str> = log.lines().collect();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0], "resume=None");
    assert_eq!(turns[1], "resume=native-1");
}

#[tokio::test]
async fn launch_resume_uses_native_session_id() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("resume").await;
    let head = harness
        .agents
        .create(CreateAgentSession {
            agent: prosperod_rs::protocol::AgentKind::Claude,
            title: "Fallback title".into(),
            workspace: harness.workspace.path().to_str().unwrap().into(),
            auto_approve: false,
            mode: None,
            model: None,
            effort: None,
            account_id: None,
            resume: Some(ResumeInput {
                id: "existing-native".into(),
                title: Some("Resumed title".into()),
                fork: None,
            }),
        })
        .await
        .unwrap();
    assert_eq!(head.title, "Resumed title");
    harness
        .agents
        .send(&head.id, "continue".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    let log = std::fs::read_to_string(harness.workspace.path().join("turns.log")).unwrap();
    assert_eq!(
        log.lines().collect::<Vec<_>>(),
        vec!["resume=existing-native"]
    );
    assert!(
        harness
            .records(&head.id)
            .await
            .iter()
            .any(|(_, body, preview)| matches!(
                body,
                TimelineBody::Message {
                    role: prosperod_rs::protocol::MessageRole::Assistant,
                    ..
                }
            ) && preview == "second turn")
    );
}

#[tokio::test]
async fn launch_resume_rejects_fork() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("resume").await;
    let err = harness
        .agents
        .create(CreateAgentSession {
            agent: prosperod_rs::protocol::AgentKind::Claude,
            title: "Fork".into(),
            workspace: harness.workspace.path().to_str().unwrap().into(),
            auto_approve: false,
            mode: None,
            model: None,
            effort: None,
            account_id: None,
            resume: Some(ResumeInput {
                id: "existing-native".into(),
                title: None,
                fork: Some(true),
            }),
        })
        .await
        .unwrap_err();
    assert!(matches!(err, prosperod_rs::error::Error::Conflict));
}

#[tokio::test]
async fn permission_roundtrip_executes_tool() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("approval").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "go".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::PermissionRequest { resolved, .. } if !resolved
                )
            })
        })
        .await;
    let request_id = records
        .iter()
        .find_map(|(_, body, _)| match body {
            TimelineBody::PermissionRequest {
                request_id,
                resolved: false,
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::WaitingPermission
    );
    harness
        .agents
        .respond_permission(&head.id, &request_id, true)
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    assert!(records.iter().any(|(_, body, _)| matches!(
        body,
        TimelineBody::PermissionRequest { resolved, tool, .. } if *resolved && tool == "Bash"
    )));
    assert!(records.iter().any(|(_, body, preview)| matches!(
        body,
        TimelineBody::Tool {
            state: prosperod_rs::protocol::ToolState::Success,
            ..
        }
    ) && preview == "removed"));
}

#[tokio::test]
async fn approval_policy_set_auto_allows_future_turns() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("approval").await;
    let head = harness.create().await;
    harness
        .agents
        .set_approval_policy(&head.id, ApprovalPolicy::Auto)
        .await
        .unwrap();
    harness
        .agents
        .send(&head.id, "go".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            })
        })
        .await;
    assert!(records.iter().any(|(_, body, preview)| {
        matches!(
            body,
            TimelineBody::Tool {
                state: prosperod_rs::protocol::ToolState::Success,
                ..
            }
        ) && preview == "removed"
    }));
    assert!(
        !records
            .iter()
            .any(|(_, body, _)| { matches!(body, TimelineBody::PermissionRequest { .. }) })
    );
}

#[tokio::test]
async fn question_roundtrip_sends_native_answers() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("question").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "go".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(
                |(_, body, _)| matches!(body, TimelineBody::Question { resolved, .. } if !resolved),
            )
        })
        .await;
    let (request_id, questions) = records
        .iter()
        .find_map(|(_, body, _)| match body {
            TimelineBody::Question {
                request_id,
                questions,
                resolved: false,
                ..
            } => Some((request_id.clone(), questions.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(questions.len(), 2);
    assert_eq!(questions[0].id, "q1");
    assert_eq!(questions[0].question, "用哪种方案");
    assert_eq!(questions[0].options.len(), 2);
    assert!(!questions[0].multi_select);
    assert!(questions[0].allow_other);
    assert!(questions[1].multi_select);
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::WaitingInput
    );

    harness
        .agents
        .respond_question(
            &head.id,
            &request_id,
            vec![
                prosperod_rs::agent::QuestionAnswer {
                    question_id: "q1".into(),
                    values: vec!["方案 A".into()],
                },
                prosperod_rs::agent::QuestionAnswer {
                    question_id: "q2".into(),
                    values: vec!["测试".into(), "自定义".into()],
                },
            ],
            false,
        )
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    assert!(
        records.iter().any(
            |(_, body, _)| matches!(body, TimelineBody::Question { resolved, .. } if *resolved)
        )
    );

    // The CLI must receive answers keyed by the native question text, with
    // multi-select values joined exactly like the legacy adapter.
    let answers = std::fs::read_to_string(harness.workspace.path().join("answers.log")).unwrap();
    assert!(answers.contains(r#""用哪种方案":"方案 A""#), "{answers}");
    assert!(
        answers.contains(r#""还要什么":"测试, 自定义""#),
        "{answers}"
    );
}

#[tokio::test]
async fn question_cancel_allows_with_empty_answers() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("question").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "go".into(), None, Vec::new())
        .await
        .unwrap();
    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::Question {
                        resolved: false,
                        ..
                    }
                )
            })
        })
        .await;
    let request_id = records
        .iter()
        .find_map(|(_, body, _)| match body {
            TimelineBody::Question {
                request_id,
                resolved: false,
                ..
            } => Some(request_id.clone()),
            _ => None,
        })
        .unwrap();
    harness
        .agents
        .respond_question(&head.id, &request_id, vec![], true)
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    // Cancellation still allows the tool call; the answers map is empty.
    let answers = std::fs::read_to_string(harness.workspace.path().join("answers.log")).unwrap();
    assert!(answers.contains(r#""behavior":"allow""#), "{answers}");
    assert!(answers.contains(r#""answers":{}"#), "{answers}");
    assert!(!answers.contains(r#""behavior":"deny""#), "{answers}");
}

#[tokio::test]
async fn interrupt_resolves_pending_question() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("question").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "go".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::Question {
                        resolved: false,
                        ..
                    }
                )
            })
        })
        .await;
    harness.agents.interrupt(&head.id).await.unwrap();
    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(
                |(_, body, _)| matches!(body, TimelineBody::Question { resolved, .. } if *resolved),
            )
        })
        .await;
    // The dropped callback makes the translator deny the tool call. The deny
    // frame is written to the CLI just after the resolve marker lands, so poll
    // for its log instead of racing the writer.
    let answer_path = harness.workspace.path().join("answers.log");
    let answers = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(answers) = std::fs::read_to_string(&answer_path)
                && answers.contains(r#""behavior":"deny""#)
            {
                break answers;
            }
            assert!(tokio::time::Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    assert!(answers.contains(r#""behavior":"deny""#), "{answers}");
    assert!(
        records
            .iter()
            .any(|(_, body, _)| matches!(body, TimelineBody::Question { resolved: true, .. }))
    );
}

#[tokio::test]
async fn interrupt_rejects_permission_and_marks_turn_interrupted() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("interrupt").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "go".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::PermissionRequest {
                        resolved: false,
                        ..
                    }
                )
            })
        })
        .await;
    harness.agents.interrupt(&head.id).await.unwrap();
    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "interrupted"
                )
            })
        })
        .await;
    assert!(records.iter().any(|(_, body, _)| matches!(
        body,
        TimelineBody::PermissionRequest { resolved: true, .. }
    )));
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::Idle
    );
}

#[tokio::test]
async fn provider_failure_marks_turn_and_session_failed() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("failure").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "go".into(), None, Vec::new())
        .await
        .unwrap();
    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "failed"
                )
            })
        })
        .await;
    assert!(
        records
            .iter()
            .any(|(_, body, preview)| matches!(body, TimelineBody::Error) && preview == "boom")
    );
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::Failed
    );
}

#[tokio::test]
async fn recovery_archives_active_run_without_replaying_turn() {
    let _guard = SERIAL.lock().await;
    let data = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    std::fs::write(workspace.path().join("scenario"), "hang").unwrap();
    let cli = data.path().join("fake-claude.py");
    std::fs::write(&cli, FAKE_CLI).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    unsafe {
        std::env::set_var("PROSPERO_CLAUDE_BIN", &cli);
    }
    let database = Database::open(data.path().to_path_buf()).await.unwrap();
    let agents = Agents::new(database.clone());
    let head = agents
        .create(CreateAgentSession {
            agent: prosperod_rs::protocol::AgentKind::Claude,
            title: "Recovery".into(),
            workspace: workspace.path().to_str().unwrap().into(),
            auto_approve: false,
            mode: None,
            model: None,
            effort: None,
            account_id: None,
            resume: None,
        })
        .await
        .unwrap();
    agents
        .send(&head.id, "go".into(), None, Vec::new())
        .await
        .unwrap();
    let pid_path = workspace.path().join("fake.pid");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !pid_path.exists() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Daemon shuts down (SIGKILL to the process group) while a turn runs.
    agents.shutdown().await.unwrap();
    database.shutdown().await.unwrap();

    // A fresh daemon recovers: the run must be archived, never replayed.
    let database = Database::open(data.path().to_path_buf()).await.unwrap();
    let agents = Agents::new(database.clone());
    let recovered = agents.recover().await.unwrap();
    assert_eq!(recovered, 1);
    let id = head.id.clone();
    let stored = database
        .call(move |store| store.session(&id))
        .await
        .unwrap();
    assert_eq!(
        stored.lifecycle,
        prosperod_rs::protocol::SessionLifecycle::Archived
    );
    assert_eq!(stored.status, prosperod_rs::protocol::SessionStatus::Failed);
    let log = std::fs::read_to_string(workspace.path().join("turns.log")).unwrap();
    assert_eq!(log.lines().count(), 1);
    unsafe {
        std::env::remove_var("PROSPERO_CLAUDE_BIN");
    }
}

#[tokio::test]
async fn plan_mode_is_persisted_and_passed_to_the_cli() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("planflag").await;
    let head = harness.create().await;

    // The catalog starts on default; switching to plan persists immediately.
    assert_eq!(
        harness.agents.mode(&head.id).await.unwrap(),
        PermissionMode::Default
    );
    harness
        .agents
        .set_mode(&head.id, PermissionMode::Plan)
        .await
        .unwrap();
    assert_eq!(
        harness.agents.mode(&head.id).await.unwrap(),
        PermissionMode::Plan
    );
    harness
        .agents
        .send(&head.id, "plan this".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    let planned_args = std::fs::read_to_string(harness.workspace.path().join("args.log")).unwrap();
    let planned: Vec<&str> = planned_args.lines().collect();
    assert!(
        planned
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "plan"]),
        "plan turn must carry --permission-mode plan: {planned:?}"
    );

    // Back to default: the next resumed turn must not carry the flag.
    harness
        .agents
        .set_mode(&head.id, PermissionMode::Default)
        .await
        .unwrap();
    harness
        .agents
        .send(&head.id, "now do it".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records
                .iter()
                .filter(|(_, body, _)| matches!(body, TimelineBody::TurnEnd { .. }))
                .count()
                == 2
        })
        .await;
    let default_args = std::fs::read_to_string(harness.workspace.path().join("args.log")).unwrap();
    assert!(
        !default_args.contains("--permission-mode"),
        "default turn must not carry a permission-mode flag: {default_args:?}"
    );
}

#[tokio::test]
async fn launch_model_and_effort_are_passed_on_every_turn() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("modelflag").await;
    let head = harness
        .agents
        .create(CreateAgentSession {
            agent: prosperod_rs::protocol::AgentKind::Claude,
            title: "Model pick".into(),
            workspace: harness.workspace.path().to_str().unwrap().into(),
            auto_approve: false,
            mode: None,
            model: Some("opus[1m]".into()),
            effort: Some("high".into()),
            account_id: None,
            resume: None,
        })
        .await
        .unwrap();
    harness
        .agents
        .send(&head.id, "first".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    // The chained, resumed turn must carry the same launch selection.
    harness
        .agents
        .send(&head.id, "second".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records
                .iter()
                .filter(|(_, body, _)| matches!(body, TimelineBody::TurnEnd { .. }))
                .count()
                == 2
        })
        .await;
    let args = std::fs::read_to_string(harness.workspace.path().join("args.log")).unwrap();
    let invocations: Vec<&str> = args
        .split("--\n")
        .filter(|part| !part.trim().is_empty())
        .collect();
    assert_eq!(invocations.len(), 2, "expected two logged turns: {args:?}");
    for invocation in invocations {
        let argv: Vec<&str> = invocation.lines().collect();
        assert!(
            argv.windows(2).any(|pair| pair == ["--model", "opus[1m]"]),
            "turn must carry --model: {argv:?}"
        );
        assert!(
            argv.windows(2).any(|pair| pair == ["--effort", "high"]),
            "turn must carry --effort: {argv:?}"
        );
    }
}

#[tokio::test]
async fn launch_plan_mode_is_applied_on_first_turn() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("planflag").await;
    let head = harness
        .agents
        .create(CreateAgentSession {
            agent: prosperod_rs::protocol::AgentKind::Claude,
            title: "Plan launch".into(),
            workspace: harness.workspace.path().to_str().unwrap().into(),
            auto_approve: false,
            mode: Some("plan".into()),
            model: None,
            effort: None,
            account_id: None,
            resume: None,
        })
        .await
        .unwrap();
    assert_eq!(
        harness.agents.mode(&head.id).await.unwrap(),
        PermissionMode::Plan
    );
    harness
        .agents
        .send(&head.id, "plan first".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    let args = std::fs::read_to_string(harness.workspace.path().join("args.log")).unwrap();
    let argv: Vec<&str> = args.lines().collect();
    assert!(
        argv.windows(2)
            .any(|pair| pair == ["--permission-mode", "plan"]),
        "launch-time plan mode must carry --permission-mode plan: {argv:?}"
    );
}

#[tokio::test]
async fn invalid_launch_selection_is_rejected() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("chat").await;
    for (index, (model, effort)) in [
        (Some(" ".into()), None),
        (Some("x".repeat(161)), None),
        (None, Some("high\n".into())),
        (None, Some("x".repeat(81))),
    ]
    .into_iter()
    .enumerate()
    {
        let result = harness
            .agents
            .create(CreateAgentSession {
                agent: prosperod_rs::protocol::AgentKind::Claude,
                title: "Bad selection".into(),
                workspace: harness.workspace.path().to_str().unwrap().into(),
                auto_approve: false,
                mode: None,
                model,
                effort,
                account_id: None,
                resume: None,
            })
            .await;
        assert!(result.is_err(), "case {index} must be rejected");
    }
}

#[tokio::test]
async fn invalid_launch_mode_is_rejected() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("chat").await;
    let result = harness
        .agents
        .create(CreateAgentSession {
            agent: prosperod_rs::protocol::AgentKind::Claude,
            title: "Bad mode".into(),
            workspace: harness.workspace.path().to_str().unwrap().into(),
            auto_approve: false,
            mode: Some("apply".into()),
            model: None,
            effort: None,
            account_id: None,
            resume: None,
        })
        .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn in_session_models_combines_catalog_with_persisted_selection() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("chat").await;
    let picked = harness
        .agents
        .create(CreateAgentSession {
            agent: prosperod_rs::protocol::AgentKind::Claude,
            title: "Picked".into(),
            workspace: harness.workspace.path().to_str().unwrap().into(),
            auto_approve: false,
            mode: None,
            model: Some("opus[1m]".into()),
            effort: Some("high".into()),
            account_id: None,
            resume: None,
        })
        .await
        .unwrap();
    let catalog = harness.agents.models(&picked.id).await.unwrap();
    assert_eq!(catalog.models.len(), 2);
    assert_eq!(catalog.current_model.as_deref(), Some("opus[1m]"));
    assert_eq!(catalog.current_effort.as_deref(), Some("high"));
    assert!(catalog.models[0].is_default);

    // A session without a launch selection defaults the marker to catalog[0].
    let plain = harness.create().await;
    let catalog = harness.agents.models(&plain.id).await.unwrap();
    assert_eq!(catalog.current_model.as_deref(), Some("default"));
    assert_eq!(catalog.current_effort, None);

    let controls = harness.agents.controls().await.unwrap();
    let picked_controls = controls
        .controls
        .iter()
        .find(|item| item.session_id == picked.id)
        .unwrap();
    assert!(picked_controls.model);
    assert!(picked_controls.mode);
    assert!(picked_controls.compact);
    assert_eq!(picked_controls.current_model.as_deref(), Some("opus[1m]"));
    assert_eq!(picked_controls.current_effort.as_deref(), Some("high"));
    assert_eq!(picked_controls.current_mode.as_deref(), Some("default"));
}

#[tokio::test]
async fn compact_sends_slash_command_and_records_compact_finish() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("compact").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "start".into(), None, Vec::new())
        .await
        .unwrap();

    let result = harness
        .agents
        .compact(&head.id, "compact-req")
        .await
        .unwrap();
    let raw = std::fs::read_to_string(harness.workspace.path().join("compact.log")).unwrap();
    assert!(result.ok, "{result:?}; raw={raw:?}");
    assert_eq!(result.kind, "agent.control.result");
    assert_eq!(result.action, "compact");
    assert_eq!(result.request_id, "compact-req");
    assert!(raw.contains("/compact"), "compact command not sent: {raw}");

    let records = harness
        .wait_for(&head.id, |records| {
            let compact = records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "compact")
            });
            let completed = records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            });
            compact && completed
        })
        .await;
    assert!(records.iter().any(|(_, body, _)| {
        matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "compact")
    }));
}

#[tokio::test]
async fn set_model_validates_persists_and_forwards_to_live_turn() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("setmodel").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "do the thing".into(), None, Vec::new())
        .await
        .unwrap();
    // Switch while the fake CLI's first turn is still running.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if harness.status(&head.id).await == prosperod_rs::protocol::SessionStatus::Running {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let result = harness
        .agents
        .set_model(&head.id, "opus[1m]".into(), Some("high".into()))
        .await
        .unwrap();
    assert_eq!(result.current_model, "opus[1m]");
    assert_eq!(result.current_effort.as_deref(), Some("high"));
    harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed")
            })
        })
        .await;
    // The live turn received the native control requests verbatim.
    let controls = std::fs::read_to_string(harness.workspace.path().join("controls.log")).unwrap();
    assert!(
        controls.contains("\"subtype\":\"set_model\""),
        "{controls:?}"
    );
    assert!(controls.contains("\"model\":\"opus[1m]\""), "{controls:?}");
    assert!(
        controls.contains("\"subtype\":\"apply_flag_settings\"")
            && controls.contains("\"effortLevel\":\"high\""),
        "{controls:?}"
    );

    // The persisted selection applies to the chained resumed turn via argv.
    harness
        .agents
        .send(&head.id, "again".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .wait_for(&head.id, |records| {
            records
                .iter()
                .filter(|(_, body, _)| matches!(body, TimelineBody::TurnEnd { .. }))
                .count()
                == 2
        })
        .await;
    let args = std::fs::read_to_string(harness.workspace.path().join("args.log")).unwrap();
    let argv: Vec<&str> = args
        .lines()
        .filter(|line| !line.is_empty() && *line != "--")
        .collect();
    assert!(
        argv.windows(2).any(|pair| pair == ["--model", "opus[1m]"]),
        "{argv:?}"
    );
    assert!(
        argv.windows(2).any(|pair| pair == ["--effort", "high"]),
        "{argv:?}"
    );
}

#[tokio::test]
async fn set_model_rejects_catalog_mismatches() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("chat").await;
    let head = harness.create().await;

    let unknown = harness
        .agents
        .set_model(&head.id, "ghost-model".into(), None)
        .await
        .unwrap_err();
    assert!(unknown.to_string().contains("模型不可用"), "{unknown}");

    // opus[1m] supports low/high/max but not medium.
    let unsupported = harness
        .agents
        .set_model(&head.id, "opus[1m]".into(), Some("medium".into()))
        .await
        .unwrap_err();
    assert!(
        unsupported.to_string().contains("不支持推理强度"),
        "{unsupported}"
    );

    for bad in ["", " ", "x\n", &"x".repeat(161)] {
        assert!(
            harness
                .agents
                .set_model(&head.id, bad.to_owned(), None)
                .await
                .is_err()
        );
    }
    // The rejected switches did not move the persisted selection.
    let controls = harness.agents.controls().await.unwrap();
    let row = controls
        .controls
        .iter()
        .find(|item| item.session_id == head.id)
        .unwrap();
    assert_eq!(row.current_model, None);
    assert_eq!(row.current_effort, None);
}

#[tokio::test]
async fn task_tool_subagent_gets_card_and_detail_transcript() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("subagent").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "spawn a worker".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::Subagent {
                        status,
                        ..
                    } if status == "completed"
                )
            }) && records
                .iter()
                .any(|(_, body, _)| matches!(body, TimelineBody::TurnEnd { .. }))
        })
        .await;

    // Exactly one subagent card on the main timeline; its transcript is not
    // projected there.
    let cards: Vec<_> = records
        .iter()
        .filter_map(|(_, body, _)| match body {
            TimelineBody::Subagent {
                subagent_id,
                name,
                role,
                status,
                can_message,
                summary,
                ..
            } => Some((subagent_id, name, role, status, can_message, summary)),
            _ => None,
        })
        .collect();
    assert_eq!(cards.len(), 1, "expected a single collapsing card");
    let (subagent_id, name, role, status, can_message, summary) = cards[0];
    assert_eq!(subagent_id, "toolu_1");
    assert_eq!(name, "Explore");
    assert_eq!(role.as_deref(), Some("search"));
    assert_eq!(status, "completed");
    assert!(!can_message);
    assert_eq!(summary, "found things");
    assert!(
        !records.iter().any(
            |(_, body, preview)| matches!(body, TimelineBody::Message { .. })
                && preview == "subagent whispers"
        ),
        "subagent text must stay off the main timeline"
    );
    assert!(
        !records.iter().any(|(_, body, _)| matches!(
            body,
            TimelineBody::Tool { name, .. } if name == "Bash"
        )),
        "subagent tool calls must stay off the main timeline"
    );

    // The detail endpoint returns the attributed transcript as legacy events.
    let snapshot = harness
        .agents
        .subagent_snapshot(&head.id, "toolu_1")
        .await
        .unwrap();
    assert_eq!(snapshot.subagent.id, "toolu_1");
    assert_eq!(snapshot.subagent.name, "Explore");
    assert_eq!(snapshot.subagent.status, "completed");
    let kinds: Vec<(String, String)> = snapshot
        .events
        .iter()
        .map(|event| {
            (
                event
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
                event
                    .get("text")
                    .or_else(|| event.get("summary"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
            )
        })
        .collect();
    assert!(
        kinds
            .iter()
            .any(|(kind, text)| kind == "assistant.text" && text == "subagent whispers"),
        "detail transcript must include the subagent text: {kinds:?}"
    );
    assert!(
        kinds
            .iter()
            .any(|(kind, text)| kind == "tool.end" && text == "done"),
        "detail transcript must include the subagent tool result: {kinds:?}"
    );

    // Unknown subagent ids are 404s.
    assert!(
        harness
            .agents
            .subagent_snapshot(&head.id, "ghost")
            .await
            .is_err()
    );
}

#[tokio::test]
async fn background_task_without_subagent_type_stays_on_main_timeline() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("backgroundtask").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "go".into(), None, Vec::new())
        .await
        .unwrap();

    let records = harness
        .wait_for(&head.id, |records| {
            records.iter().any(|(_, body, _)| {
                matches!(
                    body,
                    TimelineBody::TurnEnd { finish, .. } if finish == "completed"
                )
            })
        })
        .await;
    assert!(
        records.iter().any(|(_, body, preview)| matches!(
            body,
            TimelineBody::Message {
                role: prosperod_rs::protocol::MessageRole::Assistant,
                ..
            }
        ) && preview == "background output"),
        "background task output belongs on the main timeline"
    );
    assert!(
        !records
            .iter()
            .any(|(_, body, _)| matches!(body, TimelineBody::Subagent { .. })),
        "background tasks must not create subagent cards"
    );
}

async fn turn_ends(harness: &Harness, id: &str, count: usize) {
    harness
        .wait_for(id, |records| {
            records
                .iter()
                .filter(|(_, body, _)| matches!(body, TimelineBody::TurnEnd { .. }))
                .count()
                == count
        })
        .await;
}

#[tokio::test]
async fn busy_send_enqueues_and_drains_fifo() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("queuedrain").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "first prompt".into(), None, Vec::new())
        .await
        .unwrap();
    // The second message lands while turn one is still running.
    harness
        .agents
        .send(&head.id, "second prompt".into(), None, Vec::new())
        .await
        .unwrap();
    let queued = harness.agents.queue(&head.id).await.unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].text, "second prompt");
    assert_eq!(queued[0].kind, "queue");

    turn_ends(&harness, &head.id, 2).await;
    assert!(harness.agents.queue(&head.id).await.unwrap().is_empty());
    let prompts =
        std::fs::read_to_string(harness.workspace.path().join("prompts.log")).unwrap_or_default();
    assert!(prompts.contains("first prompt"));
    assert!(
        prompts.contains("second prompt"),
        "queued text must reach the next CLI turn: {prompts}"
    );
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::Idle
    );
}

#[tokio::test]
async fn busy_steer_writes_into_live_cli_and_is_audited() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("steer").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "do the task".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .agents
        .send(
            &head.id,
            "also check the tests".into(),
            Some("steer".into()),
            Vec::new(),
        )
        .await
        .unwrap();
    turn_ends(&harness, &head.id, 1).await;
    // The steer reached the running CLI process (no second turn spawned).
    let steered =
        std::fs::read_to_string(harness.workspace.path().join("steered.log")).unwrap_or_default();
    assert!(steered.contains("also check the tests"));
    assert!(harness.agents.queue(&head.id).await.unwrap().is_empty());
    // The steered text is recorded as a user message immediately.
    let records = harness.records(&head.id).await;
    let steered_audit: Vec<&str> = records
        .iter()
        .filter(|(id, body, _)| {
            id.contains("steer")
                && matches!(
                    body,
                    TimelineBody::Message {
                        role: prosperod_rs::protocol::MessageRole::User,
                        ..
                    }
                )
        })
        .map(|(_, _, preview)| preview.as_str())
        .collect();
    assert!(steered_audit.contains(&"also check the tests"));
}

#[tokio::test]
async fn steer_with_closed_pipe_degrades_to_queue_front() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("pipeclosed").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "first".into(), None, Vec::new())
        .await
        .unwrap();
    // Wait until the fake CLI is inside the window where it closes stdin.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !harness.workspace.path().join("ready.flag").exists() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // A message whose JSON frame exceeds the 64KiB pipe capacity blocks in
    // the writer and fails with EPIPE once the CLI closes its read end; the
    // unique marker stays findable despite the padding.
    let payload = format!("recover me {}", "x".repeat(65_520));
    harness
        .agents
        .send(&head.id, payload, Some("steer".into()), Vec::new())
        .await
        .unwrap();
    // The failed steer must land in the queue (flagged guide) before this
    // turn ends, proving the writer's error drove the fallback.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let queued = loop {
        let queued = harness.agents.queue(&head.id).await.unwrap();
        if queued.len() == 1 {
            break queued;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(queued[0].kind, "guide");
    assert!(queued[0].text.starts_with("recover me"));
    // The turn-end drain dispatches the guide row as the next turn.
    turn_ends(&harness, &head.id, 2).await;
    let prompts =
        std::fs::read_to_string(harness.workspace.path().join("prompts.log")).unwrap_or_default();
    assert!(
        prompts.contains("recover me"),
        "steer fallback must not lose the text: {prompts}"
    );
    assert!(harness.agents.queue(&head.id).await.unwrap().is_empty());
}

#[tokio::test]
async fn remove_queued_cancels_pending_message() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("steer").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "working".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .agents
        .send(&head.id, "cancel me".into(), None, Vec::new())
        .await
        .unwrap();
    let queued = harness.agents.queue(&head.id).await.unwrap();
    assert_eq!(queued.len(), 1);
    harness
        .agents
        .remove_queued(&head.id, &queued[0].id)
        .await
        .unwrap();
    assert!(harness.agents.queue(&head.id).await.unwrap().is_empty());
    assert!(
        harness
            .agents
            .remove_queued(&head.id, &queued[0].id)
            .await
            .is_err()
    );
    turn_ends(&harness, &head.id, 1).await;
}

#[tokio::test]
async fn guide_queued_upgrades_to_live_steer() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("steer").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "working".into(), None, Vec::new())
        .await
        .unwrap();
    harness
        .agents
        .send(&head.id, "urgent note".into(), None, Vec::new())
        .await
        .unwrap();
    let queued = harness.agents.queue(&head.id).await.unwrap();
    assert_eq!(queued[0].kind, "queue");
    harness
        .agents
        .guide_queued(&head.id, &queued[0].id)
        .await
        .unwrap();
    assert!(harness.agents.queue(&head.id).await.unwrap().is_empty());
    turn_ends(&harness, &head.id, 1).await;
    let steered =
        std::fs::read_to_string(harness.workspace.path().join("steered.log")).unwrap_or_default();
    assert!(steered.contains("urgent note"));
}

#[tokio::test]
async fn queue_is_capped_at_fifty() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("steer").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "working".into(), None, Vec::new())
        .await
        .unwrap();
    for index in 0..50 {
        harness
            .agents
            .send(&head.id, format!("queued {index}"), None, Vec::new())
            .await
            .unwrap();
    }
    let overflow = harness
        .agents
        .send(&head.id, "one too many".into(), None, Vec::new())
        .await;
    assert!(overflow.is_err(), "the 51st message must be rejected");
    assert_eq!(harness.agents.queue(&head.id).await.unwrap().len(), 50);
    // Kill the session so the queued rows never spawn fifty CLI turns.
    harness.agents.close(&head.id).await.unwrap();
    assert_eq!(
        harness.status(&head.id).await,
        prosperod_rs::protocol::SessionStatus::Failed
    );
}

#[tokio::test]
async fn image_attachments_reach_cli_as_image_first_frame() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("attach").await;
    let head = harness.create().await;
    let attachments = vec![
        prosperod_rs::agent::AttachmentInput {
            mime_type: "image/png".into(),
            data_b64: "iVBORw0KGgo=".into(),
            name: Some("diagram.png".into()),
        },
        prosperod_rs::agent::AttachmentInput {
            mime_type: "image/jpeg".into(),
            data_b64: "/9j/4AAQ".into(),
            name: None,
        },
    ];
    harness
        .agents
        .send(&head.id, "look at these".into(), None, attachments.clone())
        .await
        .unwrap();
    turn_ends(&harness, &head.id, 1).await;

    // The CLI received one user frame whose content array puts both image
    // blocks ahead of the trailing text block.
    let raw = std::fs::read_to_string(harness.workspace.path().join("frame.log")).unwrap();
    let frame: serde_json::Value = serde_json::from_str(raw.trim()).unwrap();
    let content = &frame["message"]["content"];
    assert!(content.is_array());
    let blocks = content.as_array().unwrap();
    assert_eq!(blocks.len(), 3);
    assert_eq!(blocks[0]["type"], "image");
    assert_eq!(blocks[0]["source"]["media_type"], "image/png");
    assert_eq!(blocks[0]["source"]["data"], "iVBORw0KGgo=");
    assert_eq!(blocks[1]["type"], "image");
    assert_eq!(blocks[1]["source"]["media_type"], "image/jpeg");
    assert_eq!(blocks[2]["type"], "text");
    assert_eq!(blocks[2]["text"], "look at these");

    // The persisted user record carries metadata refs only (no bytes).
    let (message_id, user) = harness
        .records(&head.id)
        .await
        .into_iter()
        .find_map(|(id, body, _)| match body {
            TimelineBody::Message {
                role: MessageRole::User,
                attachments,
                ..
            } => Some((id, attachments)),
            _ => None,
        })
        .expect("user message record");
    assert_eq!(user.len(), 2);
    assert_eq!(user[0].mime_type, "image/png");
    assert_eq!(user[0].name.as_deref(), Some("diagram.png"));
    assert!(!user[0].id.is_empty());
    assert!(user[1].name.is_none());

    let chunk = harness
        .agents
        .attachment_chunk(&head.id, &message_id, &user[0].id, 0, 4)
        .await
        .unwrap()
        .expect("stored attachment chunk");
    assert_eq!(chunk.mime_type, "image/png");
    assert_eq!(chunk.total, 8);
    assert!(!chunk.eof);
    assert_eq!(chunk.data_b64, "iVBORw==");
    let tail = harness
        .agents
        .attachment_chunk(&head.id, &message_id, &user[0].id, 4, 1024)
        .await
        .unwrap()
        .expect("stored attachment tail");
    assert!(tail.eof);
    assert_eq!(tail.data_b64, "DQoaCg==");
}

#[tokio::test]
async fn image_only_message_is_valid_and_rejected_forms_fail() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("attach").await;
    let head = harness.create().await;

    // Image with no text is a valid message.
    harness
        .agents
        .send(
            &head.id,
            String::new(),
            None,
            vec![prosperod_rs::agent::AttachmentInput {
                mime_type: "image/gif".into(),
                data_b64: "R0lGODlh".into(),
                name: None,
            }],
        )
        .await
        .unwrap();

    // Unsupported MIME, too many images, and empty message are all refused.
    let bad_mime = harness
        .agents
        .send(
            &head.id,
            "x".into(),
            None,
            vec![prosperod_rs::agent::AttachmentInput {
                mime_type: "application/octet-stream".into(),
                data_b64: "AAAA".into(),
                name: None,
            }],
        )
        .await;
    assert!(bad_mime.is_err());
    let too_many = harness
        .agents
        .send(
            &head.id,
            "x".into(),
            None,
            (0..7)
                .map(|_| prosperod_rs::agent::AttachmentInput {
                    mime_type: "image/png".into(),
                    data_b64: "AAAA".into(),
                    name: None,
                })
                .collect(),
        )
        .await;
    assert!(too_many.is_err());
    // A truly empty text-only message is rejected.
    assert!(
        harness
            .agents
            .send(&head.id, String::new(), None, Vec::new())
            .await
            .is_err()
    );
    harness.agents.close(&head.id).await.unwrap();
}

#[tokio::test]
async fn queued_image_message_keeps_attachment_count_then_frame() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("queuedrain").await;
    let head = harness.create().await;
    harness
        .agents
        .send(&head.id, "first prompt".into(), None, Vec::new())
        .await
        .unwrap();
    // Busy send with an image parks the bytes on the queue row.
    harness
        .agents
        .send(
            &head.id,
            "second prompt".into(),
            None,
            vec![prosperod_rs::agent::AttachmentInput {
                mime_type: "image/webp".into(),
                data_b64: "UklGRh4A".into(),
                name: Some("shot.webp".into()),
            }],
        )
        .await
        .unwrap();
    let queue = harness.agents.queue(&head.id).await.unwrap();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].attachment_count, 1);
    // Drain completes via a chained --resume turn.
    turn_ends(&harness, &head.id, 2).await;
    let log = std::fs::read_to_string(harness.workspace.path().join("prompts.log")).unwrap();
    let frames: Vec<serde_json::Value> = log
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(frames.len(), 2);
    assert!(frames[1]["message"]["content"].is_array());
    assert_eq!(
        frames[1]["message"]["content"][0]["source"]["media_type"],
        "image/webp"
    );
    assert_eq!(frames[1]["message"]["content"][1]["text"], "second prompt");
    assert!(harness.agents.queue(&head.id).await.unwrap().is_empty());
}

#[tokio::test]
async fn usage_accumulates_tokens_from_result_frames() {
    let _guard = SERIAL.lock().await;
    let harness = Harness::new("usage").await;
    let head = harness.create().await;
    assert!(harness.agents.usage(&head.id).await.unwrap().is_none());
    harness
        .agents
        .send(&head.id, "count".into(), None, Vec::new())
        .await
        .unwrap();
    harness.wait_for(&head.id, |records| records.iter().any(|(_, body, _)| matches!(body, TimelineBody::TurnEnd { finish, .. } if finish == "completed"))).await;
    let usage = harness.agents.usage(&head.id).await.unwrap().unwrap();
    assert_eq!(usage.input_tokens, Some(12));
    assert_eq!(usage.output_tokens, Some(7));
    assert_eq!(usage.cost_usd, Some(0.25));
    assert!(usage.windows.is_empty());
}
