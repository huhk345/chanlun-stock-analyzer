//! HTTP surface. The browser never runs the engine: it posts a simulation
//! request, receives the whole recorded run, then scrubs it locally.

use crate::barter_engine::{self, DayRow, SimConfig, SimOutput};
use crate::data::{self, LoadRequest, PoolKind};
use crate::strategy::Params;
use crate::update::{self, UpdateConfig, UpdateMode, UpdateProgress};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tower_http::{compression::CompressionLayer, cors::CorsLayer};

type Job = Arc<Mutex<UpdateProgress>>;

#[derive(Clone)]
pub struct AppState {
    pub root: PathBuf,
    pub runs: Arc<Mutex<HashMap<String, Arc<SimOutput>>>>,
    /// Pool-refresh jobs, keyed by job id (kept after completion for polling).
    pub jobs: Arc<Mutex<HashMap<String, Job>>>,
}

impl AppState {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            runs: Arc::new(Mutex::new(HashMap::new())),
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/rust/health", get(health))
        .route("/api/rust/strategies", get(strategies))
        .route("/api/rust/pools", get(pools))
        .route("/api/rust/pool/coverage", get(pool_coverage))
        .route("/api/rust/pool/update", post(start_pool_update))
        .route("/api/rust/pool/update/{id}", get(pool_update_status))
        .route("/api/rust/sim", post(start_sim))
        .route("/api/rust/sim/{id}", get(get_sim))
        .route("/api/rust/sim/{id}/timeline", get(get_timeline))
        .route("/api/rust/sim/{id}/step", post(step))
        .route("/api/rust/kline/{symbol}", get(kline))
        .layer(CompressionLayer::new())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimRequest {
    #[serde(default = "default_strategy")]
    pub strategy_id: String,
    #[serde(default)]
    pub params: Option<Value>,
    #[serde(default)]
    pub pools: Vec<String>,
    #[serde(default)]
    pub custom: Vec<String>,
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub initial_cash: Option<f64>,
    #[serde(default)]
    pub commission_rate: Option<f64>,
    #[serde(default)]
    pub min_commission: Option<f64>,
    #[serde(default)]
    pub stamp_duty_rate: Option<f64>,
    #[serde(default)]
    pub transfer_fee_rate: Option<f64>,
    #[serde(default)]
    pub lot_size: Option<f64>,
    /// Hard floor on a newly opened position (CNY), default 5000.
    #[serde(default)]
    pub min_position_value: Option<f64>,
    #[serde(default)]
    pub t_plus_1: Option<bool>,
    #[serde(default)]
    pub stop_loss_percent: Option<f64>,
    /// Refresh stale pool data before the run (default true).
    #[serde(default)]
    pub auto_refresh: Option<bool>,
    /// 从股票池里剔除的板块: "chinext" / "star" / "bse" (ST/退市 恒定剔除)
    #[serde(default)]
    pub exclude_boards: Vec<String>,
}

fn default_strategy() -> String {
    "ma-cross".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRequest {
    /// `next` | `prev` | `jump`
    pub action: String,
    #[serde(default)]
    pub index: Option<usize>,
}

#[derive(Serialize)]
pub struct StepResponse {
    pub index: usize,
    pub total: usize,
    pub day: DayRow,
}

fn parse_date(raw: &Option<String>) -> Result<Option<NaiveDate>, String> {
    match raw {
        None => Ok(None),
        Some(s) if s.trim().is_empty() => Ok(None),
        Some(s) => NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
            .map(Some)
            .map_err(|_| format!("bad date: {s}")),
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "framework": barter_engine::FRAMEWORK,
        "engine": "barter-rs engine + A-share execution layer",
    }))
}

