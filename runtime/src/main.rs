#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((command, tail)) = args.split_first() else {
        eprintln!("Usage: codex-panel-runtime serve|inject|ctl|turn-owner|models|pet-animations [options]");
        std::process::exit(2);
    };
    let result = match command.as_str() {
        "serve" => codex_panel_runtime::server::run(tail).await,
        "inject" => codex_panel_runtime::injector::run(tail).await,
        "turn-owner" => codex_panel_runtime::server::run_turn_owner(tail).await,
        "pet-animations" => codex_panel_runtime::pets::run(tail)
            .await
            .map(|value| println!("{value}")),
        "models" => codex_panel_runtime::models::run(tail)
            .await
            .map(|value| println!("{value}")),
        "ctl" => std::process::exit(codex_panel_runtime::cli::run(tail).await),
        "--help" | "-h" => {
            println!("Usage: codex-panel-runtime serve|inject|ctl|turn-owner|models|pet-animations [options]");
            Ok(())
        }
        _ => Err(codex_panel_runtime::ApiError::new(
            400,
            "USAGE_ERROR",
            "Unknown runtime command",
        )),
    };
    if let Err(error) = result {
        eprintln!("{}", error.json());
        std::process::exit(1);
    }
}
