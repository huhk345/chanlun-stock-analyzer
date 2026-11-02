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
    /// `bars[..warmup]` 是模拟区间开始之前的预热历史：策略看得见，日历看不见。
    /// 单独从 `start` 起跑的回测才有意义 —— 否则 MA120/250 日高点/中枢这类
    /// 长周期结构在第一天全部无解，样本外只剩零星的信号。
    pub warmup: usize,
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
    /// 被「可交易范围」剔除的成分股数量 (创业板/科创板/北交所/ST)
    pub filtered_out: usize,
    /// 池子层面的市场状态，逐日与 `dates` 对齐。
    /// 策略只能看到「今天及以前」的行情，这个序列也一样：第 i 个点只由
    /// 截至 dates[i] 的收盘价算出，不含未来信息。
    pub regime: Vec<RegimePoint>,
}

/// 池子级市场状态（等权口径，不依赖外部指数）。
///
/// 单票策略只能看到自己的 K 线，无法判断「整个市场是不是在跌」。用池内
/// 成分股聚合出一个不做任何加权的市场代理：站上自身 MA60 的比例（breadth）
/// 与等权净值的趋势（index_*）。这两个量都是纯价格的、无参数的粗指标，
/// 适合做「什么时候不该逆势开仓」的闸门，而不是精确择时。
#[derive(Debug, Clone, Copy, Default)]
pub struct RegimePoint {
    /// 池内收盘价站上自身 MA60 的标的比例 (0~1)
    pub breadth_ma60: f64,
    /// 等权净值相对自身 MA60 的偏离 (%)
    pub index_ma60_dist: f64,
    /// 等权净值 20 日涨跌幅 (%)
    pub index_slope20: f64,
    /// 样本足够长时为 true；前 80 个交易日不参与判断
    pub valid: bool,
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

// ---------------------------------------------------------------------------
// 「可交易范围」过滤 (与前端 src/utils/tradeFilter.ts 同口径)
// ---------------------------------------------------------------------------

/// 6 位代码 -> 板块 id。与 `aShareBoard()` 保持一致:
/// 创业板 300/301, 科创板 688/689, 北交所 43/83/87/88/92, 其余视为主板。
pub fn board_of(symbol: &str) -> &'static str {
    let code = symbol.split('.').next().unwrap_or("");
    if code.starts_with("300") || code.starts_with("301") {
        "chinext"
    } else if code.starts_with("688") || code.starts_with("689") {
        "star"
    } else if ["43", "83", "87", "88", "92"]
        .iter()
        .any(|p| code.starts_with(p))
    {
        "bse"
    } else {
        "main"
    }
}

/// ST / *ST / SST / 退市整理 —— 只能看名字, 名字缺失时一律放行 (宁可见到, 不误杀)。
/// 这类标的**恒定剔除**, 不提供开关。
pub fn name_is_st(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return false;
    }
    let upper = trimmed.to_ascii_uppercase();
    if upper.starts_with("ST")
        || upper.starts_with("*ST")
        || upper.starts_with("SST")
        || upper.starts_with("S*ST")
    {
        return true;
    }
    trimmed.contains('退')
}

