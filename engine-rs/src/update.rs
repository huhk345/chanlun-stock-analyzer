//! Pool data maintenance.
//!
//! The Rust engine never invents data: it reads the same `.cache/klines/*_1d_forward.json`
//! the web app already uses. This module keeps that cache current against the
//! free Tencent quote endpoint, in two modes:
//!
//! * **incremental** — fetch a short recent window, and if every overlapping bar
//!   still matches the cached close (within `adjust_tolerance`), append only the
//!   bars after the last cached date.
//! * **full refresh** — triggered automatically when an overlapping bar no longer
//!   matches: a dividend / split / rights issue re-bases the forward-adjusted
//!   (前复权) series, so *every* historical price shifts. The whole series is
//!   re-fetched instead of mixing two adjustment bases.
//!
//! That second rule is the important one: appending across an ex-rights date would
//! silently splice two incompatible price scales, which corrupts every backtest
//! that touches the symbol.

use crate::data::PoolKind;
use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;

const TX_KLINE: &str = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const INDEX_FILE: &str = "_index.json";
/// The project's fixed analysis window (2023-01-01 -> latest), so a full
/// refresh restores exactly the range every other engine analyses.
const HISTORY_START: &str = "2023-01-01";
/// Anything starting later than this is treated as an incomplete history.
const HISTORY_START_SOFT: &str = "2023-06-01";
const INCREMENTAL_FETCH_BARS: usize = 40;

// ---------------------------------------------------------------------------
// Cache file shape (must stay byte-compatible with what the web app reads)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheBar {
    pub date: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    #[serde(default)]
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KlineCache {
    pub symbol: String,
    pub period: String,
    pub adjust: String,
    pub updated_at: f64,
    pub klines: Vec<CacheBar>,
    #[serde(default)]
    pub history_complete: bool,
}

// ---------------------------------------------------------------------------
// Index: cheap per-symbol coverage so the UI can show the usable range
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct IndexEntry {
    pub first: String,
    pub last: String,
    pub bars: usize,
    /// Set once a full refresh returns the same first bar — the symbol simply
    /// listed later, so a short history is not a defect worth re-fetching.
    #[serde(default)]
    pub at_ipo: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoverageIndex {
    pub updated_at: f64,
    /// When the automatic pre-run refresh last ran, so a quiet market (weekend,
    /// holiday) does not trigger a full pool sweep on every simulation.
    #[serde(default)]
    pub last_check: f64,
    pub symbols: BTreeMap<String, IndexEntry>,
}

fn kline_dir(root: &Path) -> PathBuf {
    root.join(".cache").join("klines")
}

fn cache_path(root: &Path, symbol: &str) -> PathBuf {
    kline_dir(root).join(format!("{symbol}_1d_forward.json"))
}

fn read_cache(root: &Path, symbol: &str) -> Option<KlineCache> {
    let text = fs::read_to_string(cache_path(root, symbol)).ok()?;
    let mut cache: KlineCache = serde_json::from_str(&text).ok()?;
    cache.klines.sort_by(|a, b| a.date.cmp(&b.date));
    Some(cache)
}

fn write_cache(root: &Path, cache: &KlineCache) -> std::io::Result<()> {
    let path = cache_path(root, &cache.symbol);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(cache)?)?;
    fs::rename(&tmp, &path)
}

pub fn load_index(root: &Path) -> CoverageIndex {
    let path = kline_dir(root).join(INDEX_FILE);
    fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<CoverageIndex>(&t).ok())
        .unwrap_or_default()
}

