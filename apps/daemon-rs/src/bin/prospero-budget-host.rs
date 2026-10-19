use clap::Parser;
use prosperod_rs::execution_budget::{BudgetConfig, default_directory, serve};
use std::path::PathBuf;

#[derive(Parser)]
struct Arguments {
    #[arg(long)]
    directory: Option<PathBuf>,
    #[arg(long)]
    capacity: u32,
}

#[tokio::main(worker_threads = 2)]
async fn main() {
    let arguments = Arguments::parse();
    let directory = arguments
        .directory
        .map(Ok)
        .unwrap_or_else(default_directory);
    let result = match directory {
        Ok(directory) => {
            serve(BudgetConfig {
                directory,
                capacity: arguments.capacity,
            })
            .await
        }
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        eprintln!("execution budget stopped: {error}");
        std::process::exit(1);
    }
}