/// 单只标的的日线（前端点开个股画 K 线用）。只读本地缓存，不联网。
async fn kline(State(state): State<AppState>, Path(symbol): Path<String>) -> impl IntoResponse {
    match data::load_symbol_bars(&state.root, &symbol) {
        Ok(bars) => {
            let rows: Vec<Value> = bars
                .iter()
                .map(|b| {
                    json!({
                        "date": b.date.format("%Y-%m-%d").to_string(),
                        "open": b.open,
                        "high": b.high,
                        "low": b.low,
                        "close": b.close,
                        "volume": b.volume,
                        "amount": b.amount,
                    })
                })
                .collect();
            Json(json!({ "symbol": symbol, "bars": rows })).into_response()
        }
        Err(err) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn strategies() -> impl IntoResponse {
    let list: Vec<Value> = crate::strategies::STRATEGIES
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "name": m.name,
                "description": m.description,
                "params": (m.params)(),
            })
        })
        .collect();
    Json(json!({ "strategies": list }))
}

async fn pools(State(state): State<AppState>) -> impl IntoResponse {
    let mut out = Vec::new();
    for pool in [PoolKind::Hs300, PoolKind::Zz500] {
        let path = state.root.join("public").join(pool.members_file());
        let size = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
            .map(|v| v.len())
            .unwrap_or(0);
        out.push(json!({
            "id": match pool { PoolKind::Hs300 => "hs300", PoolKind::Zz500 => "zz500" },
            "label": pool.label(),
            "size": size,
        }));
    }
    Json(json!({ "pools": out }))
}

#[derive(Debug, Deserialize)]
pub struct CoverageQuery {
    #[serde(default)]
    pub pools: Option<String>,
}

fn parse_pools(raw: &[String]) -> Vec<PoolKind> {
    raw.iter().filter_map(|p| PoolKind::parse(p)).collect()
}

async fn pool_coverage(
    State(state): State<AppState>,
    Query(query): Query<CoverageQuery>,
) -> impl IntoResponse {
    let requested: Vec<String> = query
        .pools
        .unwrap_or_else(|| "hs300,zz500".into())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let pools = parse_pools(&requested);
    let root = state.root.clone();
    let (pools, index_updated_at) =
        tokio::task::spawn_blocking(move || update::coverage(&root, &pools))
            .await
            .unwrap_or_default();
    Json(json!({
        "pools": pools,
        "indexUpdatedAt": index_updated_at,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRequest {
    #[serde(default)]
    pub pools: Vec<String>,
    #[serde(default)]
    pub custom: Vec<String>,
    /// "incremental" (default) | "full"
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub adjust_tolerance: Option<f64>,
}

async fn start_pool_update(
    State(state): State<AppState>,
    Json(req): Json<UpdateRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let pools = parse_pools(&req.pools);
    let symbols = update::pool_symbols(&state.root, &pools, &req.custom);
    if symbols.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "池内没有可更新的标的".into()));
    }

    let cfg = UpdateConfig {
        mode: UpdateMode::parse(req.mode.as_deref().unwrap_or("incremental")),
        adjust_tolerance: req.adjust_tolerance.unwrap_or(0.0005).clamp(1e-6, 0.5),
        ..Default::default()
    };

    let mode_label = match cfg.mode {
        UpdateMode::Full => "full",
        UpdateMode::Incremental => "incremental",
    };
    let id = format!("upd-{}", chrono::Utc::now().timestamp_millis());
    let total = symbols.len();
    let job: Job = Arc::new(Mutex::new(UpdateProgress::new(id.clone(), total)));
    state.jobs.lock().unwrap().insert(id.clone(), Arc::clone(&job));

    let root = state.root.clone();
    tokio::spawn(async move {
        update::run_update(root, symbols, cfg, job).await;
    });

    Ok(Json(json!({
        "jobId": id,
        "total": total,
        "mode": mode_label,
    })))
}

async fn pool_update_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let job = state
        .jobs
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or((StatusCode::NOT_FOUND, "job not found".to_string()))?;
    let progress = job.lock().unwrap().clone();
    Ok(Json(serde_json::to_value(progress).unwrap_or(Value::Null)))
}

