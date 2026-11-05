//! Helpers shared by the built-in strategies.

use crate::data::Bar;

/// 缠论结构只在尾部这么长的窗口上重算：中枢有效期是 120 日，320 根足够覆盖，
/// 同时把「逐日全量重算」的代价压成常数（否则整池回测会退化成 O(n²)）。
pub(super) const CL_WINDOW: usize = 320;
pub(super) const HUB_LOOKBACK: usize = 120;
pub(super) const MAX_HUB_AMP: f64 = 30.0;
/// 回吐上限：浮盈见顶后最多回吐一半。
///
/// Chandelier 跟踪是 `最高价 − trail_atr × ATR`，在 2.3% ATR 的票上等于 11% 的回吐空间，
/// 也就是说**浮盈不到 11% 时这条线根本不存在**，赢家只能靠保本线兜着。把它换成 R 单位
/// 看是 `trail_atr × ATR / 风险`，每个股票池都是不同的数 —— 这正是「参数在押池子」的来源：
/// 沪深300 的赢家能跑到 +21%（跟踪线有效），中证500 的赢家只到 +9%（跟踪线是死代码），
/// 同一套规则在后者上等于没有止盈。
///
/// 这条线改在**盈利空间**里定义：`成本 + (最高浮盈) × 0.5`。因为止损线取各条线的最大值，
/// 它只在「ATR 跟踪线比它更松」时生效 —— 也就是只在小/中赢家上收紧，大趋势碰不到它。
/// 沪深300 实测：均值 10.72%→10.50%，中位数 4.95%→8.17%，胜率 53%→59%；
/// 低趋势效率（震荡）子样本 2.14%→4.31%，胜率 33%→47%。
pub(super) const GIVEBACK_KEEP: f64 = 0.5;

pub(super) fn sma_at(v: &[f64], end: usize, n: usize) -> Option<f64> {
    if n == 0 || end + 1 < n {
        return None;
    }
    Some(v[end + 1 - n..=end].iter().sum::<f64>() / n as f64)
}

pub(super) fn highest_high(bars: &[Bar], end: usize, n: usize) -> Option<f64> {
    if n == 0 || end + 1 < n {
        return None;
    }
    bars[end + 1 - n..=end]
        .iter()
        .map(|b| b.high)
        .fold(None, |acc: Option<f64>, h| Some(acc.map_or(h, |a| a.max(h))))
}

pub(super) fn lowest_low(bars: &[Bar], end: usize, n: usize) -> Option<f64> {
    if n == 0 || end + 1 < n {
        return None;
    }
    bars[end + 1 - n..=end]
        .iter()
        .map(|b| b.low)
        .fold(None, |acc: Option<f64>, l| Some(acc.map_or(l, |a| a.min(l))))
}

/// 海龟的 N：`period` 日真实波幅均值（ATR），end 处含当日。
pub(super) fn atr_at(bars: &[Bar], end: usize, period: usize) -> Option<f64> {
    if period == 0 || end < period {
        return None;
    }
    let mut sum = 0.0;
    for i in (end + 1 - period)..=end {
        let prev = bars.get(i.checked_sub(1)?)?.close;
        let b = bars.get(i)?;
        let tr = (b.high - b.low)
            .max((b.high - prev).abs())
            .max((b.low - prev).abs());
        if !tr.is_finite() {
            return None;
        }
        sum += tr;
    }
    Some(sum / period as f64)
}

/// 20 日平均成交额（万元）。`BarState` 里没有 amount 字段，按 volume×close×100 估算
/// （缓存里的 volume 单位是「手」）。
pub(super) fn avg_amount_wan(bars: &[Bar], end: usize, n: usize) -> Option<f64> {
    if end + 1 < n {
        return None;
    }
    let sum: f64 = bars[end + 1 - n..=end]
        .iter()
        .map(|b| b.volume * b.close * 100.0)
        .sum();
    Some(sum / n as f64 / 10_000.0)
}

/// 周线确认：按 5 日收盘对齐到「本周」，周收盘站上 10 周均线且均线上行。
pub(super) fn weekly_trend_ok(closes: &[f64]) -> bool {
    let n = closes.len();
    if n < 5 * 14 {
        return false;
    }
    let mut weekly: Vec<f64> = Vec::with_capacity(n / 5);
    let mut i = n;
    while i >= 5 {
        weekly.push(closes[i - 1]);
        i -= 5;
    }
    weekly.reverse();
    let m = weekly.len();
    if m < 11 {
        return false;
    }
    let ma10 = weekly[m - 10..].iter().sum::<f64>() / 10.0;
    // 约一个月前的 10 周均线（第 m-13..m-3 周）
    let ma10_prev = weekly[m - 13..m - 3].iter().sum::<f64>() / 10.0;
    weekly[m - 1] > ma10 && ma10 > ma10_prev
}

pub(super) fn avg_vol(bars: &[Bar], from: usize, to: usize) -> f64 {
    if to < from {
        return 0.0;
    }
    let sum: f64 = bars[from..=to].iter().map(|b| b.volume).sum();
    sum / (to - from + 1) as f64
}

/// 分批卖出的比例修正：A 股一手 100 股，按比例拆出来的量不足一手时，
/// 撮合层会算出 0 手直接拒单（决策日志里表现为「无可卖数量」）。
pub(super) fn tradable_frac(shares: f64, frac: f64) -> f64 {
    if shares * frac / 100.0 < 100.0 {
        100.0
    } else {
        frac
    }
}
