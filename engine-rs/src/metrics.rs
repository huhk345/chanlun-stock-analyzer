//! Performance statistics computed from the recorded equity curve + trade ledger.

use serde::Serialize;

fn r4(v: f64) -> f64 {
    if !v.is_finite() {
        return 0.0;
    }
    (v * 10_000.0).round() / 10_000.0
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Metrics {
    pub initial_cash: f64,
    pub final_equity: f64,
    pub total_return_percent: f64,
    pub buy_hold_return_percent: f64,
    pub excess_return_percent: f64,
    pub annualized_percent: f64,
    pub max_drawdown_percent: f64,
    pub sharpe: f64,
    pub volatility_percent: f64,
    pub trades: usize,
    pub win_rate_percent: f64,
    pub profit_factor: f64,
    pub total_fees: f64,
    pub exposure_percent: f64,
    pub trading_days: usize,
}

pub fn max_drawdown(equity: &[f64]) -> f64 {
    let mut peak = f64::MIN;
    let mut worst = 0.0;
    for &e in equity {
        if e > peak {
            peak = e;
        }
        if peak > 0.0 {
            let dd = (e / peak - 1.0) * 100.0;
            if dd < worst {
                worst = dd;
            }
        }
    }
    worst
}

/// Daily-return Sharpe with a 0 risk-free rate (A-share convention in this repo).
pub fn sharpe(equity: &[f64]) -> f64 {
    if equity.len() < 3 {
        return 0.0;
    }
    let mut rets = Vec::with_capacity(equity.len() - 1);
    for w in equity.windows(2) {
        if w[0] > 0.0 {
            rets.push(w[1] / w[0] - 1.0);
        }
    }
    if rets.len() < 2 {
        return 0.0;
    }
    let mean = rets.iter().sum::<f64>() / rets.len() as f64;
    let var = rets.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (rets.len() - 1) as f64;
    let sd = var.sqrt();
    if sd <= 0.0 {
        return 0.0;
    }
    mean / sd * (252f64).sqrt()
}

pub fn annualized_volatility(equity: &[f64]) -> f64 {
    if equity.len() < 3 {
        return 0.0;
    }
    let mut rets = Vec::with_capacity(equity.len() - 1);
    for w in equity.windows(2) {
        if w[0] > 0.0 {
            rets.push(w[1] / w[0] - 1.0);
        }
    }
    if rets.len() < 2 {
        return 0.0;
    }
    let mean = rets.iter().sum::<f64>() / rets.len() as f64;
    let var = rets.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (rets.len() - 1) as f64;
    var.sqrt() * (252f64).sqrt() * 100.0
}

/// `closed_pnls` are realised PnL per round trip.
pub fn build_metrics(
    initial_cash: f64,
    equity: &[f64],
    buy_hold_final: f64,
    closed_pnls: &[f64],
    total_fees: f64,
    days_in_market: usize,
) -> Metrics {
    let final_equity = equity.last().copied().unwrap_or(initial_cash);
    let total_return = if initial_cash > 0.0 {
        (final_equity / initial_cash - 1.0) * 100.0
    } else {
        0.0
    };
    let bh_return = if initial_cash > 0.0 {
        (buy_hold_final / initial_cash - 1.0) * 100.0
    } else {
        0.0
    };

    let wins = closed_pnls.iter().filter(|&&p| p > 0.0).count();
    let gross_win: f64 = closed_pnls.iter().filter(|&&p| p > 0.0).sum();
    let gross_loss: f64 = closed_pnls.iter().filter(|&&p| p < 0.0).map(|p| -p).sum();

    let years = (equity.len().max(1) as f64) / 252.0;
    let annualized = if years > 0.0 && final_equity > 0.0 && initial_cash > 0.0 {
        ((final_equity / initial_cash).powf(1.0 / years) - 1.0) * 100.0
    } else {
        0.0
    };

    Metrics {
        initial_cash,
        final_equity: r4(final_equity),
        total_return_percent: r4(total_return),
        buy_hold_return_percent: r4(bh_return),
        excess_return_percent: r4(total_return - bh_return),
        annualized_percent: r4(annualized),
        max_drawdown_percent: r4(max_drawdown(equity)),
        sharpe: r4(sharpe(equity)),
        volatility_percent: r4(annualized_volatility(equity)),
        trades: closed_pnls.len(),
        win_rate_percent: r4(if closed_pnls.is_empty() {
            0.0
        } else {
            wins as f64 / closed_pnls.len() as f64 * 100.0
        }),
        profit_factor: r4(if gross_loss > 0.0 {
            gross_win / gross_loss
        } else if gross_win > 0.0 {
            f64::INFINITY
        } else {
            0.0
        }),
        total_fees: r4(total_fees),
        exposure_percent: r4(if equity.is_empty() {
            0.0
        } else {
            days_in_market as f64 / equity.len() as f64 * 100.0
        }),
        trading_days: equity.len(),
    }
}
