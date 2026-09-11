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
    Benchmark {
        #[arg(long)]
        data_dir: PathBuf,
    },
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    match Arguments::parse().command {
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
