//! Stock-pool data layer.
//!
//! The Rust engine never talks to a quote API: it reads exactly what the web app
//! already caches on disk —
//!
//!   * `public/index-members.hs300.json` / `index-members.zz500.json` — pool members
//!   * `.cache/klines/<symbol>_1d_forward.json`                    — daily bars
//!
//! Both are produced by the existing Node backend, so the Rust backtest and the
//! TypeScript backtest look at the same bars, the same adjustment and the same
//! date window. A pool is loaded once into a `Market` and handed to the engine as
//! one chronologically ordered stream of day events.

use chrono::NaiveDate;
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy)]
pub struct Bar {
    pub date: NaiveDate,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub amount: f64,
}

#[derive(Debug, Clone)]
pub struct SymbolSeries {
    pub symbol: String,
    pub bars: Vec<Bar>,
    /// date -> index in `bars`, for O(1) lookup while walking the calendar
    by_date: HashMap<NaiveDate, usize>,
}

impl SymbolSeries {
    pub fn bar_on(&self, date: NaiveDate) -> Option<&Bar> {
        self.by_date.get(&date).map(|&i| &self.bars[i])
    }

}

#[derive(Debug, Default)]
pub struct Market {
    /// Trading calendar = union of every member's dates, ascending.
    pub dates: Vec<NaiveDate>,
    pub series: BTreeMap<String, SymbolSeries>,
    /// symbol -> first bar index per calendar day (populated by `align`)
    pub missing: Vec<String>,
}

// ---------------------------------------------------------------------------
// Raw cache shapes (must stay in sync with the Node backend's cache writer)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct KlineCacheFile {
    symbol: String,
    klines: Vec<RawBar>,
}

#[derive(Deserialize)]
struct RawBar {
    date: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    #[serde(default)]
    volume: f64,
    #[serde(default)]
    amount: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolKind {
    Hs300,
    Zz500,
}

impl PoolKind {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "hs300" | "沪深300" => Some(PoolKind::Hs300),
            "zz500" | "中证500" => Some(PoolKind::Zz500),
            _ => None,
        }
    }

    pub fn members_file(self) -> &'static str {
        match self {
            PoolKind::Hs300 => "index-members.hs300.json",
            PoolKind::Zz500 => "index-members.zz500.json",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PoolKind::Hs300 => "沪深300",
            PoolKind::Zz500 => "中证500",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum DataError {
    #[error("io {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("json {path}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("bad date {0}")]
    Date(String),
    #[error("no data: {0}")]
    Empty(String),
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, DataError> {
    let text = fs::read_to_string(path).map_err(|source| DataError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_str(&text).map_err(|source| DataError::Json {
        path: path.to_path_buf(),
        source,
    })
}

/// 单只标的的全部日线（供前端点开个股画 K 线用）。
///
/// 只读缓存文件，不走网络：缓存是 Node 后端写的，和回测用的是同一份数据。
pub fn load_symbol_bars(root: &Path, symbol: &str) -> Result<Vec<Bar>, DataError> {
    let path = root
        .join(".cache")
        .join("klines")
        .join(format!("{symbol}_1d_forward.json"));
    let file: KlineCacheFile = read_json(&path)?;
    let mut bars = Vec::with_capacity(file.klines.len());
    for raw in file.klines {
        let date = NaiveDate::parse_from_str(&raw.date, "%Y-%m-%d")
            .map_err(|_| DataError::Date(raw.date.clone()))?;
        bars.push(Bar {
            date,
            open: raw.open,
            high: raw.high,
            low: raw.low,
            close: raw.close,
            volume: raw.volume,
            amount: raw.amount,
        });
    }
    if bars.is_empty() {
        return Err(DataError::Empty(symbol.to_string()));
    }
    Ok(bars)
}

pub struct LoadRequest {
    pub root: PathBuf,
    pub pools: Vec<PoolKind>,
    pub extra_symbols: Vec<String>,
    pub start: Option<NaiveDate>,
    pub end: Option<NaiveDate>,
    /// Cap the universe (handy for quick runs while developing).
    pub limit: Option<usize>,
}

impl LoadRequest {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            pools: vec![PoolKind::Hs300],
            extra_symbols: Vec::new(),
            start: None,
            end: None,
            limit: None,
        }
    }
}

/// Read the pool members + their cached daily bars into one aligned `Market`.
pub fn load_market(req: &LoadRequest) -> Result<Market, DataError> {
    let public_dir = req.root.join("public");
    let kline_dir = req.root.join(".cache").join("klines");

    let mut symbols: Vec<String> = Vec::new();
    for pool in &req.pools {
        let path = public_dir.join(pool.members_file());
        let members: Vec<String> = read_json(&path)?;
        for m in members {
            let s = m.trim().to_ascii_uppercase();
            if !s.is_empty() && !symbols.contains(&s) {
                symbols.push(s);
            }
        }
    }
    for extra in &req.extra_symbols {
        let s = extra.trim().to_ascii_uppercase();
        if !s.is_empty() && !symbols.contains(&s) {
            symbols.push(s);
        }
    }
    if let Some(limit) = req.limit {
        symbols.truncate(limit);
    }

    let mut series_map: BTreeMap<String, SymbolSeries> = BTreeMap::new();
    let mut missing: Vec<String> = Vec::new();

    for symbol in symbols {
        let path = kline_dir.join(format!("{symbol}_1d_forward.json"));
        if !path.exists() {
            missing.push(symbol);
            continue;
        }
        let file: KlineCacheFile = read_json(&path)?;
        let mut bars: Vec<Bar> = Vec::with_capacity(file.klines.len());
        for raw in file.klines {
            let date = NaiveDate::parse_from_str(&raw.date, "%Y-%m-%d")
                .map_err(|_| DataError::Date(raw.date.clone()))?;
            if req.start.is_some_and(|s| date < s) || req.end.is_some_and(|e| date > e) {
                continue;
            }
            if !(raw.close.is_finite() && raw.close > 0.0) {
                continue;
            }
            bars.push(Bar {
                date,
                open: raw.open,
                high: raw.high,
                low: raw.low,
                close: raw.close,
                volume: raw.volume,
                amount: raw.amount,
            });
        }
        if bars.len() < 2 {
            missing.push(symbol);
            continue;
        }
        let by_date = bars
            .iter()
            .enumerate()
            .map(|(i, b)| (b.date, i))
            .collect::<HashMap<_, _>>();
        series_map.insert(
            symbol.clone(),
            SymbolSeries {
                symbol: file.symbol,
                bars,
                by_date,
            },
        );
    }

    if series_map.is_empty() {
        return Err(DataError::Empty(
            "no cached bars found for the requested pool".into(),
        ));
    }

    // Calendar: union of every member's dates inside the window.
    let mut date_set: Vec<NaiveDate> = series_map
        .values()
        .flat_map(|s| s.bars.iter().map(|b| b.date))
        .collect();
    date_set.sort_unstable();
    date_set.dedup();

    Ok(Market {
        dates: date_set,
        series: series_map,
        missing,
    })
}
