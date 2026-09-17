use std::path::PathBuf;

use clap::{Parser, Subcommand};
use prosperod_rs::control_cli::{control_method, prospero_home};
use serde_json::{Value, json};

#[derive(Parser)]
#[command(name = "prospero", version)]
struct Arguments {
    #[arg(long = "home")]
    home: Option<PathBuf>,
    #[arg(long = "session")]
    session: Option<String>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Run {
        #[command(subcommand)]
        command: RunCommand,
    },
    Task {
        #[command(subcommand)]
        command: TaskCommand,
    },
    Worker {
        #[command(subcommand)]
        command: WorkerCommand,
    },
    Worktree {
        #[command(subcommand)]
        command: WorktreeCommand,
    },
    Send {
        #[arg(long)]
        run: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        subject: String,
        #[arg(long)]
        body: String,
        #[arg(long = "type", default_value = "note")]
        kind: String,
        #[arg(long)]
        thread: Option<String>,
        #[arg(long)]
        task: Option<String>,
    },
    Check {
        #[arg(long)]
        run: Option<String>,
        #[arg(long)]
        recipient: Option<String>,
        #[arg(long)]
        wait: bool,
    },
    Ask {
        #[arg(long)]
        run: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        subject: String,
        #[arg(long)]
        body: String,
        #[arg(long)]
        task: Option<String>,
        #[arg(long = "no-wait", action = clap::ArgAction::SetFalse, default_value_t = true)]
        wait: bool,
    },
    Reply {
        #[arg(long)]
        run: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        thread: String,
        #[arg(long)]
        subject: String,
        #[arg(long)]
        body: String,
        #[arg(long)]
        task: Option<String>,
    },
    Gate {
        #[command(subcommand)]
        command: GateCommand,
    },
    Schedule {
        #[command(subcommand)]
        command: ScheduleCommand,
    },
    Status {
        #[arg(long)]
        run: Option<String>,
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum RunCommand {
    Create {
        #[arg(long)]
        objective: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    List,
    Complete {
        #[arg(long)]
        id: String,
        #[arg(long = "allow-failed-tasks")]
        allow_failed_tasks: bool,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    Abandon {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    Delete {
        #[arg(long)]
        id: String,
        #[arg(long)]
        force: bool,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
}

#[derive(Subcommand)]
enum TaskCommand {
    Create {
        #[arg(long)]
        run: String,
        #[arg(long)]
        title: String,
        #[arg(long)]
        spec: String,
        #[arg(long)]
        skill: Vec<String>,
        #[arg(long)]
        dep: Vec<String>,
        #[arg(long)]
        parent: Option<String>,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    List {
        #[arg(long)]
        run: Option<String>,
    },
    Get {
        #[arg(long)]
        id: String,
    },
    Done {
        #[arg(long)]
        id: String,
        #[arg(long)]
        body: String,
    },
    Fail {
        #[arg(long)]
        id: String,
        #[arg(long)]
        body: String,
    },
    Retry {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    Cancel {
        #[arg(long)]
        id: String,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
}

#[derive(Subcommand)]
enum WorkerCommand {
    Start {
        #[arg(long)]
        task: String,
        #[arg(long)]
        agent: String,
        #[arg(long, default_value = "none")]
        worktree: String,
        #[arg(long, default_value = ".")]
        cwd: PathBuf,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long = "approval-policy")]
        approval_policy: Option<String>,
        #[arg(long)]
        skill: Vec<String>,
        #[arg(long = "account")]
        account_id: Option<String>,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    Stop {
        #[arg(long)]
        task: String,
        #[arg(long)]
        reason: Option<String>,
        #[arg(long = "final-status")]
        final_status: Option<String>,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
}

#[derive(Subcommand)]
enum WorktreeCommand {
    List {
        #[arg(long)]
        run: Option<String>,
    },
    Inspect {
        #[arg(long)]
        id: String,
        #[arg(long, default_value = "HEAD")]
        target: String,
    },
    Cleanup {
        #[arg(long)]
        id: String,
        #[arg(long, default_value = "HEAD")]
        target: String,
        #[arg(long = "delete-branch")]
        delete_branch: bool,
        #[arg(long)]
        confirm: bool,
        #[arg(long = "operation-id")]
        operation_id: String,
    },
}

#[derive(Subcommand)]
enum GateCommand {
    Create {
        #[arg(long)]
        run: String,
        #[arg(long)]
        question: String,
        #[arg(long = "option")]
        options: Vec<String>,
        #[arg(long)]
        task: Option<String>,
    },
    Resolve {
        #[arg(long)]
        id: String,
        #[arg(long)]
        decision: String,
    },
    List {
        #[arg(long)]
        run: Option<String>,
        #[arg(long)]
        status: Option<String>,
    },
}

#[derive(Subcommand)]
enum ScheduleCommand {
    List,
    Get {
        #[arg(long)]
        id: String,
    },
    Create {
        #[arg(long)]
        name: String,
        #[arg(long)]
        prompt: String,
        #[arg(long)]
        rrule: String,
        #[arg(long)]
        id: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        agent: Option<String>,
        #[arg(long = "approval-policy")]
        approval_policy: Option<String>,
        #[arg(long = "account")]
        account_id: Option<String>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long = "effort")]
        reasoning_effort: Option<String>,
        #[arg(long)]
        mode: Option<String>,
        #[arg(long = "target-thread")]
        target_thread_id: Option<String>,
        #[arg(long)]
        paused: bool,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    Update {
        #[arg(long)]
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        prompt: Option<String>,
        #[arg(long)]
        rrule: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        agent: Option<String>,
        #[arg(long = "approval-policy")]
        approval_policy: Option<String>,
        #[arg(long = "account")]
        account_id: Option<String>,
        #[arg(long = "clear-account")]
        clear_account: bool,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(long)]
        model: Option<String>,
        #[arg(long = "clear-model")]
        clear_model: bool,
        #[arg(long = "effort")]
        reasoning_effort: Option<String>,
        #[arg(long = "clear-effort")]
        clear_effort: bool,
        #[arg(long)]
        mode: Option<String>,
        #[arg(long = "clear-mode")]
        clear_mode: bool,
        #[arg(long = "target-thread")]
        target_thread_id: Option<String>,
        #[arg(long = "clear-target-thread")]
        clear_target_thread: bool,
        #[arg(long)]
        paused: bool,
        #[arg(long)]
        enabled: bool,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    Pause {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    Resume {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    Delete {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
    Run {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
    },
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("prospero: {}: {}", error.public().code, error);
        std::process::exit(1);
    }
}

async fn run() -> prosperod_rs::error::Result<()> {
    let args = Arguments::parse();
    let home = prospero_home(args.home);
    let session = args
        .session
        .or_else(|| std::env::var("PROSPERO_SESSION_ID").ok())
        .filter(|value| !value.trim().is_empty());
    let (method, params) = command_request(args.command, session)?;
    print(control_method(&home, method, params).await?);
    Ok(())
}

fn command_request(
    command: Command,
    session: Option<String>,
) -> prosperod_rs::error::Result<(&'static str, Value)> {
    let request = match command {
        Command::Run { command } => match command {
            RunCommand::Create {
                objective,
                operation_id,
            } => (
                "run.create",
                json!({"objective": require_text(objective, "--objective")?, "coordinatorSessionId": session, "operationId": operation_id}),
            ),
            RunCommand::List => ("run.list", json!({})),
            RunCommand::Complete {
                id,
                allow_failed_tasks,
                operation_id,
            } => (
                "run.complete",
                json!({"runId": id, "allowFailedTasks": allow_failed_tasks, "actorSessionId": session, "operationId": operation_id}),
            ),
            RunCommand::Abandon { id, operation_id } => (
                "run.abandon",
                json!({"runId": id, "actorSessionId": session, "operationId": operation_id}),
            ),
            RunCommand::Delete {
                id,
                force,
                operation_id,
            } => (
                "run.delete",
                json!({"runId": id, "force": force, "actorSessionId": session, "operationId": operation_id}),
            ),
        },
        Command::Task { command } => match command {
            TaskCommand::Create {
                run,
                title,
                spec,
                skill,
                dep,
                parent,
                operation_id,
            } => (
                "task.create",
                json!({"runId": run, "title": title, "spec": spec, "skills": skill, "deps": dep, "parentId": parent, "actorSessionId": session, "operationId": operation_id}),
            ),
            TaskCommand::List { run } => ("task.list", json!({"runId": run})),
            TaskCommand::Get { id } => ("task.get", json!({"taskId": id})),
            TaskCommand::Done { id, body } => (
                "task.done",
                json!({"taskId": id, "body": require_text(body, "--body")?, "actorSessionId": session}),
            ),
            TaskCommand::Fail { id, body } => (
                "task.fail",
                json!({"taskId": id, "body": require_text(body, "--body")?, "actorSessionId": session}),
            ),
            TaskCommand::Retry { id, operation_id } => (
                "task.retry",
                json!({"taskId": id, "actorSessionId": session, "operationId": operation_id}),
            ),
            TaskCommand::Cancel {
                id,
                reason,
                operation_id,
            } => (
                "task.cancel",
                json!({"taskId": id, "reason": reason, "actorSessionId": session, "operationId": operation_id}),
            ),
        },
        Command::Worker { command } => match command {
            WorkerCommand::Start {
                task,
                agent,
                worktree,
                cwd,
                kind,
                approval_policy,
                skill,
                account_id,
                operation_id,
            } => (
                "worker.start",
                json!({"taskId": task, "agent": agent, "worktree": worktree, "cwd": absolute(cwd)?, "kind": kind, "approvalPolicy": approval_policy, "skills": skill, "accountId": account_id, "operationId": operation_id, "actorSessionId": session}),
            ),
            WorkerCommand::Stop {
                task,
                reason,
                final_status,
                operation_id,
            } => (
                "worker.stop",
                json!({"taskId": task, "reason": reason, "finalStatus": final_status, "operationId": operation_id, "actorSessionId": session}),
            ),
        },
        Command::Worktree { command } => match command {
            WorktreeCommand::List { run } => (
                "worktree.list",
                json!({"runId": run, "actorSessionId": session}),
            ),
            WorktreeCommand::Inspect { id, target } => (
                "worktree.inspect",
                json!({"assetId": id, "targetRef": target, "actorSessionId": session}),
            ),
            WorktreeCommand::Cleanup {
                id,
                target,
                delete_branch,
                confirm,
                operation_id,
            } => (
                "worktree.cleanup",
                json!({"assetId": id, "targetRef": target, "deleteBranch": delete_branch, "confirm": confirm, "operationId": operation_id, "actorSessionId": session}),
            ),
        },
        Command::Send {
            run,
            to,
            subject,
            body,
            kind,
            thread,
            task,
        } => (
            "mail.send",
            json!({"runId": run, "from": sender(session)?, "to": to, "type": kind, "subject": subject, "body": body, "threadId": thread, "taskId": task}),
        ),
        Command::Check {
            run,
            recipient,
            wait,
        } => {
            let recipient = match recipient {
                Some(recipient) => recipient,
                None => sender(session)?,
            };
            (
                "mail.check",
                json!({"runId": run, "recipient": recipient, "wait": wait}),
            )
        }
        Command::Ask {
            run,
            to,
            subject,
            body,
            task,
            wait,
        } => (
            "mail.ask",
            json!({"runId": run, "from": sender(session)?, "to": to, "subject": subject, "body": body, "taskId": task, "wait": wait}),
        ),
        Command::Reply {
            run,
            to,
            thread,
            subject,
            body,
            task,
        } => (
            "mail.reply",
            json!({"runId": run, "from": sender(session)?, "to": to, "threadId": thread, "subject": subject, "body": body, "taskId": task}),
        ),
        Command::Gate { command } => match command {
            GateCommand::Create {
                run,
                question,
                options,
                task,
            } => (
                "gate.create",
                json!({"runId": run, "question": question, "options": options, "taskId": task, "actorSessionId": session}),
            ),
            GateCommand::Resolve { id, decision } => (
                "gate.resolve",
                json!({"gateId": id, "decision": decision, "actorSessionId": session}),
            ),
            GateCommand::List { run, status } => {
                ("gate.list", json!({"runId": run, "status": status}))
            }
        },
        Command::Schedule { command } => schedule_request(command, session)?,
        Command::Status { run, all, json } => {
            let mut params = serde_json::Map::new();
            if let Some(run) = run {
                params.insert("runId".into(), json!(run));
            }
            if all {
                params.insert("all".into(), json!(true));
            }
            if json {
                params.insert("json".into(), json!(true));
            }
            params.insert(
                "actorSessionId".into(),
                session.map(Value::String).unwrap_or(Value::Null),
            );
            ("orchestration.snapshot", Value::Object(params))
        }
    };
    Ok(request)
}

fn schedule_request(
    command: ScheduleCommand,
    session: Option<String>,
) -> prosperod_rs::error::Result<(&'static str, Value)> {
    Ok(match command {
        ScheduleCommand::List => ("schedule.list", json!({})),
        ScheduleCommand::Get { id } => ("schedule.get", json!({"id": id})),
        ScheduleCommand::Create {
            name,
            prompt,
            rrule,
            id,
            kind,
            agent,
            approval_policy,
            account_id,
            cwd,
            model,
            reasoning_effort,
            mode,
            target_thread_id,
            paused,
            operation_id,
        } => (
            "schedule.create",
            json!({
            "id": id,
            "kind": kind,
            "name": name,
            "prompt": prompt,
            "rrule": rrule,
            "status": paused.then_some("PAUSED"),
            "agent": agent,
            "approvalPolicy": approval_policy,
            "accountId": account_id,
            "cwd": optional_absolute(cwd)?,
            "model": model,
            "reasoningEffort": reasoning_effort,
            "mode": mode,
            "targetThreadId": target_thread_id,
            "actorSessionId": session,
            "operationId": operation_id,
            }),
        ),
        ScheduleCommand::Update {
            id,
            name,
            prompt,
            rrule,
            kind,
            agent,
            approval_policy,
            account_id,
            clear_account,
            cwd,
            model,
            clear_model,
            reasoning_effort,
            clear_effort,
            mode,
            clear_mode,
            target_thread_id,
            clear_target_thread,
            paused,
            enabled,
            operation_id,
        } => {
            if paused && enabled {
                return Err(prosperod_rs::error::Error::Invalid(
                    "--paused 与 --enabled 不能同时使用".into(),
                ));
            }
            let mut body = serde_json::Map::new();
            body.insert("id".into(), json!(id));
            put(&mut body, "name", name);
            put(&mut body, "prompt", prompt);
            put(&mut body, "rrule", rrule);
            put(&mut body, "kind", kind);
            put(&mut body, "agent", agent);
            put(&mut body, "approvalPolicy", approval_policy);
            put_clearable(&mut body, "accountId", account_id, clear_account);
            put(&mut body, "cwd", optional_absolute(cwd)?);
            put_clearable(&mut body, "model", model, clear_model);
            put_clearable(&mut body, "reasoningEffort", reasoning_effort, clear_effort);
            put_clearable(&mut body, "mode", mode, clear_mode);
            put_clearable(
                &mut body,
                "targetThreadId",
                target_thread_id,
                clear_target_thread,
            );
            if paused {
                body.insert("status".into(), json!("PAUSED"));
            } else if enabled {
                body.insert("status".into(), json!("ENABLED"));
            }
            put(&mut body, "actorSessionId", session);
            put(&mut body, "operationId", operation_id);
            ("schedule.update", Value::Object(body))
        }
        ScheduleCommand::Pause { id, operation_id } => (
            "schedule.pause",
            json!({"id": id, "operationId": operation_id}),
        ),
        ScheduleCommand::Resume { id, operation_id } => (
            "schedule.resume",
            json!({"id": id, "operationId": operation_id}),
        ),
        ScheduleCommand::Delete { id, operation_id } => (
            "schedule.delete",
            json!({"id": id, "operationId": operation_id}),
        ),
        ScheduleCommand::Run { id, operation_id } => (
            "schedule.run",
            json!({"id": id, "operationId": operation_id}),
        ),
    })
}

fn sender(session: Option<String>) -> prosperod_rs::error::Result<String> {
    session.ok_or_else(|| {
        prosperod_rs::error::Error::Invalid("缺少 --session（或 PROSPERO_SESSION_ID）".into())
    })
}

fn require_text(value: String, name: &str) -> prosperod_rs::error::Result<String> {
    if value.trim().is_empty() {
        return Err(prosperod_rs::error::Error::Invalid(format!("缺少 {name}")));
    }
    Ok(value)
}

fn absolute(path: PathBuf) -> prosperod_rs::error::Result<String> {
    let path = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };
    Ok(path.to_string_lossy().into_owned())
}

fn optional_absolute(path: Option<PathBuf>) -> prosperod_rs::error::Result<Option<String>> {
    path.map(absolute).transpose()
}

fn put(map: &mut serde_json::Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), json!(value));
    }
}

fn put_clearable(
    map: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<String>,
    clear: bool,
) {
    if clear {
        map.insert(key.into(), Value::Null);
    } else {
        put(map, key, value);
    }
}

fn print(value: Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(&value).unwrap_or_default()
    );
}