/// 名称字典 (public/merged_stock_data.json, 代码 -> 名称)。只用于 ST 判定,
/// 读不到就当没有名字, 不影响回测。
fn load_names(public_dir: &Path) -> HashMap<String, String> {
    #[derive(Deserialize)]
    struct Meta {
        #[serde(default)]
        stock_name: Option<String>,
    }

    let path = public_dir.join("merged_stock_data.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return HashMap::new();
    };
    let Ok(raw) = serde_json::from_str::<HashMap<String, Meta>>(&text) else {
        return HashMap::new();
    };
    raw.into_iter()
        .filter_map(|(code, m)| m.stock_name.filter(|n| !n.is_empty()).map(|n| (code, n)))
        .collect()
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

/// 模拟起点之前保留多少根日线做预热：MA120/250 日高点/320 根缠论窗口都要够用。
const WARMUP_BARS: usize = 400;

pub struct LoadRequest {
    pub root: PathBuf,
    pub pools: Vec<PoolKind>,
    pub extra_symbols: Vec<String>,
    pub start: Option<NaiveDate>,
    pub end: Option<NaiveDate>,
    /// Cap the universe (handy for quick runs while developing).
    pub limit: Option<usize>,
    /// 从成分股里剔除的板块: "chinext" / "star" / "bse"
    pub exclude_boards: Vec<String>,
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
            exclude_boards: Vec::new(),
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

    // 「可交易范围」: 板块过滤只对指数成分股生效 —— 用户自己加的标的是显式选择,
    // 即使属于被排除的板块也保留 (否则「我明明加进去了」会变成灵异事件)。
    // ST/退市 则是**恒定剔除**, 对 custom 也一视同仁 (按名称字典判定,
    // 字典读不到就不判, 不会误杀)。
    let names = load_names(&public_dir);
    let is_st = |s: &str| {
        let code = s.split('.').next().unwrap_or("");
        names.get(code).is_some_and(|n| name_is_st(n))
    };

    let before = symbols.len();
    symbols.retain(|s| !req.exclude_boards.iter().any(|b| b == board_of(s)) && !is_st(s));
    let mut filtered_out = before - symbols.len();

    for extra in &req.extra_symbols {
        let s = extra.trim().to_ascii_uppercase();
        if s.is_empty() || symbols.contains(&s) {
            continue;
        }
        if is_st(&s) {
            // 自定义标的里的 ST 也算进剔除数, 免得「我加了却没跑」无声无息
            filtered_out += 1;
            continue;
        }
        symbols.push(s);
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
            if req.end.is_some_and(|e| date > e) {
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

        // 模拟区间起点之前的 K 线保留一段做预热，只保留离起点最近的那些。
        let first_sim = req
            .start
            .map(|s| bars.partition_point(|b| b.date < s))
            .unwrap_or(0);
        let keep_from = first_sim.saturating_sub(WARMUP_BARS);
        let warmup = first_sim - keep_from;
        if keep_from > 0 {
            bars.drain(..keep_from);
        }
        if bars.len() <= warmup {
            missing.push(symbol);
            continue;
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
                warmup,
                by_date,
            },
        );
    }

    if series_map.is_empty() {
        return Err(DataError::Empty(
            "no cached bars found for the requested pool".into(),
        ));
    }

    // 全量日历（含预热段）：regime 必须在这里算，才能让 MA60/breadth 在
    // 模拟第一天就已经热身完毕。随后再按 [start, end] 切出模拟日历。
    let mut all_dates: Vec<NaiveDate> = series_map
        .values()
        .flat_map(|s| s.bars.iter().map(|b| b.date))
        .collect();
    all_dates.sort_unstable();
    all_dates.dedup();

    let regime_all = build_regime(&all_dates, &series_map);

    let from = all_dates.partition_point(|d| req.start.is_some_and(|s| *d < s));
    let to = all_dates.partition_point(|d| req.end.is_some_and(|e| *d <= e));
    if to <= from {
        return Err(DataError::Empty(
            "no trading days in the requested window".into(),
        ));
    }
    let dates: Vec<NaiveDate> = all_dates[from..to].to_vec();
    let regime: Vec<RegimePoint> = regime_all[from..to].to_vec();

    Ok(Market {
        dates,
        series: series_map,
        missing,
        filtered_out,
        regime,
    })
}

/// 逐日聚合池子级市场状态。复杂度 O(总 K 线数)，只在加载时算一次。
fn build_regime(dates: &[NaiveDate], series: &BTreeMap<String, SymbolSeries>) -> Vec<RegimePoint> {
    let n = dates.len();
    let date_index: HashMap<NaiveDate, usize> = dates
        .iter()
        .enumerate()
        .map(|(i, d)| (*d, i))
        .collect();

    let mut above = vec![0usize; n];
    let mut counted = vec![0usize; n];
    let mut level_sum = vec![0.0f64; n];
    let mut level_cnt = vec![0usize; n];

    for s in series.values() {
        let Some(first) = s.bars.first().map(|b| b.close) else {
            continue;
        };
        if !(first > 0.0) {
            continue;
        }
        let mut sum = 0.0f64;
        for (k, b) in s.bars.iter().enumerate() {
            sum += b.close;
            if k >= 60 {
                sum -= s.bars[k - 60].close;
            }
            let Some(&di) = date_index.get(&b.date) else {
                continue;
            };
            level_sum[di] += b.close / first;
            level_cnt[di] += 1;
            if k >= 59 {
                counted[di] += 1;
                if b.close > sum / 60.0 {
                    above[di] += 1;
                }
            }
        }
    }

    // 等权净值：当日有行情的成分股 close/first_close 的均值，缺失日沿用前值。
    let mut index: Vec<f64> = Vec::with_capacity(n);
    let mut last = f64::NAN;
    for i in 0..n {
        if level_cnt[i] > 0 {
            last = level_sum[i] / level_cnt[i] as f64;
        }
        index.push(last);
    }

    // 净值自身的 MA60 与 20 日斜率
    let mut out = Vec::with_capacity(n);
    let mut win = 0.0f64;
    for i in 0..n {
        win += index[i];
        if i >= 60 {
            win -= index[i - 60];
        }
        let ma60 = if i >= 59 { win / 60.0 } else { f64::NAN };
        let slope20 = if i >= 20 && index[i - 20] > 0.0 {
            (index[i] / index[i - 20] - 1.0) * 100.0
        } else {
            0.0
        };
        let breadth = if counted[i] > 0 {
            above[i] as f64 / counted[i] as f64
        } else {
            0.0
        };
        let dist = if ma60.is_finite() && ma60 > 0.0 {
            (index[i] / ma60 - 1.0) * 100.0
        } else {
            0.0
        };
        out.push(RegimePoint {
            breadth_ma60: breadth,
            index_ma60_dist: dist,
            index_slope20: slope20,
            valid: i >= 80 && ma60.is_finite(),
        });
    }
    out
}
