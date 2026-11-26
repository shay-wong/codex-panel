#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(codex_panel_runtime::cli::run(&args).await);
}
