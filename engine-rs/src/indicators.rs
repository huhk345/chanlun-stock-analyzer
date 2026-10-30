//! 策略用的基础指标。
//!
//! 与前端 `src/utils/indicators.ts` / JS 策略里的实现同口径：EMA 用首值做种子、
//! MACD 柱 = (DIF - DEA) × 2、ATR 用 Wilder 平滑。策略在同一个尾部窗口上算，
//! 所以两套引擎得到的是同一条曲线。

/// EMA，用首值做种子（配合 300 根左右的窗口，EMA60 的预热偏差可忽略）。
pub fn ema(values: &[f64], period: usize) -> Vec<f64> {
    let mut out = vec![0.0; values.len()];
    if values.is_empty() || period == 0 {
        return out;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut prev = values[0];
    out[0] = prev;
    for i in 1..values.len() {
        prev = values[i] * k + prev * (1.0 - k);
        out[i] = prev;
    }
    out
}

/// MACD(12, 26, 9) 的柱状值。
pub fn macd_hist(closes: &[f64], fast: usize, slow: usize, signal: usize) -> Vec<f64> {
    let ef = ema(closes, fast);
    let es = ema(closes, slow);
    let dif: Vec<f64> = ef.iter().zip(es.iter()).map(|(a, b)| a - b).collect();
    let dea = ema(&dif, signal);
    dif.iter().zip(dea.iter()).map(|(d, s)| (d - s) * 2.0).collect()
}

/// Wilder ATR。
pub fn atr(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> Vec<f64> {
    let n = closes.len();
    let mut out = vec![0.0; n];
    if n == 0 || period == 0 {
        return out;
    }
    let mut sum = 0.0;
    for i in 1..n {
        let tr = (highs[i] - lows[i])
            .max((highs[i] - closes[i - 1]).abs())
            .max((lows[i] - closes[i - 1]).abs());
        if i <= period {
            sum += tr;
            out[i] = sum / i as f64;
        } else {
            out[i] = (out[i - 1] * (period as f64 - 1.0) + tr) / period as f64;
        }
    }
    out[0] = highs[0] - lows[0];
    out
}

/// 区间内 MACD 柱面积：`positive=true` 取红柱，否则取绿柱绝对值。
pub fn macd_area(hist: &[f64], from: usize, to: usize, positive: bool) -> f64 {
    if hist.is_empty() || to <= from {
        return 0.0;
    }
    let a = (from + 1).min(hist.len() - 1);
    let b = to.min(hist.len() - 1);
    if b < a {
        return 0.0;
    }
    hist[a..=b]
        .iter()
        .filter(|h| if positive { **h > 0.0 } else { **h < 0.0 })
        .map(|h| h.abs())
        .sum()
}
