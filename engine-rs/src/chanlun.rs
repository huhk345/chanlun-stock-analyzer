//! 缠论结构计算：合并 K 线 → 分型 → 笔 → 笔中枢。
//!
//! 与前端 `src/utils/chanlun.ts` 的算法逐行对齐（同样的包含处理、同样的
//! 两遍分型连接、同样的中枢扩张规则），目的是让 Rust 引擎和 TS 引擎对同一段
//! 行情画出同一组笔和中枢——否则同一个策略在两套回测里会给出不同的买卖点。
//!
//! 唯一的有意差异：`zg/zd/gg/dd` 不做 `toFixed(2)` 取整，保留原始精度。

use crate::data::Bar;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FractionKind {
    Top,
    Bottom,
}

#[derive(Debug, Clone, Copy)]
pub struct Fraction {
    pub kind: FractionKind,
    pub price: f64,
    /// 合并 K 线数组下标
    pub merged_index: usize,
    /// 原始 K 线下标
    pub original_index: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct Stroke {
    pub start: Fraction,
    pub end: Fraction,
    pub up: bool,
}

impl Stroke {
    pub fn high(&self) -> f64 {
        self.start.price.max(self.end.price)
    }

    pub fn low(&self) -> f64 {
        self.start.price.min(self.end.price)
    }

