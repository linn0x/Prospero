use std::future::IntoFuture;
use std::io::Read as _;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use clap::{Parser, Subcommand};
use prosperod_rs::database::Store;
use prosperod_rs::error::{Error as DaemonError, Result as DaemonResult};
use prosperod_rs::protocol::{self, SessionQuery};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Parser)]
#[command(name = "prosperod-rs", version)]
struct Arguments {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    Start {
        #[arg(short = 'p', long)]
        port: Option<u16>,
        #[arg(short = 'b', long)]
        bind: Option<String>,
        #[arg(long)]
        dev: bool,
        #[arg(long = "no-bonjour")]
        no_bonjour: bool,
        #[arg(long)]
        tmux: bool,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        home: Option<PathBuf>,
        #[arg(long = "full-access")]
        full_access: bool,
    },
    #[cfg(unix)]
    #[command(hide = true)]
    TerminalGuard {
        #[arg(long)]
        parent: u32,
        #[arg(long)]
        shell: std::ffi::OsString,
        #[arg(last = true)]
        args: Vec<std::ffi::OsString>,
    },
    #[command(hide = true)]
    TerminalHost {
        #[arg(long)]
        directory: PathBuf,
    },
    Serve {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
    },
    Pair {
        #[arg(long, default_value = "iphone")]
        name: String,
        #[arg(long = "no-shell", action = clap::ArgAction::SetFalse, default_value_t = true)]
        shell: bool,
        #[arg(long = "no-orchestration", action = clap::ArgAction::SetFalse, default_value_t = true)]
        orchestration: bool,
        #[arg(long)]
        dev: bool,
        #[arg(long = "data-dir", hide = true)]
        data_dir: Option<PathBuf>,
    },
    Relay {
        #[command(subcommand)]
        command: RelayCommand,
    },
    Plugin {
        #[command(subcommand)]
        command: PluginCommand,
    },
    Schedule {
        #[command(subcommand)]
        command: Box<ScheduleCommand>,
    },
    Notify {
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        off: bool,
        #[arg(long)]
        test: bool,
        #[arg(long = "data-dir", hide = true)]
        data_dir: Option<PathBuf>,
    },
    RotateKey {
        #[arg(short = 'y', long)]
        yes: bool,
        #[arg(long = "data-dir", hide = true)]
        data_dir: Option<PathBuf>,
    },
    Revoke {
        name: Option<String>,
        #[arg(long)]
        id: Option<String>,
        #[arg(long = "data-dir", hide = true)]
        data_dir: Option<PathBuf>,
    },
    Status {
        #[arg(long = "data-dir", hide = true)]
        data_dir: Option<PathBuf>,
    },
    Types {
        #[arg(long)]
        output: Option<PathBuf>,
    },
    SeedBenchmark {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long)]
        sessions: usize,
    },
    SeedConversation {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long, default_value_t = 100)]
        turns: usize,
    },
    Benchmark {
        #[arg(long)]
        data_dir: PathBuf,
    },
}