async fn start_sim(
    State(state): State<AppState>,
    Json(req): Json<SimRequest>,
) -> Result<Json<SimOutput>, (StatusCode, String)> {
    let mut pools = parse_pools(&req.pools);
    if pools.is_empty() {
        pools = vec![PoolKind::Hs300];
    }

    let start = parse_date(&req.start).map_err(|e| (StatusCode::BAD_REQUEST, e))?;
    let end = parse_date(&req.end).map_err(|e| (StatusCode::BAD_REQUEST, e))?;

    // Pull the stale tail (and heal truncated histories) before the engine reads
    // the cache — the run is never silently based on yesterday's bars.
    let refresh = if req.auto_refresh.unwrap_or(true) {
        let symbols = update::pool_symbols(&state.root, &pools, &req.custom);
        let cfg = UpdateConfig {
            rps: 15.0,
            concurrency: 6,
            ..Default::default()
        };
        Some(update::auto_refresh(state.root.clone(), symbols, cfg).await)
    } else {
        None
    };

    let mut load = LoadRequest::new(state.root.clone());
    load.pools = pools.clone();
    load.extra_symbols = req.custom.clone();
    load.start = start;
    load.end = end;
    load.limit = req.limit;
    load.exclude_boards = req.exclude_boards.clone();

    let mut cfg = SimConfig::default();
    if let Some(v) = req.initial_cash {
        cfg.initial_cash = v.max(1000.0);
    }
    if let Some(v) = req.commission_rate {
        cfg.commission_rate = v;
    }
    if let Some(v) = req.min_commission {
        cfg.min_commission = v;
    }
    if let Some(v) = req.stamp_duty_rate {
        cfg.stamp_duty_rate = v;
    }
    if let Some(v) = req.transfer_fee_rate {
        cfg.transfer_fee_rate = v;
    }
    if let Some(v) = req.lot_size {
        cfg.lot_size = v.max(1.0);
    }
    if let Some(v) = req.min_position_value {
        cfg.min_position_value = v.max(0.0);
    }
    if let Some(v) = req.t_plus_1 {
        cfg.t_plus_1 = v;
    }
    cfg.stop_loss_percent = req.stop_loss_percent.filter(|v| *v > 0.0);

    let params = Params::from_json(req.params.as_ref());
    let strategy_id = req.strategy_id.clone();
    let run_id = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        &strategy_id
    );

    let market = data::load_market(&load)
        .map_err(|e| (StatusCode::BAD_REQUEST, format!("data: {e}")))?;

    let pool_labels = pools.iter().map(|p| p.label().to_string()).collect();

    let mut output = tokio::task::spawn_blocking(move || {
        barter_engine::run(barter_engine::RunRequest {
            market: &market,
            strategy_id: &strategy_id,
            params,
            config: cfg,
            pools: pool_labels,
            run_id,
        })
    })
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;

    output.refresh = refresh;
    state
        .runs
        .lock()
        .unwrap()
        .insert(output.run_id.clone(), Arc::new(output.clone()));

    Ok(Json(output))
}

async fn get_sim(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SimOutput>, (StatusCode, String)> {
    let runs = state.runs.lock().unwrap();
    runs.get(&id)
        .map(|run| Json((**run).clone()))
        .ok_or((StatusCode::NOT_FOUND, "run not found".into()))
}

async fn get_timeline(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let runs = state.runs.lock().unwrap();
    let run = runs
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "run not found".to_string()))?;
    Ok(Json(json!({
        "runId": run.run_id,
        "initialCash": run.metrics.initial_cash,
        "start": run.start,
        "end": run.end,
        "rows": run.days,
    })))
}

async fn step(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<StepRequest>,
) -> Result<Json<StepResponse>, (StatusCode, String)> {
    let runs = state.runs.lock().unwrap();
    let run = runs
        .get(&id)
        .ok_or((StatusCode::NOT_FOUND, "run not found".to_string()))?;
    let total = run.days.len();
    if total == 0 {
        return Err((StatusCode::BAD_REQUEST, "empty run".into()));
    }
    let current = run
        .days
        .iter()
        .position(|d| d.index == req.index.unwrap_or(0))
        .unwrap_or(0);
    let next = match req.action.as_str() {
        "next" => (current + 1).min(total - 1),
        "prev" => current.saturating_sub(1),
        _ => req.index.unwrap_or(current).min(total - 1),
    };
    Ok(Json(StepResponse {
        index: next,
        total,
        day: run.days[next].clone(),
    }))
}