    /// 笔的力度代理：价差绝对值（与 TS 的 `strokePowerPrice` 同口径）
    pub fn power(&self) -> f64 {
        (self.end.price - self.start.price).abs()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Hub {
    pub zg: f64,
    pub zd: f64,
    pub gg: f64,
    pub dd: f64,
    /// 中枢首笔起点的原始 K 线下标
    pub start_index: usize,
    /// 中枢末笔终点的原始 K 线下标
    pub end_index: usize,
    pub strokes: usize,
}

#[derive(Debug, Default)]
pub struct Structures {
    /// 去重后的分型（严格交替，可直接用于背驰比较）
    pub fractions: Vec<Fraction>,
    pub strokes: Vec<Stroke>,
    pub hubs: Vec<Hub>,
}

// ---------------------------------------------------------------------------
// Step 1: 包含关系处理
// ---------------------------------------------------------------------------

struct Merged {
    high: f64,
    low: f64,
    up: bool,
    /// 合并进来的原始 K 线下标区间（始终连续）
    first: usize,
    last: usize,
}

fn merge(bars: &[Bar]) -> Vec<Merged> {
    let mut out: Vec<Merged> = Vec::with_capacity(bars.len());
    if bars.is_empty() {
        return out;
    }
    out.push(Merged {
        high: bars[0].high,
        low: bars[0].low,
        up: true,
        first: 0,
        last: 0,
    });

    for (i, k) in bars.iter().enumerate().skip(1) {
        let idx = out.len() - 1;
        let (last_high, last_low) = (out[idx].high, out[idx].low);
        let last_contains = last_high >= k.high && last_low <= k.low;
        let cur_contains = k.high >= last_high && k.low <= last_low;

        if last_contains || cur_contains {
            // 方向由「合并前」的最后两根合并 K 线决定，与 TS 完全一致
            let up = if out.len() > 1 {
                let prev_high = out[out.len() - 2].high;
                if last_high > prev_high {
                    true
                } else if last_high < prev_high {
                    false
                } else {
                    out[idx].up
                }
            } else {
                out[idx].up
            };
            if up {
                out[idx].high = last_high.max(k.high);
                out[idx].low = last_low.max(k.low);
            } else {
                out[idx].high = last_high.min(k.high);
                out[idx].low = last_low.min(k.low);
            }
            out[idx].up = up;
            out[idx].last = i;
        } else {
            let up = k.high > last_high;
            out.push(Merged {
                high: k.high,
                low: k.low,
                up,
                first: i,
                last: i,
            });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Step 2: 分型
// ---------------------------------------------------------------------------

fn fractions(bars: &[Bar], merged: &[Merged]) -> Vec<Fraction> {
    let mut out = Vec::new();
    if merged.len() < 3 {
        return out;
    }
    for i in 1..merged.len() - 1 {
        let (p, c, nx) = (&merged[i - 1], &merged[i], &merged[i + 1]);
        let is_top = c.high > p.high && c.high > nx.high && c.low > p.low && c.low > nx.low;
        let is_bottom = c.low < p.low && c.low < nx.low && c.high < p.high && c.high < nx.high;
        if !is_top && !is_bottom {
            continue;
        }
        // 合并 K 线的原始区间是连续的，直接在其中找极值那一根
        let mut best = c.first;
        for oi in c.first..=c.last {
            let better = if is_top {
                bars[oi].high > bars[best].high
            } else {
                bars[oi].low < bars[best].low
            };
            if better {
                best = oi;
            }
        }
        out.push(Fraction {
            kind: if is_top {
                FractionKind::Top
            } else {
                FractionKind::Bottom
            },
            price: if is_top {
                bars[best].high
            } else {
                bars[best].low
            },
            merged_index: i,
            original_index: best,
        });
    }
    out
}

/// 两遍过滤：同类型取极值，异类型要求间隔 ≥ `min_distance`
fn connect(points: &[Fraction], min_distance: usize) -> Vec<Fraction> {
    let mut out: Vec<Fraction> = Vec::with_capacity(points.len());
    for fx in points {
        let Some(last) = out.last().copied() else {
            out.push(*fx);
            continue;
        };
        if fx.kind == last.kind {
            let better = match fx.kind {
                FractionKind::Top => fx.price > last.price,
                FractionKind::Bottom => fx.price < last.price,
            };
            if better {
                *out.last_mut().expect("non-empty") = *fx;
            }
        } else if fx.merged_index.abs_diff(last.merged_index) >= min_distance {
            out.push(*fx);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Step 3/4: 笔与中枢
// ---------------------------------------------------------------------------

fn strokes(points: &[Fraction]) -> Vec<Stroke> {
    let mut out = Vec::with_capacity(points.len().saturating_sub(1));
    for w in points.windows(2) {
        let (a, b) = (w[0], w[1]);
        if a.kind == b.kind {
            continue;
        }
        out.push(Stroke {
            start: a,
            end: b,
            up: a.kind == FractionKind::Bottom,
        });
    }
    out
}

fn hubs(strokes: &[Stroke]) -> Vec<Hub> {
    let mut out = Vec::new();
    if strokes.len() < 3 {
        return out;
    }
    let mut i = 0usize;
    while i + 2 < strokes.len() {
        let (l1, l2, l3) = (&strokes[i], &strokes[i + 1], &strokes[i + 2]);
        let zg = l1.high().min(l2.high()).min(l3.high());
        let zd = l1.low().max(l2.low()).max(l3.low());
        if zg > zd {
            let mut gg = l1.high().max(l2.high()).max(l3.high());
            let mut dd = l1.low().min(l2.low()).min(l3.low());
            let mut end_index = l3.end.original_index;
            let mut count = 3usize;
            let mut j = i + 3;
            while j < strokes.len() {
                let s = &strokes[j];
                if s.high() > zd && s.low() < zg {
                    end_index = s.end.original_index;
                    gg = gg.max(s.high());
                    dd = dd.min(s.low());
                    count += 1;
                    j += 1;
                } else {
                    break;
                }
            }
            out.push(Hub {
                zg,
                zd,
                gg,
                dd,
                start_index: l1.start.original_index,
                end_index,
                strokes: count,
            });
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// 一次性算出分型 / 笔 / 中枢。
pub fn compute(bars: &[Bar]) -> Structures {
    let merged = merge(bars);
    let raw = fractions(bars, &merged);
    let points = connect(&connect(&raw, 4), 4);
    let st = strokes(&points);
    let hb = hubs(&st);
    Structures {
        fractions: points,
        strokes: st,
        hubs: hb,
    }
}