#[derive(Subcommand)]
enum RelayCommand {
    Enable {
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        dev: bool,
        #[arg(long = "data-dir", hide = true)]
        data_dir: Option<PathBuf>,
    },
    Disable {
        #[arg(long = "data-dir", hide = true)]
        data_dir: Option<PathBuf>,
    },
    Status {
        #[arg(long)]
        json: bool,
        #[arg(long = "data-dir", hide = true)]
        data_dir: Option<PathBuf>,
    },
    RotateKey {
        #[arg(short = 'y', long)]
        yes: bool,
        #[arg(long = "data-dir", hide = true)]
        data_dir: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
#[command(rename_all = "kebab-case")]
enum PluginCommand {
    List {
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Service {
        #[command(subcommand)]
        command: PluginServiceCommand,
    },
}

#[derive(Subcommand)]
#[command(rename_all = "kebab-case")]
enum PluginServiceCommand {
    Status {
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Start {
        plugin_id: String,
        service_id: String,
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Stop {
        plugin_id: String,
        service_id: String,
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Restart {
        plugin_id: String,
        service_id: String,
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Health {
        plugin_id: String,
        service_id: String,
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
#[command(rename_all = "kebab-case")]
enum ScheduleCommand {
    List {
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Get {
        #[arg(long)]
        id: String,
        #[arg(long = "home")]
        home: Option<PathBuf>,
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
        #[arg(long = "home")]
        home: Option<PathBuf>,
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
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Pause {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Resume {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Delete {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
    Run {
        #[arg(long)]
        id: String,
        #[arg(long = "operation-id")]
        operation_id: Option<String>,
        #[arg(long = "home")]
        home: Option<PathBuf>,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let command = Arguments::parse().command.unwrap_or(Command::Start {
        port: None,
        bind: None,
        dev: false,
        no_bonjour: false,
        tmux: false,
        name: None,
        home: None,
        full_access: false,
    });
    match command {
        Command::Start {
            port,
            bind,
            dev,
            no_bonjour: _,
            tmux: _,
            name: _,
            home,
            full_access,
        } => run_start(port, bind, dev, home, full_access)?,
        #[cfg(unix)]
        Command::TerminalGuard {
            parent,
            shell,
            args,
        } => {
            std::process::exit(prosperod_rs::terminal::guard::run(parent, shell, args)?);
        }
        Command::TerminalHost { directory } => prosperod_rs::terminal::host::run(directory)?,
        Command::Serve { data_dir, listen } => {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?
                .block_on(serve(data_dir, listen, true, false))?;
        }
        Command::Pair {
            name,
            shell,
            orchestration,
            dev,
            data_dir,
        } => run_pair(data_dir, name, shell, shell && orchestration, dev)?,
        Command::Relay { command } => run_relay(command)?,
        Command::Plugin { command } => {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(run_plugin(command))?;
        }
        Command::Schedule { command } => {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?
                .block_on(run_schedule(*command))?;
        }
        Command::Notify {
            url,
            off,
            test,
            data_dir,
        } => run_notify(data_dir, url, off, test)?,
        Command::RotateKey { yes, data_dir } => run_rotate_key(data_dir, yes)?,
        Command::Revoke { name, id, data_dir } => run_revoke(data_dir, name, id)?,
        Command::Status { data_dir } => run_status(data_dir)?,
        Command::Types { output } => {
            let types = protocol::typescript();
            if let Some(path) = output {
                std::fs::write(path, types)?;
            } else {
                print!("{types}");
            }
        }
        Command::SeedBenchmark { data_dir, sessions } => {
            let mut store = Store::open(&data_dir)?;
            store.seed_archives(sessions)?;
            println!(
                "{}",
                json!({"seeded": sessions, "integrity": store.check()?})
            );
        }
        Command::SeedConversation { data_dir, turns } => {
            let mut store = Store::open(&data_dir)?;
            let session = store.seed_conversation(turns)?;
            println!(
                "{}",
                json!({"sessionId":session.id,"turns":turns,"records":turns*4})
            );
        }
        Command::Benchmark { data_dir } => {
            let start = Instant::now();
            let store = Store::open(&data_dir)?;
            let startup_ms = start.elapsed().as_secs_f64() * 1000.0;
            let mut queries = Vec::new();
            for _ in 0..31 {
                let start = Instant::now();
                let page = store.sessions(SessionQuery::default())?;
                if page.items.len() != 100 {
                    return Err("benchmark requires at least 100 sessions".into());
                }
                queries.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            println!(
                "{}",
                json!({"backend":"rust", "startupMs":startup_ms, "residentSessionObjects":0, "queryMs":queries, "peakRssMiB":peak_rss_mib()})
            );
        }
    }
    Ok(())
}

fn run_start(
    port: Option<u16>,
    bind: Option<String>,
    dev: bool,
    home: Option<PathBuf>,
    full_access: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if full_access {
        return Err("完整访问模式需要 Windows 管理员权限".into());
    }
    let home = prospero_home(home);
    let mut config = load_config_value(&home)?;
    let previous_port = config_port(&config)?;
    let raw_bind = bind.clone().or_else(|| config_bind(&config));
    let bind_spec = raw_bind.filter(|value| value != "0.0.0.0" && value != "::");
    let port = port.unwrap_or(previous_port);
    if port == 0 {
        return Err("监听端口无效".into());
    }
    if let Some(object) = config.as_object_mut() {
        if object.get("port").and_then(Value::as_u64) != Some(port.into()) {
            object.insert("port".into(), json!(port));
        }
        if bind.is_some() {
            if let Some(spec) = bind_spec.clone() {
                object.insert("bind".into(), json!(spec));
            } else {
                object.remove("bind");
            }
        }
    }
    save_config_value(&home, &config)?;
    let ip = match bind_spec.as_deref() {
        Some(spec) => resolve_bind_addr(spec)?,
        None => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
    };
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?
        .block_on(serve(home, SocketAddr::new(ip, port), false, dev))?;
    Ok(())
}

fn run_pair(
    data_dir: Option<PathBuf>,
    name: String,
    allow_shell: bool,
    allow_orchestration: bool,
    dev: bool,
) -> DaemonResult<()> {
    let home = prospero_home(data_dir);
    let identity = prosperod_rs::pairing::load_or_create_identity(&home)?;
    let config = prosperod_rs::relay::load_daemon_relay_config(&home)?;
    let port = config.port.unwrap_or(7423);
    if port == 0 {
        return Err(DaemonError::Invalid("daemon port is invalid".into()));
    }
    if let Some(relay) = config.relay.as_ref().filter(|relay| relay.enabled) {
        let Some(url) = prosperod_rs::relay::effective_relay_url(&config) else {
            return Err(DaemonError::Invalid(
                "relay configuration incomplete".into(),
            ));
        };
        let Some(secret) = relay
            .host_secret
            .as_deref()
            .filter(|secret| !secret.is_empty())
        else {
            return Err(DaemonError::Invalid(
                "relay configuration incomplete".into(),
            ));
        };
        prosperod_rs::relay::validate_relay_url(&url, dev)?;
        prosperod_rs::relay::derive_relay_route_id(secret)?;
    }
    let device = prosperod_rs::pairing::mint_device(&home, name, allow_shell, allow_orchestration)?;
    let issued = if config.relay.as_ref().is_some_and(|relay| relay.enabled) {
        prosperod_rs::pairing::issue_relay_credentials(&device)
    } else {
        device.clone()
    };
    let relay = relay_pairing_for_device(&config, &issued, dev)?;
    let addrs = pairing_addrs(config.bind.as_deref())?;
    if addrs.is_empty() && relay.is_none() {
        return Err(DaemonError::Invalid(
            "at least one direct address or relay is required".into(),
        ));
    }
    if addrs.is_empty() && relay.is_some() {
        println!("未发现可用网卡地址；将生成 relay-only 配对二维码。");
    }
    let payload = PairingPayload {
        v: 7,
        name: host_name(),
        addrs,
        port,
        token: issued.token.clone(),
        pub_key: identity.public_key,
        relay,
    };
    let url = encode_pairing_qr(&payload)?;
    if payload.relay.is_some() {
        prosperod_rs::pairing::persist_relay_credentials(&home, &issued)?;
    }
    println!(
        "设备「{}」已登记(allowShell={}, allowOrchestration={})",
        device.name,
        device.allow_shell,
        device.allow_orchestration.unwrap_or(device.allow_shell)
    );
    println!(
        "地址: {}  端口: {}",
        if payload.addrs.is_empty() {
            "(relay-only)".into()
        } else {
            payload.addrs.join(", ")
        },
        payload.port
    );
    if let Some(relay) = payload.relay.as_ref() {
        println!("中继: {}", relay.url);
    }
    println!("配对串(扫码不便时手动输入):\n{url}");
    println!("注意:二维码含访问凭证,请勿截图外传。daemon 重启无需重新配对。");
    Ok(())
}

fn run_relay(command: RelayCommand) -> DaemonResult<()> {
    match command {
        RelayCommand::Enable { url, dev, data_dir } => {
            let home = prospero_home(data_dir);
            let config = prosperod_rs::relay::load_daemon_relay_config(&home)?;
            let selected = url
                .clone()
                .or_else(|| prosperod_rs::relay::effective_relay_url(&config))
                .ok_or_else(|| {
                    DaemonError::Invalid(
                        "无法启用 relay：未设置 --url，且 PROSPERO_DEFAULT_RELAY_URL 不存在。"
                            .into(),
                    )
                })?;
            prosperod_rs::relay::validate_relay_url(&selected, dev)?;
            let previous = config.relay.as_ref();
            let saved_url = if url.is_some() {
                Some(selected.clone())
            } else {
                previous.and_then(|relay| relay.url.clone())
            };
            let secret = previous
                .and_then(|relay| relay.host_secret.clone())
                .filter(|secret| !secret.is_empty())
                .unwrap_or_else(prosperod_rs::relay::generate_relay_host_secret);
            prosperod_rs::relay::save_relay_config_raw(&home, true, saved_url, Some(secret))?;
            println!("relay 已启用：{selected}");
            println!("运行中的 daemon 会热加载此配置；新配对二维码会带 relay 凭证。");
        }
        RelayCommand::Disable { data_dir } => {
            let home = prospero_home(data_dir);
            let config = prosperod_rs::relay::load_daemon_relay_config(&home)?;
            let previous = config.relay.as_ref();
            prosperod_rs::relay::save_relay_config_raw(
                &home,
                false,
                previous.and_then(|relay| relay.url.clone()),
                previous.and_then(|relay| relay.host_secret.clone()),
            )?;
            println!("relay 已关闭；运行中的 daemon 会断开 relay 连接。");
        }
        RelayCommand::Status { json, data_dir } => {
            let home = prospero_home(data_dir);
            let result = relay_status_json(&home)?;
            if json {
                println!("{}", serde_json::to_string(&result)?);
            } else {
                let enabled = result
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let state = result
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or("disabled");
                println!("relay: {}", if enabled { state } else { "disabled" });
                println!(
                    "URL: {}",
                    result
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or("未配置")
                );
                let ready = result
                    .get("devices")
                    .and_then(|devices| devices.get("ready"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                println!("已就绪设备: {ready}");
                if result
                    .get("rePairRequired")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    let legacy = result
                        .get("devices")
                        .and_then(|devices| devices.get("needsRePair"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    println!("提示: {legacy} 台旧设备没有 relay 凭证，需重新配对；仍可直连。");
                }
                if let Some(error) = result.get("lastError").and_then(Value::as_str) {
                    println!("最近错误: {error}");
                }
            }
        }
        RelayCommand::RotateKey { yes, data_dir } => {
            let home = prospero_home(data_dir);
            if !yes {
                println!("这会轮换 relay host key，并移除所有设备的 relay 凭证。");
                println!("直连配对不会失效，但每台设备必须重新扫码才可继续经 relay 连接。");
                println!("确认请加 --yes 重跑: prosperod relay rotate-key --yes");
                return Ok(());
            }
            let config = prosperod_rs::relay::load_daemon_relay_config(&home)?;
            let (_, count) = prosperod_rs::relay::rotate_relay_key(&home, config)?;
            println!("已轮换 relay key；{count} 台设备需要重新配对后才能使用 relay。");
        }
    }
    Ok(())
}

async fn run_plugin(command: PluginCommand) -> DaemonResult<()> {
    let (home, method, params) = match command {
        PluginCommand::List { home } => (home, "plugin.list", json!({})),
        PluginCommand::Service { command } => match command {
            PluginServiceCommand::Status { home } => (home, "plugin.service.status", json!({})),
            PluginServiceCommand::Start {
                plugin_id,
                service_id,
                home,
            } => (
                home,
                "plugin.service.start",
                json!({"pluginId": plugin_id, "serviceId": service_id}),
            ),
            PluginServiceCommand::Stop {
                plugin_id,
                service_id,
                home,
            } => (
                home,
                "plugin.service.stop",
                json!({"pluginId": plugin_id, "serviceId": service_id}),
            ),
            PluginServiceCommand::Restart {
                plugin_id,
                service_id,
                home,
            } => (
                home,
                "plugin.service.restart",
                json!({"pluginId": plugin_id, "serviceId": service_id}),
            ),
            PluginServiceCommand::Health {
                plugin_id,
                service_id,
                home,
            } => (
                home,
                "plugin.service.health",
                json!({"pluginId": plugin_id, "serviceId": service_id}),
            ),
        },
    };
    let home = prosperod_rs::control_cli::prospero_home(home);
    let result = prosperod_rs::control_cli::control_method(&home, method, params).await?;
    print_json(&result)?;
    Ok(())
}

async fn run_schedule(command: ScheduleCommand) -> DaemonResult<()> {
    let (home, method, params) = match command {
        ScheduleCommand::List { home } => (home, "schedule.list", json!({})),
        ScheduleCommand::Get { id, home } => (home, "schedule.get", json!({"id": id})),
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
            home,
        } => (
            home,
            "schedule.create",
            strip_empty(json!({
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
                "operationId": operation_id,
            })),
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
            home,
        } => {
            if paused && enabled {
                return Err(DaemonError::Invalid(
                    "--paused 与 --enabled 不能同时使用".into(),
                ));
            }
            let mut body = serde_json::Map::new();
            body.insert("id".into(), json!(id));
            insert_optional(&mut body, "name", name);
            insert_optional(&mut body, "prompt", prompt);
            insert_optional(&mut body, "rrule", rrule);
            insert_optional(&mut body, "kind", kind);
            insert_optional(&mut body, "agent", agent);
            insert_optional(&mut body, "approvalPolicy", approval_policy);
            insert_clearable(&mut body, "accountId", account_id, clear_account);
            insert_optional(&mut body, "cwd", optional_absolute(cwd)?);
            insert_clearable(&mut body, "model", model, clear_model);
            insert_clearable(&mut body, "reasoningEffort", reasoning_effort, clear_effort);
            insert_clearable(&mut body, "mode", mode, clear_mode);
            insert_clearable(
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
            insert_optional(&mut body, "operationId", operation_id);
            (home, "schedule.update", Value::Object(body))
        }
        ScheduleCommand::Pause {
            id,
            operation_id,
            home,
        } => (
            home,
            "schedule.pause",
            json!({"id": id, "operationId": operation_id}),
        ),
        ScheduleCommand::Resume {
            id,
            operation_id,
            home,
        } => (
            home,
            "schedule.resume",
            json!({"id": id, "operationId": operation_id}),
        ),
        ScheduleCommand::Delete {
            id,
            operation_id,
            home,
        } => (
            home,
            "schedule.delete",
            json!({"id": id, "operationId": operation_id}),
        ),
        ScheduleCommand::Run {
            id,
            operation_id,
            home,
        } => (
            home,
            "schedule.run",
            json!({"id": id, "operationId": operation_id}),
        ),
    };
    let home = prosperod_rs::control_cli::prospero_home(home);
    let result = prosperod_rs::control_cli::control_method(&home, method, params).await?;
    print_json(&result)?;
    Ok(())
}

fn run_notify(
    data_dir: Option<PathBuf>,
    url: Option<String>,
    off: bool,
    test: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let home = prospero_home(data_dir);
    let mut config = load_config_value(&home)?;
    if off {
        config
            .as_object_mut()
            .ok_or_else(|| DaemonError::Invalid("invalid daemon config".into()))?
            .remove("notify");
        save_config_value(&home, &config)?;
        println!("推送已关闭");
        return Ok(());
    }
    if let Some(url) = url.filter(|url| !url.trim().is_empty()) {
        config
            .as_object_mut()
            .ok_or_else(|| DaemonError::Invalid("invalid daemon config".into()))?
            .insert("notify".into(), json!({ "url": url }));
        save_config_value(&home, &config)?;
        println!(
            "推送端点已保存:{}",
            notify_url(&load_config_value(&home)?).unwrap_or_default()
        );
    }
    let current = notify_url(&load_config_value(&home)?);
    let Some(current) = current else {
        println!("推送未配置。示例:");
        println!("  prosperod notify --url https://api.day.app/你的设备key   # Bark(iOS)");
        println!("  prosperod notify --url https://ntfy.sh/你的topic          # ntfy(Android)");
        return Ok(());
    };
    println!("当前端点:{current}");
    if test {
        let ok = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(send_test_notification(&current));
        println!(
            "{}",
            if ok {
                "测试推送已发出"
            } else {
                "测试推送失败(检查端点与网络)"
            }
        );
    }
    Ok(())
}

fn run_rotate_key(data_dir: Option<PathBuf>, yes: bool) -> DaemonResult<()> {
    let home = prospero_home(data_dir);
    let devices = prosperod_rs::pairing::load_devices(&home)?;
    if !yes {
        println!("这会更换 daemon 的身份密钥,并清空已配对设备。");
        println!("当前已配对 {} 台,全部需要重新扫码。", devices.len());
        println!("确认请加 --yes 重跑:prosperod rotate-key --yes");
        return Ok(());
    }
    let fresh = prosperod_rs::pairing::rotate_identity(&home)?;
    println!("已更换身份密钥,新公钥 {}...", &fresh.public_key[..12]);
    println!(
        "已清空 {} 台设备的配对,请重新运行 prosperod pair。",
        devices.len()
    );
    println!("正在运行的 daemon 需要重启才会使用新密钥。");
    Ok(())
}

fn run_revoke(
    data_dir: Option<PathBuf>,
    name: Option<String>,
    id: Option<String>,
) -> DaemonResult<()> {
    let home = prospero_home(data_dir);
    match (name, id) {
        (None, None) | (Some(_), Some(_)) => Err(DaemonError::Invalid(
            "请提供设备名或 --id，且只能选择一种".into(),
        )),
        (None, Some(id)) => {
            let Some(removed) = prosperod_rs::pairing::revoke_device(&home, &id)? else {
                return Err(DaemonError::Invalid(format!("没有 id 为「{id}」的设备")));
            };
            println!("已撤销设备「{}」", removed.name);
            println!("运行中的 daemon 会立刻断开它;手机需要重新扫码才能再连。");
            Ok(())
        }
        (Some(name), None) => {
            let removed = revoke_devices_by_name(&home, &name)?;
            if removed.is_empty() {
                let names = prosperod_rs::pairing::load_devices(&home)?
                    .into_iter()
                    .map(|device| device.name)
                    .collect::<Vec<_>>();
                return Err(DaemonError::Invalid(if names.is_empty() {
                    format!("没有名为「{name}」的设备(当前一台都没配对)")
                } else {
                    format!("没有名为「{name}」的设备。已配对:{}", names.join(", "))
                }));
            }
            println!("已撤销 {} 台名为「{}」的设备", removed.len(), name);
            println!("运行中的 daemon 会立刻断开它;手机需要重新扫码才能再连。");
            Ok(())
        }
    }
}

fn run_status(data_dir: Option<PathBuf>) -> DaemonResult<()> {
    let home = prospero_home(data_dir);
    let identity = prosperod_rs::pairing::load_or_create_identity(&home)?;
    let config = prosperod_rs::relay::load_daemon_relay_config(&home)?;
    let config_value = load_config_value(&home)?;
    let devices = prosperod_rs::pairing::load_devices(&home)?;
    println!("home:      {}", home.display());
    println!("身份公钥:  {}...", &identity.public_key[..12]);
    println!("端口:      {}(默认 7423)", config.port.unwrap_or(7423));
    println!(
        "推送:      {}",
        notify_url(&config_value).unwrap_or_else(|| "未配置".into())
    );
    println!(
        "监听:      {}",
        config.bind.as_deref().unwrap_or("0.0.0.0(全部网卡)")
    );
    println!(
        "候选地址:  {}",
        candidate_addrs().join(", ").if_empty("(无)")
    );
    println!("设备({}):", devices.len());
    for device in devices {
        let seen = device
            .last_seen_at
            .map(|value| value.to_string())
            .unwrap_or_else(|| "从未连接".into());
        println!(
            "  - {}  allowShell={}  allowOrchestration={}  绑定={}  最近: {}",
            device.name,
            device.allow_shell,
            device.allow_orchestration.unwrap_or(device.allow_shell),
            if device.client_pub_key.is_some() {
                "已绑定"
            } else {
                "未绑定"
            },
            seen
        );
    }
    Ok(())
}

fn print_json(value: &Value) -> DaemonResult<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn optional_absolute(path: Option<PathBuf>) -> DaemonResult<Option<String>> {
    path.map(|path| {
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()?.join(path)
        };
        Ok(path.to_string_lossy().into_owned())
    })
    .transpose()
}

fn insert_optional(map: &mut serde_json::Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        map.insert(key.into(), json!(value));
    }
}

fn insert_clearable(
    map: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<String>,
    clear: bool,
) {
    if clear {
        map.insert(key.into(), Value::Null);
    } else {
        insert_optional(map, key, value);
    }
}

fn strip_empty(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    value
}

async fn send_test_notification(url: &str) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .post(url)
        .json(&json!({
            "title": "Prospero 测试推送",
            "body": "如果你看到这条,推送通道已打通。",
            "message": "如果你看到这条,推送通道已打通。",
            "group": "Prospero",
            "tags": ["warning"],
            "level": "timeSensitive",
            "url": "prospero://",
            "click": "prospero://"
        }))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingPayload {
    v: u8,
    name: String,
    addrs: Vec<String>,
    port: u16,
    token: String,
    #[serde(rename = "pubKey")]
    pub_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    relay: Option<RelayPairing>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayPairing {
    v: u8,
    url: String,
    route_id: String,
    device_id: String,
    token: String,
}

fn relay_pairing_for_device(
    config: &prosperod_rs::relay::DaemonRelayConfig,
    device: &prosperod_rs::pairing::DeviceRecord,
    dev: bool,
) -> DaemonResult<Option<RelayPairing>> {
    let Some(relay) = config.relay.as_ref().filter(|relay| relay.enabled) else {
        return Ok(None);
    };
    let Some(host_secret) = relay
        .host_secret
        .as_deref()
        .filter(|secret| !secret.is_empty())
    else {
        return Ok(None);
    };
    let Some(url) = prosperod_rs::relay::effective_relay_url(config) else {
        return Ok(None);
    };
    let Some(device_id) = device.relay_device_id.clone() else {
        return Ok(None);
    };
    let Some(token) = device.relay_token.clone() else {
        return Ok(None);
    };
    prosperod_rs::relay::validate_relay_url(&url, dev)?;
    Ok(Some(RelayPairing {
        v: prosperod_rs::relay::RELAY_PROTOCOL_VERSION,
        url,
        route_id: prosperod_rs::relay::derive_relay_route_id(host_secret)?,
        device_id,
        token,
    }))
}

fn encode_pairing_qr(payload: &PairingPayload) -> DaemonResult<String> {
    let bytes = serde_json::to_vec(payload)?;
    Ok(format!(
        "prospero://pair?d={}",
        BASE64_URL_SAFE_NO_PAD.encode(bytes)
    ))
}

fn relay_status_json(home: &Path) -> DaemonResult<Value> {
    let config = prosperod_rs::relay::load_daemon_relay_config(home)?;
    let devices = prosperod_rs::pairing::load_devices(home)?;
    let url = prosperod_rs::relay::effective_relay_url(&config);
    let route_id = config
        .relay
        .as_ref()
        .and_then(|relay| relay.host_secret.as_deref())
        .and_then(|secret| prosperod_rs::relay::derive_relay_route_id(secret).ok());
    let runtime = std::fs::read_to_string(home.join("status.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|status| status.get("relay").cloned());
    let legacy = devices
        .iter()
        .filter(|device| prosperod_rs::relay::device_relay_credentials(device).is_none())
        .count();
    let mut result = json!({
        "enabled": config.relay.as_ref().is_some_and(|relay| relay.enabled),
        "url": url,
        "routeId": route_id,
        "state": runtime.as_ref().and_then(|relay| relay.get("state")).cloned().unwrap_or_else(|| {
            if config.relay.as_ref().is_some_and(|relay| relay.enabled) {
                json!("offline")
            } else {
                json!("disabled")
            }
        }),
        "updatedAt": runtime.as_ref().and_then(|relay| relay.get("updatedAt")).cloned().unwrap_or(Value::Null),
        "lastConnectedAt": runtime.as_ref().and_then(|relay| relay.get("lastConnectedAt")).cloned().unwrap_or(Value::Null),
        "lastError": runtime.as_ref().and_then(|relay| relay.get("lastError")).cloned().unwrap_or(Value::Null),
        "devices": runtime.as_ref().and_then(|relay| relay.get("devices")).cloned().unwrap_or_else(|| json!({
            "total": devices.len(),
            "ready": 0,
            "needsRePair": legacy
        })),
        "rePairRequired": legacy > 0
    });
    if let Some(object) = result.as_object_mut() {
        for key in ["activeStreams", "streamFailures", "lastStreamError"] {
            if let Some(value) = runtime.as_ref().and_then(|relay| relay.get(key)).cloned() {
                object.insert(key.into(), value);
            }
        }
    }
    Ok(result)
}

fn revoke_devices_by_name(
    home: &Path,
    name: &str,
) -> DaemonResult<Vec<prosperod_rs::pairing::DeviceRecord>> {
    let devices = prosperod_rs::pairing::load_devices(home)?;
    let mut removed = Vec::new();
    let mut kept = Vec::new();
    for device in devices {
        if device.name == name {
            removed.push(device);
        } else {
            kept.push(device);
        }
    }
    if !removed.is_empty() {
        prosperod_rs::pairing::save_devices(home, &kept)?;
    }
    Ok(removed)
}

trait EmptyText {
    fn if_empty(self, fallback: &str) -> String;
}

impl EmptyText for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.into()
        } else {
            self
        }
    }
}

fn prospero_home(data_dir: Option<PathBuf>) -> PathBuf {
    prosperod_rs::control_cli::prospero_home(data_dir)
}

fn load_config_value(home: &Path) -> DaemonResult<Value> {
    let path = home.join("config.json");
    if !path.exists() {
        return Ok(json!({ "port": 7423 }));
    }
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    if !value.is_object() {
        return Err(DaemonError::Invalid("invalid daemon config".into()));
    }
    Ok(value)
}

fn save_config_value(home: &Path, config: &Value) -> DaemonResult<()> {
    if !config.is_object() {
        return Err(DaemonError::Invalid("invalid daemon config".into()));
    }
    prosperod_rs::pairing::write_private_json(home, "config.json", config)
}

fn config_port(config: &Value) -> DaemonResult<u16> {
    match config.get("port").and_then(Value::as_u64) {
        Some(value) => u16::try_from(value)
            .ok()
            .filter(|port| *port > 0)
            .ok_or_else(|| DaemonError::Invalid("daemon port is invalid".into())),
        None => Ok(7423),
    }
}

fn config_bind(config: &Value) -> Option<String> {
    config
        .get("bind")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn notify_url(config: &Value) -> Option<String> {
    config
        .get("notify")
        .and_then(|notify| notify.get("url"))
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .map(str::to_owned)
}

fn host_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Prospero".into())
}

fn pairing_addrs(bind: Option<&str>) -> DaemonResult<Vec<String>> {
    let Some(bind) = bind.filter(|value| *value != "0.0.0.0" && *value != "::") else {
        return Ok(candidate_addrs());
    };
    let ip = resolve_bind_addr(bind)?;
    if ip.is_unspecified() {
        Ok(candidate_addrs())
    } else {
        Ok(vec![ip.to_string()])
    }
}

fn resolve_bind_addr(spec: &str) -> DaemonResult<IpAddr> {
    if let Ok(ip) = spec.parse::<IpAddr>() {
        return Ok(ip);
    }
    named_interface_addr(spec).ok_or_else(|| {
        DaemonError::Invalid(format!(
            "本机没有地址或网卡叫 \"{}\"。当前可用:\n{}",
            spec,
            interface_listing().if_empty("(无)")
        ))
    })
}

fn candidate_addrs() -> Vec<String> {
    let mut en = Vec::new();
    let mut utun = Vec::new();
    let mut other = Vec::new();
    for (name, ip) in interface_addrs() {
        if unusable_addr(&ip) {
            continue;
        }
        let value = ip.to_string();
        if en.contains(&value) || utun.contains(&value) || other.contains(&value) {
            continue;
        }
        if name.starts_with("en") {
            en.push(value);
        } else if name.starts_with("utun") {
            utun.push(value);
        } else {
            other.push(value);
        }
    }
    en.into_iter().chain(utun).chain(other).collect()
}

fn named_interface_addr(name: &str) -> Option<IpAddr> {
    interface_addrs()
        .into_iter()
        .find_map(|(candidate, ip)| (candidate == name).then_some(IpAddr::V4(ip)))
}

fn interface_listing() -> String {
    interface_addrs()
        .into_iter()
        .map(|(name, ip)| format!("  {name:8} {ip}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn unusable_addr(addr: &Ipv4Addr) -> bool {
    let octets = addr.octets();
    (octets[0] == 198 && (octets[1] == 18 || octets[1] == 19))
        || (octets[0] == 169 && octets[1] == 254)
        || octets[3] == 0
}

#[cfg(unix)]
fn interface_addrs() -> Vec<(String, Ipv4Addr)> {
    use std::ffi::CStr;
    let mut head = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = head;
    while !cursor.is_null() {
        let item = unsafe { &*cursor };
        if !item.ifa_addr.is_null()
            && unsafe { (*item.ifa_addr).sa_family as i32 } == libc::AF_INET
            && (item.ifa_flags & libc::IFF_LOOPBACK as u32) == 0
        {
            let name = unsafe { CStr::from_ptr(item.ifa_name) }
                .to_string_lossy()
                .into_owned();
            let addr = unsafe { &*(item.ifa_addr as *const libc::sockaddr_in) };
            out.push((name, Ipv4Addr::from(addr.sin_addr.s_addr.to_ne_bytes())));
        }
        cursor = item.ifa_next;
    }
    unsafe {
        libc::freeifaddrs(head);
    }
    out
}

#[cfg(not(unix))]
fn interface_addrs() -> Vec<(String, Ipv4Addr)> {
    Vec::new()
}

async fn serve(
    directory: PathBuf,
    address: SocketAddr,
    local_only: bool,
    dev_mode: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    use prosperod_rs::{auth::Token, server::Api, transport::LimitedListener, worker::Database};
    if local_only && !address.ip().is_loopback() {
        return Err("the local API must bind to loopback".into());
    }
    let database = Database::open(directory.clone()).await?;
    // Orphaned DAG dispatches from a crashed process are reconciled in one
    // set-based pass before the API accepts traffic (Stage 7 batch recovery).
    let recovery = database.call(|store| store.recover_dispatches()).await?;
    if !recovery.settled.is_empty() || !recovery.resumed.is_empty() {
        eprintln!(
            "recovered orchestration dispatches: {} settled, {} resumed",
            recovery.settled.len(),
            recovery.resumed.len()
        );
    }
    let token = Token::load(&directory)?;
    // Keep inherited HTTP endpoints and direct-device reconnects usable when
    // an ephemeral listener can reclaim its previous port. Explicit ports are
    // never changed; the CLI's connection-file discovery covers fallback.
    let previous_port = if address.port() == 0 {
        std::fs::File::open(directory.join("connection.json"))
            .and_then(|file| {
                let mut bytes = Vec::new();
                file.take(16_385).read_to_end(&mut bytes)?;
                Ok(bytes)
            })
            .ok()
            .filter(|bytes| bytes.len() <= 16_384)
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| {
                value["baseUrl"]
                    .as_str()
                    .and_then(|url| url::Url::parse(url).ok())
            })
            .filter(|url| {
                url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                    && url.username().is_empty()
                    && url.password().is_none()
            })
            .and_then(|url| url.port())
            .filter(|port| *port != 0)
    } else {
        None
    };
    let listener = if let Some(port) = previous_port {
        match tokio::net::TcpListener::bind(SocketAddr::new(address.ip(), port)).await {
            Ok(listener) => listener,
            Err(_) => tokio::net::TcpListener::bind(address).await?,
        }
    } else {
        tokio::net::TcpListener::bind(address).await?
    };
    let address = listener.local_addr()?;
    let local_address = if address.ip().is_unspecified() {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), address.port())
    } else {
        address
    };
    let base_url = format!("http://{local_address}");
    let control_token = token.value().to_owned();
    token.publish(&directory, &base_url)?;
    let current_exe = std::env::current_exe()?;
    let cli_dir = current_exe.parent().map(Path::to_path_buf);
    let api = Api::with_guard(database.clone(), token, Some(current_exe)).with_dev_mode(dev_mode);
    let control_token_path = directory.join("control.token");
    std::fs::write(&control_token_path, &control_token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&control_token_path, std::fs::Permissions::from_mode(0o600))?;
    }
    api.plugin_services.configure(
        address.port(),
        control_token_path.clone(),
        prosperod_rs::plugins::control_socket_path(&directory),
    );
    let control_socket_path = prosperod_rs::plugins::control_socket_path(&directory);
    api.agents.configure_control_environment(
        base_url.clone(),
        control_token_path.clone(),
        control_socket_path.clone(),
        cli_dir.clone(),
    );
    api.terminals.configure_control_environment(
        base_url.clone(),
        control_token_path,
        control_socket_path,
        cli_dir,
    );
    api.terminals.recover().await?;
    // A completed cross-model child can outlive the stream callback that
    // normally records its result.  Reconcile persisted terminal children on
    // startup *before* generic agent crash recovery so a finished provider
    // turn remains completed rather than being mislabeled as a failed stale
    // structured run.
    if api.agents.reconcile_cross_model_children().await? > 0 {
        api.publish();
    }
    // Stale agent runs belonged to the previous process; archive them
    // without replaying turns.
    let recovered_agents = api.agents.recover().await?;
    if recovered_agents > 0 {
        api.publish();
    }
    api.schedules.start().await;
    api.plugin_services.start_auto().await;
    let running_automations = database
        .call(|store| {
            Ok(store
                .list_runs()?
                .into_iter()
                .filter(|run| {
                    matches!(
                        run.automation.as_ref().map(|automation| automation.state),
                        Some(prosperod_rs::orchestration::AutomationState::Running)
                    )
                })
                .map(|run| run.id)
                .collect::<Vec<_>>())
        })
        .await?;
    for run_id in running_automations {
        let database = api.database.clone();
        let agents = api.agents.clone();
        let changes = api.clone();
        tokio::spawn(async move {
            prosperod_rs::orchestration::kick_automation(&database, &agents, &run_id).await;
            changes.publish();
        });
    }
    let shutdown_api = api.clone();
    let (stopping, mut stopped) = tokio::sync::watch::channel(false);
    let status_bind = if address.ip().is_unspecified() {
        None
    } else {
        Some(address.ip().to_string())
    };
    let projection_api = api.clone();
    let projection_stopped = stopped.clone();
    let projection_task = tokio::spawn(async move {
        projection_api
            .run_status_projection(
                address.port(),
                status_bind,
                control_token,
                projection_stopped,
            )
            .await;
    });
    let relay_task = tokio::spawn(prosperod_rs::relay::run_relay_supervisor(
        directory.clone(),
        format!("ws://{local_address}/ws"),
        dev_mode,
        api.relay_status.clone(),
        stopped.clone(),
        prosperod_rs::relay::RelaySupervisorOptions::default(),
    ));
    let shutdown = async move {
        tokio::select! { _ = wait_for_shutdown() => {}, _ = shutdown_api.wait_stopped() => {} }
        shutdown_api.stop();
        shutdown_api.schedules.close();
        shutdown_api.plugin_services.stop_all().await;
        let _ = shutdown_api.agents.shutdown().await;
        let _ = shutdown_api.terminals.shutdown().await;
        stopping.send_replace(true);
    };
    let server = axum::serve(LimitedListener::new(listener), api.router())
        .with_graceful_shutdown(shutdown)
        .into_future();
    tokio::pin!(server);
    println!(
        "{}",
        json!({"event":"ready","apiVersion":protocol::API_VERSION,"baseUrl":base_url,"pid":std::process::id()})
    );
    tokio::select! {
        result = &mut server => result?,
        _ = stopped.changed() => { let _ = tokio::time::timeout(std::time::Duration::from_secs(2), &mut server).await; }
    }
    api.stop();
    api.plugin_services.stop_all().await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), relay_task).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), projection_task).await;
    let terminals_stopped = api.terminals.shutdown().await;
    let agents_stopped = api.agents.shutdown().await;
    let _ = std::fs::remove_file(directory.join("connection.json"));
    let _ = std::fs::remove_file(directory.join("control.token"));
    let _ = std::fs::remove_file(directory.join("status.json"));
    let database_stopped = database.shutdown().await;
    terminals_stopped?;
    agents_stopped?;
    database_stopped?;
    Ok(())
}

async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("signal registration");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn peak_rss_mib() -> Option<f64> {
    #[cfg(unix)]
    {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        let status = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
        if status != 0 {
            return None;
        }
        let usage = unsafe { usage.assume_init() };
        #[cfg(target_os = "macos")]
        return Some(usage.ru_maxrss as f64 / 1024.0 / 1024.0);
        #[cfg(not(target_os = "macos"))]
        return Some(usage.ru_maxrss as f64 / 1024.0);
    }
    #[cfg(not(unix))]
    None
}
