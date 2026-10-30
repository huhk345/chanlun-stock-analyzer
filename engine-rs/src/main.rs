//! A-share stock-pool backtest service built on the barter-rs framework.
//!
//! `strategy` is a contract for strategy authors: helpers a built-in strategy
//! happens not to call (e.g. `Signal::buy_shares`, `ctx.params`) are still part
//! of the public surface, so dead-code warnings are noise here.
#![allow(dead_code)]

mod api;
mod barter_engine;
mod chanlun;
mod data;
mod indicators;
mod metrics;
mod strategies;
mod strategy;
mod update;

use std::net::SocketAddr;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,chanlun_engine_rs=info".into()),
        )
        .init();

    // Repository root: `--root <path>` or the crate's parent directory.
    let mut root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut port: u16 = 8901;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--root" => {
                if let Some(v) = args.next() {
                    root = PathBuf::from(v);
                }
            }
            "--port" => {
                if let Some(v) = args.next() {
                    port = v.parse().unwrap_or(port);
                }
            }
            other => eprintln!("unknown argument: {other}"),
        }
    }

    let state = api::AppState::new(root.clone());
    let app = api::router(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(
        "chanlun-engine-rs listening on http://{addr} (root: {})",
        root.display()
    );
    axum::serve(listener, app).await?;
    Ok(())
}
