use std::path::PathBuf;

use clap::Parser;
use prosperod_rs::execution_host::{HostConfig, serve};

#[derive(Parser)]
#[command(name = "prospero-execution-host", version)]
struct Arguments {
    #[arg(long)]
    data_dir: PathBuf,
    #[arg(long)]
    socket: PathBuf,
    #[arg(long)]
    token_file: PathBuf,
    #[arg(long)]
    host_id: String,
    #[arg(long)]
    host_epoch: String,
}

#[tokio::main(worker_threads = 2)]
async fn main() {
    let arguments = Arguments::parse();
    let result = serve(HostConfig {
        data_dir: arguments.data_dir,
        socket_path: arguments.socket,
        token_file: arguments.token_file,
        host_id: arguments.host_id,
        host_epoch: arguments.host_epoch,
    })
    .await;
    if let Err(error) = result {
        eprintln!("execution Host stopped: {error}");
        std::process::exit(1);
    }
}
