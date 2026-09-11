use std::future::IntoFuture;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Instant;

use clap::{Parser, Subcommand};
use prosperod_rs::database::Store;
use prosperod_rs::protocol::{self, SessionQuery};
use serde_json::json;

#[derive(Parser)]
#[command(name = "prosperod-rs", version)]
struct Arguments {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
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
    Serve {
        #[arg(long)]
        data_dir: PathBuf,
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match Arguments::parse().command {
        #[cfg(unix)]
        Command::TerminalGuard {
            parent,
            shell,
            args,
        } => {
            std::process::exit(prosperod_rs::terminal::guard::run(parent, shell, args)?);
        }
        Command::Serve { data_dir, listen } => {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?
                .block_on(serve(data_dir, listen))?;
        }
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

async fn serve(directory: PathBuf, address: SocketAddr) -> Result<(), Box<dyn std::error::Error>> {
    use prosperod_rs::{auth::Token, server::Api, transport::LimitedListener, worker::Database};
    if !address.ip().is_loopback() {
        return Err("the local API must bind to loopback".into());
    }
    let database = Database::open(directory.clone()).await?;
    database.call(|store| store.recover_terminals()).await?;
    let token = Token::load(&directory)?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let address = listener.local_addr()?;
    let base_url = format!("http://{address}");
    token.publish(&directory, &base_url)?;
    let api = Api::with_guard(database.clone(), token, Some(std::env::current_exe()?));
    let shutdown_api = api.clone();
    let (stopping, mut stopped) = tokio::sync::watch::channel(false);
    let shutdown = async move {
        tokio::select! { _ = wait_for_shutdown() => {}, _ = shutdown_api.wait_stopped() => {} }
        shutdown_api.stop();
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
    let terminals_stopped = api.terminals.shutdown().await;
    let _ = std::fs::remove_file(directory.join("connection.json"));
    let database_stopped = database.shutdown().await;
    terminals_stopped?;
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