fn save_index(root: &Path, index: &CoverageIndex) {
    let path = kline_dir(root).join(INDEX_FILE);
    if let Ok(bytes) = serde_json::to_vec(index) {
        let tmp = path.with_extension("json.tmp");
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

/// Build the index from scratch by scanning the cache directory (one pass).
pub fn rebuild_index(root: &Path) -> CoverageIndex {
    let dir = kline_dir(root);
    let previous = load_index(root);
    let mut index = CoverageIndex {
        updated_at: now_ms(),
        last_check: previous.last_check,
        symbols: BTreeMap::new(),
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return index;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(symbol) = name.strip_suffix("_1d_forward.json") else {
            continue;
        };
        let Ok(text) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(cache) = serde_json::from_str::<KlineCache>(&text) else {
            continue;
        };
        let (Some(first), Some(last)) = (cache.klines.first(), cache.klines.last()) else {
            continue;
        };
        index.symbols.insert(
            symbol.to_string(),
            IndexEntry {
                first: first.date.clone(),
                last: last.date.clone(),
                bars: cache.klines.len(),
                at_ipo: previous
                    .symbols
                    .get(symbol)
                    .map(|e| e.at_ipo)
                    .unwrap_or(false),
            },
        );
    }
    save_index(root, &index);
    index
}

/// Index, rebuilding it once if it is missing or older than a day.
pub fn index_or_rebuild(root: &Path) -> CoverageIndex {
    let index = load_index(root);
    if index.symbols.is_empty() || now_ms() - index.updated_at > 24.0 * 3600.0 * 1000.0 {
        rebuild_index(root)
    } else {
        index
    }
}

fn now_ms() -> f64 {
    Utc::now().timestamp_millis() as f64
}

// ---------------------------------------------------------------------------
// Tencent quote fetch
// ---------------------------------------------------------------------------

/// `600519.SH` -> `sh600519`
fn tx_code(symbol: &str) -> Option<String> {
    let (code, suffix) = symbol.split_once('.')?;
    let market = match suffix.to_ascii_uppercase().as_str() {
        "SH" => "sh",
        "SZ" => "sz",
        "BJ" => "bj",
        _ => return None,
    };
    Some(format!("{market}{code}"))
}

/// Tencent caps a response at 640 bars but honours the `end` date, so a full
/// refresh pages backwards from today instead of asking for "everything".
const PAGE_BARS: usize = 640;

/// Spaces request starts evenly across the whole job. The endpoint sits behind a
/// WAF that starts answering HTTP 501 (an HTML block page) once a burst is too
/// fast — the previous backend capped at 15 rps and we stay below that.
#[derive(Debug)]
struct Pacer {
    next: std::sync::Mutex<std::time::Instant>,
    interval: Duration,
}

impl Pacer {
    fn new(rps: f64) -> Self {
        let rps = if rps.is_finite() && rps > 0.0 { rps } else { 10.0 };
        Self {
            next: std::sync::Mutex::new(std::time::Instant::now()),
            interval: Duration::from_secs_f64(1.0 / rps),
        }
    }

    async fn wait(&self) {
        let slot = {
            let mut next = self.next.lock().unwrap();
            let now = std::time::Instant::now();
            let slot = (*next).max(now);
            *next = slot + self.interval;
            slot
        };
        let now = std::time::Instant::now();
        if slot > now {
            tokio::time::sleep(slot - now).await;
        }
    }
}

async fn fetch_page(
    client: &reqwest::Client,
    pacer: &Pacer,
    symbol: &str,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    count: usize,
) -> Result<Vec<CacheBar>, String> {
    let code = tx_code(symbol).ok_or_else(|| format!("无法识别的代码: {symbol}"))?;
    let start_s = start.map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default();
    let end_s = end.map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default();
    let url = format!("{TX_KLINE}?param={code},day,{start_s},{end_s},{count},qfq");

    pacer.wait().await;
    let resp = client
        .get(&url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取响应失败: {e}"))?;

    // The WAF answers 501 with an HTML block page instead of JSON.
    if !status.is_success() || text.trim_start().starts_with('<') {
        let snippet: String = text.chars().take(60).collect();
        return Err(format!("HTTP {status}: {}", snippet.replace('\n', " ")));
    }

    let body: Value = serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {e}"))?;

    let node = body
        .get("data")
        .and_then(|d| d.get(&code))
        .ok_or_else(|| "行情返回为空".to_string())?;

    // `qfqday` for stocks; indices fall back to the raw `day` series.
    let rows = node
        .get("qfqday")
        .or_else(|| node.get("day"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| "无 K 线数据".to_string())?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(cells) = row.as_array() else { continue };
        if cells.len() < 6 {
            continue;
        }
        let s = |i: usize| cells[i].as_str().unwrap_or_default().to_string();
        let f = |i: usize| cells[i].as_str().unwrap_or_default().parse::<f64>().unwrap_or(0.0);
        // Tencent row order: date, open, close, high, low, volume(手)
        let close = f(2);
        let volume = f(5);
        out.push(CacheBar {
            date: s(0),
            open: f(1),
            high: f(3),
            low: f(4),
            close,
            volume,
            // The endpoint omits turnover; approximate from volume (手 -> 股)
            // so the field stays populated for callers that read it.
            amount: (volume * 100.0 * close).round(),
        });
    }
    out.sort_by(|a, b| a.date.cmp(&b.date));
    Ok(out)
}

/// One retry on transient network failures — a pool refresh hits hundreds of
/// requests and a single reset should not drop a symbol.
async fn fetch_page_retry(
    client: &reqwest::Client,
    pacer: &Pacer,
    symbol: &str,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    count: usize,
) -> Result<Vec<CacheBar>, String> {
    let mut last_error = String::new();
    for attempt in 0..3 {
        match fetch_page(client, pacer, symbol, start, end, count).await {
            Ok(bars) => return Ok(bars),
            Err(e) => {
                let blocked = e.contains("501") || e.contains("403") || e.contains("429");
                last_error = e;
                if blocked {
                    // A WAF block will not clear in a second — retrying only eats
                    // the caller's time budget, so fail fast and let the breaker trip.
                    break;
                }
                tokio::time::sleep(Duration::from_millis(250 * (attempt + 1) as u64)).await;
            }
        }
    }
    Err(last_error)
}

/// The last `count` bars, used for the incremental overlap check.
async fn fetch_recent(
    client: &reqwest::Client,
    pacer: &Pacer,
    symbol: &str,
    count: usize,
) -> Result<Vec<CacheBar>, String> {
    fetch_page_retry(client, pacer, symbol, None, None, count).await
}

/// Full series from `start` to today, paged backwards 640 bars at a time.
async fn fetch_history(
    client: &reqwest::Client,
    pacer: &Pacer,
    symbol: &str,
    start: NaiveDate,
) -> Result<Vec<CacheBar>, String> {
    let mut all: Vec<CacheBar> = Vec::new();
    let mut end = Utc::now().date_naive();
    let mut guard = 0;

    loop {
        guard += 1;
        if guard > 12 {
            break;
        }
        let page = fetch_page_retry(client, pacer, symbol, Some(start), Some(end), PAGE_BARS).await?;
        if page.is_empty() {
            break;
        }
        let first = page
            .first()
            .and_then(|b| NaiveDate::parse_from_str(&b.date, "%Y-%m-%d").ok());
        all.extend(page);

        let Some(first) = first else { break };
        if first <= start {
            break;
        }
        let next_end = first - chrono::Days::new(1);
        if next_end >= end {
            break;
        }
        end = next_end;
    }

    all.sort_by(|a, b| a.date.cmp(&b.date));
    all.dedup_by(|a, b| a.date == b.date);
    if all.is_empty() {
        return Err("无 K 线数据".into());
    }
    Ok(all)
}

// ---------------------------------------------------------------------------
// Update job
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SymbolOutcome {
    /// New bars appended to an unchanged adjustment basis.
    Appended,
    /// Whole series re-fetched because an ex-rights event re-based the prices.
    Rebased,
    /// Already current.
    Unchanged,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SymbolResult {
    pub symbol: String,
    pub outcome: SymbolOutcome,
    pub added: usize,
    pub bars: usize,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    pub id: String,
    pub state: UpdateState,
    pub total: usize,
    pub done: usize,
    pub appended: usize,
    pub rebased: usize,
    pub unchanged: usize,
    pub failed: usize,
    pub current: Option<String>,
    pub started_at: f64,
    pub finished_at: Option<f64>,
    pub elapsed_ms: u64,
    /// Symbols whose adjustment basis changed (the "除权" list), most recent first.
    pub rebased_symbols: Vec<String>,
    pub errors: Vec<String>,
    pub results: Vec<SymbolResult>,
}

impl UpdateProgress {
    pub fn new(id: String, total: usize) -> Self {
        Self {
            id,
            state: UpdateState::Running,
            total,
            done: 0,
            appended: 0,
            rebased: 0,
            unchanged: 0,
            failed: 0,
            current: None,
            started_at: now_ms(),
            finished_at: None,
            elapsed_ms: 0,
            rebased_symbols: Vec::new(),
            errors: Vec::new(),
            results: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateMode {
    Incremental,
    Full,
}

impl UpdateMode {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "full" => UpdateMode::Full,
            _ => UpdateMode::Incremental,
        }
    }
}

#[derive(Debug, Clone)]
pub struct UpdateConfig {
    pub mode: UpdateMode,
    /// Relative close deviation that counts as an ex-rights re-basing.
    pub adjust_tolerance: f64,
    pub concurrency: usize,
    /// Global request rate (requests/second). The endpoint's WAF blocks bursts.
    pub rps: f64,
    /// Wall-clock budget for an automatic pre-run refresh.
    pub budget: std::time::Duration,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            mode: UpdateMode::Incremental,
            adjust_tolerance: 0.0005,
            concurrency: 4,
            rps: 10.0,
            budget: std::time::Duration::from_secs(25),
        }
    }
}

/// Resolve the symbol list for the requested pools (+ extras).
pub fn pool_symbols(root: &Path, pools: &[PoolKind], extra: &[String]) -> Vec<String> {
    let mut symbols: Vec<String> = Vec::new();
    for pool in pools {
        let path = root.join("public").join(pool.members_file());
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(members) = serde_json::from_str::<Vec<String>>(&text) else {
            continue;
        };
        for m in members {
            let s = m.trim().to_ascii_uppercase();
            if !s.is_empty() && !symbols.contains(&s) {
                symbols.push(s);
            }
        }
    }
    for raw in extra {
        let s = raw.trim().to_ascii_uppercase();
        if !s.is_empty() && !symbols.contains(&s) {
            symbols.push(s);
        }
    }
    symbols
}

/// Refresh one symbol. Returns the outcome plus the fresh index entry.
async fn update_symbol(
    client: &reqwest::Client,
    pacer: &Pacer,
    root: &Path,
    symbol: &str,
    cfg: &UpdateConfig,
    force_full: bool,
) -> (SymbolResult, Option<IndexEntry>) {
    let cached = read_cache(root, symbol);

    let fail = |msg: String| {
        (
            SymbolResult {
                symbol: symbol.to_string(),
                outcome: SymbolOutcome::Failed,
                added: 0,
                bars: 0,
                note: Some(msg),
            },
            None,
        )
    };

    // No cache, or a forced full refresh: pull the whole series.
    if cached.is_none() || force_full {
        let start = parse_bound(Some(HISTORY_START))
            .unwrap_or_else(|| NaiveDate::from_ymd_opt(2023, 1, 1).expect("valid date"));
        let bars = match fetch_history(client, pacer, symbol, start).await {
            Ok(b) => b,
            Err(e) => return fail(e),
        };
        // Never replace a longer cached history with a shorter fetch.
        if let Some(old) = &cached {
            let new_first = bars.first().map(|b| b.date.clone()).unwrap_or_default();
            let old_first = old.klines.first().map(|b| b.date.clone()).unwrap_or_default();
            if bars.len() < old.klines.len()
                && new_first > old_first
                && new_first.as_str() > HISTORY_START_SOFT
            {
                return fail(format!(
                    "刷新结果比缓存短 ({} -> {} 根, 起点 {} -> {}), 已保留原缓存",
                    old.klines.len(),
                    bars.len(),
                    old_first,
                    new_first
                ));
            }
        }
        let cache = KlineCache {
            symbol: symbol.to_string(),
            period: "1d".into(),
            adjust: "forward".into(),
            updated_at: now_ms(),
            klines: bars,
            history_complete: true,
        };
        if let Err(e) = write_cache(root, &cache) {
            return fail(format!("写入失败: {e}"));
        }
        let entry = index_entry(&cache);
        let note = if force_full {
            Some("全量刷新".to_string())
        } else {
            Some("首次缓存".to_string())
        };
        return (
            SymbolResult {
                symbol: symbol.to_string(),
                outcome: SymbolOutcome::Rebased,
                added: cache.klines.len(),
                bars: cache.klines.len(),
                note,
            },
            Some(entry),
        );
    }

    let mut cache = cached.expect("checked above");
    let last_date = cache.klines.last().map(|b| b.date.clone()).unwrap_or_default();

    let fresh = match fetch_recent(client, pacer, symbol, INCREMENTAL_FETCH_BARS).await {
        Ok(b) => b,
        Err(e) => return fail(e),
    };

    // Ex-rights detection: compare every overlapping bar against the cache.
    let known: std::collections::HashMap<&str, f64> = cache
        .klines
        .iter()
        .map(|b| (b.date.as_str(), b.close))
        .collect();

    let mut worst = 0.0f64;
    let mut mismatched = 0usize;
    for bar in &fresh {
        if let Some(&old) = known.get(bar.date.as_str()) {
            if old > 0.0 && bar.close > 0.0 {
                let dev = (bar.close / old - 1.0).abs();
                if dev > worst {
                    worst = dev;
                }
                if dev > cfg.adjust_tolerance {
                    mismatched += 1;
                }
            }
        }
    }

    if mismatched > 0 {
        // A dividend/split re-based the whole 前复权 series: never splice.
        let start = parse_bound(Some(HISTORY_START))
            .unwrap_or_else(|| NaiveDate::from_ymd_opt(2023, 1, 1).expect("valid date"));
        let bars = match fetch_history(client, pacer, symbol, start).await {
            Ok(b) => b,
            Err(e) => return fail(e),
        };
        let new_first = bars.first().map(|b| b.date.clone()).unwrap_or_default();
        let old_first = cache.klines.first().map(|b| b.date.clone()).unwrap_or_default();
        if bars.len() < cache.klines.len()
            && new_first > old_first
            && new_first.as_str() > HISTORY_START_SOFT
        {
            return fail(format!(
                "除权后刷新结果比缓存短 ({} -> {} 根), 已保留原缓存",
                cache.klines.len(),
                bars.len()
            ));
        }
        let cache = KlineCache {
            symbol: symbol.to_string(),
            period: "1d".into(),
            adjust: "forward".into(),
            updated_at: now_ms(),
            klines: bars,
            history_complete: true,
        };
        if let Err(e) = write_cache(root, &cache) {
            return fail(format!("写入失败: {e}"));
        }
        let entry = index_entry(&cache);
        return (
            SymbolResult {
                symbol: symbol.to_string(),
                outcome: SymbolOutcome::Rebased,
                added: cache.klines.len(),
                bars: cache.klines.len(),
                note: Some(format!(
                    "除权/复权基准变化 ({} 根重叠偏差 {:.2}%) → 全量刷新 {} 根",
                    mismatched,
                    worst * 100.0,
                    cache.klines.len()
                )),
            },
            Some(entry),
        );
    }

    let new_bars: Vec<CacheBar> = fresh
        .into_iter()
        .filter(|b| b.date.as_str() > last_date.as_str())
        .collect();

    if new_bars.is_empty() {
        return (
            SymbolResult {
                symbol: symbol.to_string(),
                outcome: SymbolOutcome::Unchanged,
                added: 0,
                bars: cache.klines.len(),
                note: None,
            },
            Some(index_entry(&cache)),
        );
    }

    let added = new_bars.len();
    cache.klines.extend(new_bars);
    cache.klines.sort_by(|a, b| a.date.cmp(&b.date));
    cache.updated_at = now_ms();
    cache.history_complete = true;

    if let Err(e) = write_cache(root, &cache) {
        return fail(format!("写入失败: {e}"));
    }
    let entry = index_entry(&cache);
    (
        SymbolResult {
            symbol: symbol.to_string(),
            outcome: SymbolOutcome::Appended,
            added,
            bars: cache.klines.len(),
            note: None,
        },
        Some(entry),
    )
}

fn index_entry(cache: &KlineCache) -> IndexEntry {
    IndexEntry {
        first: cache.klines.first().map(|b| b.date.clone()).unwrap_or_default(),
        last: cache.klines.last().map(|b| b.date.clone()).unwrap_or_default(),
        bars: cache.klines.len(),
        at_ipo: false,
    }
}

/// Run the whole job, publishing progress through `progress`.
pub async fn run_update(
    root: PathBuf,
    symbols: Vec<String>,
    cfg: UpdateConfig,
    progress: Arc<std::sync::Mutex<UpdateProgress>>,
) {
    let started = std::time::Instant::now();
    let client = match reqwest::Client::builder()
        .user_agent("chanlun-engine-rs/0.1")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            let mut p = progress.lock().unwrap();
            p.state = UpdateState::Failed;
            p.errors.push(format!("HTTP client: {e}"));
            p.finished_at = Some(now_ms());
            return;
        }
    };

    let semaphore = Arc::new(Semaphore::new(cfg.concurrency.max(1)));
    let mut handles = Vec::with_capacity(symbols.len());
    let pacer = Arc::new(Pacer::new(cfg.rps));
    let cfg = Arc::new(cfg);
    // Circuit breaker: the quote endpoint answers HTTP 501 from its WAF when a
    // burst is too fast. Grinding through 800 doomed requests helps nobody, so
    // a handful of consecutive blocks aborts the job with a clear message.
    let blocked = Arc::new(AtomicUsize::new(0));
    let abort = Arc::new(AtomicBool::new(false));

    for symbol in symbols {
        if abort.load(Ordering::Relaxed) {
            break;
        }
        if blocked.load(Ordering::Relaxed) >= 10 {
            abort.store(true, Ordering::Relaxed);
            break;
        }
        let permit = Arc::clone(&semaphore).acquire_owned().await;
        let Ok(_permit) = permit else { break };
        let client = client.clone();
        let root = root.clone();
        let cfg = Arc::clone(&cfg);
        let progress = Arc::clone(&progress);
        let pacer = Arc::clone(&pacer);
        let blocked = Arc::clone(&blocked);
        let abort = Arc::clone(&abort);

        handles.push(tokio::spawn(async move {
            // Hold the permit for the whole task — dropping it at the end of the
            // spawn loop would let every symbol fire at once.
            let _permit = _permit;
            {
                let mut p = progress.lock().unwrap();
                p.current = Some(symbol.clone());
            }
            if abort.load(Ordering::Relaxed) {
                let mut p = progress.lock().unwrap();
                p.done += 1;
                p.failed += 1;
                return (symbol, SymbolResult {
                    symbol: String::new(),
                    outcome: SymbolOutcome::Failed,
                    added: 0,
                    bars: 0,
                    note: None,
                }, None);
            }
            let (result, entry) = update_symbol(&client, &pacer, &root, &symbol, &cfg, cfg.mode == UpdateMode::Full).await;
            if result.outcome == SymbolOutcome::Failed {
                blocked.fetch_add(1, Ordering::Relaxed);
            }
            {
                let mut p = progress.lock().unwrap();
                p.done += 1;
                match result.outcome {
                    SymbolOutcome::Appended => p.appended += 1,
                    SymbolOutcome::Rebased => {
                        p.rebased += 1;
                        if p.rebased_symbols.len() < 60 {
                            p.rebased_symbols.push(symbol.clone());
                        }
                    }
                    SymbolOutcome::Unchanged => p.unchanged += 1,
                    SymbolOutcome::Failed => {
                        p.failed += 1;
                        if p.errors.len() < 30 {
                            p.errors.push(format!(
                                "{symbol}: {}",
                                result.note.clone().unwrap_or_default()
                            ));
                        }
                    }
                }
                p.elapsed_ms = started.elapsed().as_millis() as u64;
                if p.results.len() < 400 {
                    p.results.push(result.clone());
                }
            }
            (symbol, result, entry)
        }));
    }

    let mut touched: Vec<(String, IndexEntry)> = Vec::new();
    for handle in handles {
        if let Ok((symbol, _, Some(entry))) = handle.await {
            touched.push((symbol, entry));
        }
    }

    // Patch the coverage index with everything that changed.
    if !touched.is_empty() {
        let mut index = load_index(&root);
        if index.symbols.is_empty() {
            index = rebuild_index(&root);
        }
        for (symbol, entry) in touched {
            index.symbols.insert(symbol, entry);
        }
        index.updated_at = now_ms();
        save_index(&root, &index);
    }

    let mut p = progress.lock().unwrap();
    p.current = None;
    p.finished_at = Some(now_ms());
    p.elapsed_ms = started.elapsed().as_millis() as u64;
    if abort.load(Ordering::Relaxed) {
        p.state = UpdateState::Failed;
        p.errors.insert(
            0,
            format!(
                "连续 {} 个标的拉取失败 (行情接口风控或网络不可达), 已中止本次更新 — 请稍后重试",
                blocked.load(Ordering::Relaxed)
            ),
        );
    } else {
        p.state = UpdateState::Done;
    }
}

// ---------------------------------------------------------------------------
// Coverage view for the UI
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PoolCoverage {
    pub id: String,
    pub label: String,
    pub size: usize,
    pub cached: usize,
    pub missing: usize,
    /// Members whose cached history starts suspiciously late (after the project's
    /// analysis window) — either a recent listing or a truncated refresh.
    pub incomplete: usize,
    pub first: Option<String>,
    pub last: Option<String>,
}

pub fn coverage(root: &Path, pools: &[PoolKind]) -> (Vec<PoolCoverage>, f64) {
    let index = index_or_rebuild(root);
    let mut out = Vec::new();
    for pool in pools {
        let symbols = pool_symbols(root, &[*pool], &[]);
        let mut cached = 0usize;
        let mut incomplete = 0usize;
        let mut first: Option<String> = None;
        let mut last: Option<String> = None;
        for symbol in &symbols {
            if let Some(entry) = index.symbols.get(symbol) {
                cached += 1;
                if entry.first.as_str() > HISTORY_START_SOFT {
                    incomplete += 1;
                }
                if first.as_deref().map_or(true, |f| entry.first.as_str() < f) {
                    first = Some(entry.first.clone());
                }
                if last.as_deref().map_or(true, |l| entry.last.as_str() > l) {
                    last = Some(entry.last.clone());
                }
            }
        }
        out.push(PoolCoverage {
            id: match pool {
                PoolKind::Hs300 => "hs300",
                PoolKind::Zz500 => "zz500",
            }
            .into(),
            label: pool.label().to_string(),
            size: symbols.len(),
            cached,
            missing: symbols.len().saturating_sub(cached),
            incomplete,
            first,
            last,
        });
    }
    (out, index.updated_at)
}

/// Parse a `YYYY-MM-DD` bound, ignoring blanks.
pub fn parse_bound(raw: Option<&str>) -> Option<NaiveDate> {
    raw.and_then(|s| NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok())
}

// ---------------------------------------------------------------------------
// Automatic pre-run refresh
// ---------------------------------------------------------------------------

/// What the automatic refresh did before a simulation, surfaced in the response
/// so the run is never silently based on stale bars.
#[derive(Debug, Clone, Serialize, Default)]
pub struct AutoRefreshReport {
    pub checked: usize,
    /// Symbols actually fetched (stale tail or rebuilt history).
    pub refreshed: usize,
    pub appended: usize,
    pub rebased: usize,
    pub failed: usize,
    /// True when the cache was already current and nothing was fetched.
    pub skipped: bool,
    /// True when the time budget ran out before every stale symbol was fetched.
    pub partial: bool,
    pub reason: Option<String>,
    pub rebased_symbols: Vec<String>,
    pub errors: Vec<String>,
    pub elapsed_ms: u64,
}

/// Latest weekday bar we could reasonably expect, in Asia/Shanghai terms
/// (a bar exists once the 15:00 close has passed).
fn expected_latest_trading_day() -> String {
    use chrono::{Datelike, Duration, NaiveTime, Weekday};
    let cst = Utc::now() + Duration::hours(8);
    let mut day = cst.date_naive();
    if cst.time() < NaiveTime::from_hms_opt(15, 0, 0).expect("valid time") {
        day = day.pred_opt().unwrap_or(day);
    }
    while matches!(day.weekday(), Weekday::Sat | Weekday::Sun) {
        day = day.pred_opt().unwrap_or(day);
    }
    day.format("%Y-%m-%d").to_string()
}

/// Refresh just what is stale, right before a simulation.
///
/// Two kinds of work, both scoped to the symbols the run will actually use:
/// * **tail** — the cached last bar is behind the latest trading day;
/// * **repair** — the history starts after the analysis window and is not a
///   known late listing (a truncated cache, healed by a full rebuild once).
pub async fn auto_refresh(root: PathBuf, symbols: Vec<String>, cfg: UpdateConfig) -> AutoRefreshReport {
    let started = std::time::Instant::now();
    let mut report = AutoRefreshReport {
        checked: symbols.len(),
        ..Default::default()
    };
    if symbols.is_empty() {
        report.skipped = true;
        return report;
    }

    let mut index = index_or_rebuild(&root);
    let expected = expected_latest_trading_day();

    // A quiet market must not sweep the whole pool on every run: if we checked
    // within the last six hours and the data still covers the last few days,
    // there is nothing to do.
    let recently_checked = now_ms() - index.last_check < 6.0 * 3600.0 * 1000.0;
    let covers_recent = index
        .symbols
        .values()
        .map(|e| e.last.as_str())
        .max()
        .map(|last| last >= expected.as_str() || last >= shift_iso(&expected, -4).as_str())
        .unwrap_or(false);
    if recently_checked && covers_recent {
        report.skipped = true;
        report.reason = Some("数据已在近期检查过, 无需更新".into());
        report.elapsed_ms = started.elapsed().as_millis() as u64;
        return report;
    }

    let mut tail: Vec<String> = Vec::new();
    let mut repair: Vec<String> = Vec::new();
    let mut old_first: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    for symbol in &symbols {
        match index.symbols.get(symbol) {
            None => repair.push(symbol.clone()),
            Some(entry) => {
                old_first.insert(symbol.clone(), entry.first.clone());
                if entry.last.as_str() < expected.as_str() {
                    tail.push(symbol.clone());
                } else if entry.first.as_str() > HISTORY_START_SOFT && !entry.at_ipo {
                    repair.push(symbol.clone());
                }
            }
        }
    }

    if tail.is_empty() && repair.is_empty() {
        report.skipped = true;
        report.reason = Some(format!("已是最新 ({expected})"));
        index.last_check = now_ms();
        save_index(&root, &index);
        report.elapsed_ms = started.elapsed().as_millis() as u64;
        return report;
    }

    let client = match reqwest::Client::builder()
        .user_agent("chanlun-engine-rs/0.1")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            report.skipped = true;
            report.reason = Some(format!("HTTP client: {e}"));
            return report;
        }
    };

    let pacer = Arc::new(Pacer::new(cfg.rps));
    let semaphore = Arc::new(Semaphore::new(cfg.concurrency.max(1)));
    let blocked = Arc::new(AtomicUsize::new(0));
    let mut touched: Vec<(String, IndexEntry, bool)> = Vec::new();

    let tasks: Vec<(String, bool)> = tail
        .into_iter()
        .map(|s| (s, false))
        .chain(repair.into_iter().map(|s| (s, true)))
        .collect();
    let planned = tasks.len();

    // A simulation must not turn into a multi-minute download: refresh what fits
    // in the budget and let the run proceed on whatever is already cached.
    let deadline = started + cfg.budget;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

    let mut spawned = 0usize;
    for (symbol, force_full) in tasks {
        if std::time::Instant::now() >= deadline {
            report.partial = true;
            break;
        }
        if blocked.load(Ordering::Relaxed) >= 10 {
            report.partial = true;
            report.reason = Some("行情接口连续失败, 本次先用缓存数据".into());
            break;
        }
        let Ok(permit) = Arc::clone(&semaphore).acquire_owned().await else {
            break;
        };
        let client = client.clone();
        let root = root.clone();
        let cfg_inner = cfg.clone();
        let pacer = Arc::clone(&pacer);
        let blocked = Arc::clone(&blocked);
        let tx = tx.clone();
        spawned += 1;
        tokio::spawn(async move {
            let _permit = permit;
            let (result, entry) =
                update_symbol(&client, &pacer, &root, &symbol, &cfg_inner, force_full).await;
            if result.outcome == SymbolOutcome::Failed {
                blocked.fetch_add(1, Ordering::Relaxed);
            }
            let _ = tx.send((symbol, result, entry));
        });
    }
    drop(tx);

    if spawned < planned {
        report.partial = true;
    }

    // Give in-flight requests a short grace period past the spawn deadline.
    let collect_until = deadline + std::time::Duration::from_secs(3);
    loop {
        if blocked.load(Ordering::Relaxed) >= 10 {
            report.partial = true;
            report.reason = Some("行情接口连续失败, 本次先用缓存数据".into());
            break;
        }
        let msg = tokio::time::timeout_at(collect_until.into(), rx.recv()).await;
        let Ok(Some((symbol, result, entry))) = msg else {
            break;
        };
        report.refreshed += 1;
        match result.outcome {
            SymbolOutcome::Appended => report.appended += 1,
            SymbolOutcome::Rebased => {
                report.rebased += 1;
                if report.rebased_symbols.len() < 12 {
                    report.rebased_symbols.push(symbol.clone());
                }
            }
            SymbolOutcome::Unchanged => {}
            SymbolOutcome::Failed => {
                report.failed += 1;
                if report.errors.len() < 5 {
                    report
                        .errors
                        .push(format!("{symbol}: {}", result.note.unwrap_or_default()));
                }
            }
        }
        if let Some(entry) = entry {
            // A full rebuild that lands on the same first bar means the symbol
            // simply listed later — remember that so we stop re-fetching it.
            let ipo = old_first
                .get(&symbol)
                .map(|before| before == &entry.first)
                .unwrap_or(false);
            touched.push((symbol, entry, ipo));
        }
    }

    for (symbol, mut entry, ipo) in touched {
        if ipo {
            entry.at_ipo = true;
        } else if let Some(prev) = index.symbols.get(&symbol) {
            entry.at_ipo = prev.at_ipo;
        }
        index.symbols.insert(symbol, entry);
    }
    index.updated_at = now_ms();
    // Only claim a successful check when the sweep actually completed, so an
    // aborted refresh retries on the next run instead of waiting six hours.
    if !report.partial && report.failed == 0 {
        index.last_check = now_ms();
    }
    save_index(&root, &index);

    report.elapsed_ms = started.elapsed().as_millis() as u64;
    if report.refreshed == 0 {
        report.skipped = true;
        if report.reason.is_none() {
            report.reason = Some("未取到新数据, 沿用缓存".into());
        }
    }
    report
}

fn shift_iso(iso: &str, days: i64) -> String {
    match NaiveDate::parse_from_str(iso, "%Y-%m-%d") {
        Ok(d) => (d + chrono::Days::new(days.unsigned_abs()))
            .format("%Y-%m-%d")
            .to_string(),
        Err(_) => iso.to_string(),
    }
}
