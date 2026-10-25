/**
 * 研究脚本: 长期突破 (LT breakout) 与 OBV 量能累积的收益来源拆解 + 融合策略搜索。
 *
 * 数据: 本地 K 线缓存 (.cache/klines, 2023-01-03 起, 前复权), 沪深300 + 中证500 成分股。
 * 口径:
 *   - 因子/信号只用「截止当根收盘」的数据, 未来收益只用于 IC 评估;
 *   - 组合模拟逐标的独立、等权汇总, 收盘信号按收盘价成交;
 *   - 费用与项目引擎一致: 佣金 0.025% (最低 5 元) + 卖方印花税 0.1% + 过户费 0.001%;
 *   - 涨停买不进 / 跌停卖不出。
 *
 * 用法: pnpm exec tsx scripts/research-breakout-obv.ts
 */
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const BASE = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(BASE, '.cache', 'klines');
const OUT_JSON = path.join(BASE, 'reports', 'breakout-obv-research.json');

const INDEXES = ['hs300', 'zz500'] as const;
const DATA_START = '2023-01-01';
const SIM_START = '2023-06-01'; // 100 日 MA + 55 日突破窗口走完
const WARMUP = 100;
const HORIZONS = [5, 10, 20, 60] as const;
const INITIAL_CASH = 100_000;
const COMMISSION_RATE = 0.00025;
const MIN_COMMISSION = 5;

// ---------------------------------------------------------------------------
// 类型与基础工具
// ---------------------------------------------------------------------------

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Stock {
  symbol: string;
  index: 'hs300' | 'zz500';
  bars: Bar[];
}

interface Indicators {
  n: number;
  ma50: Float64Array;
  ma100: Float64Array;
  ma100Prev20: Float64Array;
  hh55Prev: Float64Array;
  hh20Prev: Float64Array;
  ll20Prev: Float64Array;
  ll10Prev: Float64Array;
  obv: Float64Array;
  obvMax20Prev: Float64Array;
  obvAvg20: Float64Array;
  obvSlope20: Float64Array;
  volAvg20Prev: Float64Array;
  b55: Float64Array;
  t100: Float64Array;
  s100: Float64Array;
  t50: Float64Array;
  obvBreak: Float64Array;
  obvSlopeNorm: Float64Array;
  volRatio: Float64Array;
  ma20: Float64Array;
  ext20: Float64Array;
  ret20: Float64Array;
  ret60: Float64Array;
  ret120: Float64Array;
  vol20: Float64Array;
  vol60: Float64Array;
  dist52w: Float64Array;
  daysSinceBreak: Float64Array;
  daysSinceObvHigh: Float64Array;
}

interface Ref {
  stock: Stock;
  i: number;
  close: number;
}

const isNum = (v: number): boolean => Number.isFinite(v);

function mean(v: number[]): number {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}
function std(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
}
function median(v: number[]): number {
  if (!v.length) return 0;
  const a = [...v].sort((x, y) => x - y);
  const k = Math.floor(a.length / 2);
  return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
}

function maxDrawdown(curve: number[]): number {
  let peak = curve[0] ?? 0;
  let dd = 0;
  for (const x of curve) {
    if (x > peak) peak = x;
    else if (peak > 0) dd = Math.max(dd, ((peak - x) / peak) * 100);
  }
  return dd;
}

function sharpe(curve: number[]): number {
  const r: number[] = [];
  for (let i = 1; i < curve.length; i++) r.push(curve[i - 1] > 0 ? curve[i] / curve[i - 1] - 1 : 0);
  const s = std(r);
  return s > 0 ? (mean(r) / s) * Math.sqrt(252) : 0;
}

function fees(value: number, isBuy: boolean): number {
  return Math.max(value * COMMISSION_RATE, MIN_COMMISSION) + (isBuy ? 0 : value * 0.001) + value * 0.00001;
}

function limitRatio(symbol: string): number {
  const code = symbol.split('.')[0];
  if (/^(688|300)/.test(code)) return 1.2;
  if (/^[48]/.test(code)) return 1.05;
  return 1.1;
}
const limitUp = (prev: number, symbol: string): number => Math.round(prev * limitRatio(symbol) * 100) / 100;
const limitDown = (prev: number, symbol: string): number => Math.round(prev * (2 - limitRatio(symbol)) * 100) / 100;

// ---------------------------------------------------------------------------
// 指标
// ---------------------------------------------------------------------------

function rollingMean(vals: number[], w: number): Float64Array {
  const n = vals.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += vals[i];
    if (i >= w) sum -= vals[i - w];
    if (i >= w - 1) out[i] = sum / w;
  }
  return out;
}

function rollingStd(vals: number[], w: number): Float64Array {
  const n = vals.length;
  const out = new Float64Array(n).fill(NaN);
  let s = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s += vals[i];
    s2 += vals[i] * vals[i];
    if (i >= w) {
      s -= vals[i - w];
      s2 -= vals[i - w] * vals[i - w];
    }
    if (i >= w - 1) {
      const m = s / w;
      out[i] = Math.sqrt(Math.max(0, s2 / w - m * m));
    }
  }
  return out;
}

function rollingExtreme(vals: number[], w: number, isMax: boolean): Float64Array {
  const n = vals.length;
  const out = new Float64Array(n).fill(NaN);
  const dq: number[] = [];
  let head = 0;
  for (let i = 0; i < n; i++) {
    while (dq.length > head && (isMax ? vals[dq[dq.length - 1]] <= vals[i] : vals[dq[dq.length - 1]] >= vals[i])) dq.pop();
    dq.push(i);
    if (dq[head] <= i - w) head++;
    if (i >= w - 1) out[i] = vals[dq[head]];
  }
  return out;
}

function computeIndicators(s: Stock): Indicators {
  const bars = s.bars;
  const n = bars.length;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const vols = bars.map((b) => b.volume);

  const ma20 = rollingMean(closes, 20);
  const ma50 = rollingMean(closes, 50);
  const ma100 = rollingMean(closes, 100);
  const dailyRet = closes.map((c, i) => (i > 0 && closes[i - 1] > 0 ? c / closes[i - 1] - 1 : 0));
  const vol20 = rollingStd(dailyRet, 20);
  const vol60 = rollingStd(dailyRet, 60);
  const closeMax250 = rollingExtreme(closes, 250, true);
  const hh55 = rollingExtreme(highs, 55, true);
  const hh20 = rollingExtreme(highs, 20, true);
  const ll20 = rollingExtreme(lows, 20, false);
  const ll10 = rollingExtreme(lows, 10, false);
  const volAvg20 = rollingMean(vols, 20);

  const obv = new Float64Array(n);
  obv[0] = 0;
  for (let i = 1; i < n; i++) {
    if (closes[i] > closes[i - 1]) obv[i] = obv[i - 1] + vols[i];
    else if (closes[i] < closes[i - 1]) obv[i] = obv[i - 1] - vols[i];
    else obv[i] = obv[i - 1];
  }
  const obvMax20 = rollingExtreme(Array.from(obv), 20, true);
  const obvAvg20 = rollingMean(Array.from(obv), 20);

  const out: Indicators = {
    n,
    ma20,
    ma50,
    ma100,
    ma100Prev20: new Float64Array(n).fill(NaN),
    hh55Prev: new Float64Array(n).fill(NaN),
    hh20Prev: new Float64Array(n).fill(NaN),
    ll20Prev: new Float64Array(n).fill(NaN),
    ll10Prev: new Float64Array(n).fill(NaN),
    obv,
    obvMax20Prev: new Float64Array(n).fill(NaN),
    obvAvg20,
    obvSlope20: new Float64Array(n).fill(NaN),
    volAvg20Prev: new Float64Array(n).fill(NaN),
    b55: new Float64Array(n).fill(NaN),
    t100: new Float64Array(n).fill(NaN),
    s100: new Float64Array(n).fill(NaN),
    t50: new Float64Array(n).fill(NaN),
    obvBreak: new Float64Array(n).fill(NaN),
    obvSlopeNorm: new Float64Array(n).fill(NaN),
    volRatio: new Float64Array(n).fill(NaN),
    ext20: new Float64Array(n).fill(NaN),
    ret20: new Float64Array(n).fill(NaN),
    ret60: new Float64Array(n).fill(NaN),
    ret120: new Float64Array(n).fill(NaN),
    vol20,
    vol60,
    dist52w: new Float64Array(n).fill(NaN),
    daysSinceBreak: new Float64Array(n).fill(NaN),
    daysSinceObvHigh: new Float64Array(n).fill(NaN),
  };

  for (let i = 0; i < n; i++) {
    if (i >= 20) {
      out.hh55Prev[i] = hh55[i - 1];
      out.hh20Prev[i] = hh20[i - 1];
      out.ll20Prev[i] = ll20[i - 1];
      out.ll10Prev[i] = ll10[i - 1];
      out.obvMax20Prev[i] = obvMax20[i - 1];
      out.volAvg20Prev[i] = volAvg20[i - 1];
    }
    if (i >= 20 && isNum(ma100[i])) out.ma100Prev20[i] = ma100[i - 20];

    const volBase = out.volAvg20Prev[i];
    const hasVol = isNum(volBase) && volBase > 0;

    if (hasVol) out.volRatio[i] = vols[i] / volBase;
    if (hasVol && isNum(out.obvMax20Prev[i])) {
      out.obvBreak[i] = (obv[i] - out.obvMax20Prev[i]) / (volBase * 20);
    }
    if (hasVol && i >= 20) {
      out.obvSlope20[i] = obv[i] - obv[i - 20];
      out.obvSlopeNorm[i] = (obv[i] - obv[i - 20]) / (volBase * 20);
    }

    if (isNum(out.hh55Prev[i]) && out.hh55Prev[i] > 0) out.b55[i] = closes[i] / out.hh55Prev[i] - 1;
    if (isNum(ma100[i]) && ma100[i] > 0) out.t100[i] = closes[i] / ma100[i] - 1;
    if (isNum(ma100[i]) && isNum(out.ma100Prev20[i]) && out.ma100Prev20[i] > 0) {
      out.s100[i] = ma100[i] / out.ma100Prev20[i] - 1;
    }
    if (isNum(ma50[i]) && ma50[i] > 0) out.t50[i] = closes[i] / ma50[i] - 1;
    if (isNum(ma20[i]) && ma20[i] > 0) out.ext20[i] = closes[i] / ma20[i] - 1;
    if (i >= 20 && closes[i - 20] > 0) out.ret20[i] = closes[i] / closes[i - 20] - 1;
    if (i >= 60 && closes[i - 60] > 0) out.ret60[i] = closes[i] / closes[i - 60] - 1;
    if (i >= 120 && closes[i - 120] > 0) out.ret120[i] = closes[i] / closes[i - 120] - 1;
    if (isNum(closeMax250[i]) && closeMax250[i] > 0) out.dist52w[i] = closes[i] / closeMax250[i] - 1;
  }

  // 突破 / OBV 新高的「新鲜度」: 距最近一次触发过了多少根 (0 = 今日触发)
  for (let i = 55; i < n; i++) {
    const broke = closes[i] > out.hh55Prev[i];
    out.daysSinceBreak[i] = broke ? 0 : (i > 55 ? out.daysSinceBreak[i - 1] + 1 : 1);
  }
  for (let i = 20; i < n; i++) {
    const obvHigh = out.obv[i] > out.obvMax20Prev[i];
    out.daysSinceObvHigh[i] = obvHigh ? 0 : (i > 20 ? out.daysSinceObvHigh[i - 1] + 1 : 1);
  }

  return out;
}

// ---------------------------------------------------------------------------
// 秩相关 / IC
// ---------------------------------------------------------------------------

function percentileRanks(vals: number[]): number[] {
  const n = vals.length;
  if (n <= 1) return new Array(n).fill(0.5);
  const idx = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
  const out = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && vals[idx[j + 1]] === vals[idx[i]]) j++;
    const r = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[idx[k]] = r;
    i = j + 1;
  }
  return out;
}

function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 3) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function spearman(x: number[], y: number[]): number | null {
  if (x.length < 20) return null;
  return pearson(percentileRanks(x), percentileRanks(y));
}

interface IcStat {
  mean: number;
  sd: number;
  ir: number;
  irAnnual: number;
  t: number;
  n: number;
  posRate: number;
}

function icStat(series: number[], horizon: number): IcStat {
  const m = mean(series);
  const sd = std(series);
  const ir = sd > 0 ? m / sd : 0;
  return {
    mean: m,
    sd,
    ir,
    irAnnual: ir * Math.sqrt(252 / horizon),
    t: sd > 0 && series.length > 1 ? (m / sd) * Math.sqrt(series.length) : 0,
    n: series.length,
    posRate: series.length ? series.filter((v) => v > 0).length / series.length : 0,
  };
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

function loadUniverse(): Stock[] {
  const meta = new Map<string, 'hs300' | 'zz500'>();
  for (const idx of INDEXES) {
    const list = JSON.parse(fs.readFileSync(path.join(BASE, 'data', idx, '_constituents.json'), 'utf-8')) as string[];
    for (const symbol of list) meta.set(symbol, idx);
  }

  const stocks: Stock[] = [];
  for (const [symbol, idx] of meta) {
    const file = path.join(CACHE_DIR, `${symbol}_1d_forward.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { klines?: Bar[] };
      const bars = (raw.klines ?? [])
        .filter((b) => b.date >= DATA_START && Number.isFinite(b.close) && b.close > 0 && b.volume > 0)
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      if (bars.length < WARMUP + 20) continue;
      stocks.push({ symbol, index: idx, bars });
    } catch {
      // 跳过损坏缓存
    }
  }
  return stocks;
}

// ---------------------------------------------------------------------------
// 组合模拟
// ---------------------------------------------------------------------------

interface Variant {
  id: string;
  label: string;
  buy: (ind: Indicators, i: number, bars: Bar[]) => boolean;
  sell: (ind: Indicators, i: number, bars: Bar[], entry: Entry) => boolean;
}

interface Entry {
  index: number;
  date: string;
  cost: number;
}

interface TradeStat {
  pnlPercent: number;
  holdingDays: number;
  entryDate: string;
  exitDate: string;
}

interface SimResult {
  dates: string[];
  fractions: number[]; // equity / INITIAL_CASH，仅工作日
  trades: TradeStat[];
  exposure: number; // 有持仓的 K 线占比
}

function simulate(stock: Stock, ind: Indicators, v: Variant, startDate: string): SimResult {
  const { bars, symbol } = stock;
  const dates: string[] = [];
  const fractions: number[] = [];
  const trades: TradeStat[] = [];
  let cash = INITIAL_CASH;
  let shares = 0;
  let entry: Entry | null = null;
  let heldBars = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const prevClose = i > 0 ? bars[i - 1].close : null;
    const price = bar.close;

    if (shares > 0) {
      heldBars++;
      const blocked = prevClose !== null && prevClose > 0 && price <= limitDown(prevClose, symbol);
      if (!blocked && v.sell(ind, i, bars, entry!)) {
        const value = shares * price;
        const fee = fees(value, false);
        cash += value - fee;
        trades.push({
          pnlPercent: ((value - fee - entry!.cost) / entry!.cost) * 100,
          holdingDays: i - entry!.index,
          entryDate: entry!.date,
          exitDate: bar.date,
        });
        shares = 0;
        entry = null;
      }
    } else if (v.buy(ind, i, bars)) {
      const blocked = prevClose !== null && prevClose > 0 && price >= limitUp(prevClose, symbol);
      if (!blocked) {
        let sh = Math.floor(cash / price / 100) * 100;
        while (sh >= 100 && sh * price + fees(sh * price, true) > cash) sh -= 100;
        if (sh > 0) {
          const cost = sh * price;
          const fee = fees(cost, true);
          cash -= cost + fee;
          shares = sh;
          entry = { index: i, date: bar.date, cost: cost + fee };
        }
      }
    }

    if (bar.date >= startDate) {
      dates.push(bar.date);
      fractions.push((cash + shares * price) / INITIAL_CASH);
    }
  }

  return { dates, fractions, trades, exposure: bars.length ? heldBars / bars.length : 0 };
}

interface PortfolioStat {
  id: string;
  label: string;
  totalReturn: number;
  annualReturn: number;
  maxDrawdown: number;
  sharpe: number;
  exposure: number;
  trades: number;
  winRate: number;
  avgTrade: number;
  avgWin: number;
  avgLoss: number;
  payoff: number;
  avgHolding: number;
  medianTrade: number;
  profitConcentration: number;
  yearly: Record<string, number>;
  curve: number[];
  dates: string[];
}

function buildPortfolio(results: SimResult[], startDate: string): { curve: number[]; dates: string[] } {
  const dateSet = new Set<string>();
  for (const r of results) for (const d of r.dates) dateSet.add(d);
  const dates = [...dateSet].sort();
  const ptr = results.map(() => 0);
  const last = results.map(() => 1);
  const curve: number[] = [];

  for (const date of dates) {
    let sum = 0;
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      while (ptr[k] < r.dates.length && r.dates[ptr[k]] <= date) {
        last[k] = r.fractions[ptr[k]];
        ptr[k]++;
      }
      sum += last[k];
    }
    curve.push(sum / results.length);
  }
  return { curve, dates };
}

function summarize(
  v: Variant,
  results: SimResult[],
  startDate: string,
  endDate: string,
): PortfolioStat {
  const { curve, dates } = buildPortfolio(results, startDate);
  const endIdx = dates.findIndex((d) => d >= endDate);
  const useCurve = endIdx >= 0 ? curve.slice(0, endIdx + 1) : curve;
  const useDates = endIdx >= 0 ? dates.slice(0, endIdx + 1) : dates;
  const firstIdx = Math.max(0, useDates.findIndex((d) => d >= startDate));
  const slicedCurve = useCurve.slice(firstIdx).map((x) => x / (useCurve[firstIdx] || 1));
  const slicedDates = useDates.slice(firstIdx);

  const total = slicedCurve[slicedCurve.length - 1] - 1;
  const years = slicedDates.length / 252;
  const annual = years > 0 && total > -1 ? (1 + total) ** (1 / years) - 1 : 0;

  const allTrades = results.flatMap((r) => r.trades.filter((t) => t.exitDate >= startDate && t.exitDate <= endDate));
  const wins = allTrades.filter((t) => t.pnlPercent > 0);
  const losses = allTrades.filter((t) => t.pnlPercent <= 0);
  const avgWin = wins.length ? mean(wins.map((t) => t.pnlPercent)) : 0;
  const avgLoss = losses.length ? mean(losses.map((t) => t.pnlPercent)) : 0;

  const yearly: Record<string, number> = {};
  for (let i = 0; i < slicedDates.length; i++) {
    const y = slicedDates[i].slice(0, 4);
    if (i === 0 || slicedDates[i - 1].slice(0, 4) !== y) {
      yearly[y] = slicedCurve[i];
    }
    yearly[y] = slicedCurve[i] / (yearly[y] || slicedCurve[i]);
  }
  // 用每段首末净值重算年度收益
  const yearKeys = [...new Set(slicedDates.map((d) => d.slice(0, 4)))];
  for (const y of yearKeys) {
    const idxs = slicedDates.map((d, i) => (d.startsWith(y) ? i : -1)).filter((i) => i >= 0);
    if (idxs.length) {
      const base = idxs[0] === 0 ? 1 : slicedCurve[idxs[0] - 1];
      yearly[y] = (slicedCurve[idxs[idxs.length - 1]] / base - 1) * 100;
    }
  }

  return {
    id: v.id,
    label: v.label,
    totalReturn: total * 100,
    annualReturn: annual * 100,
    maxDrawdown: maxDrawdown(slicedCurve),
    sharpe: sharpe(slicedCurve),
    exposure: mean(results.map((r) => r.exposure)) * 100,
    trades: allTrades.length,
    winRate: allTrades.length ? (wins.length / allTrades.length) * 100 : 0,
    avgTrade: allTrades.length ? mean(allTrades.map((t) => t.pnlPercent)) : 0,
    avgWin,
    avgLoss,
    payoff: avgLoss < 0 ? Math.abs(avgWin / avgLoss) : 0,
    avgHolding: allTrades.length ? mean(allTrades.map((t) => t.holdingDays)) : 0,
    medianTrade: median(allTrades.map((t) => t.pnlPercent)),
    profitConcentration: (() => {
      const sorted = [...wins].sort((a, b) => b.pnlPercent - a.pnlPercent);
      const gross = sorted.reduce((s, t) => s + t.pnlPercent, 0);
      if (gross <= 0) return 0;
      const top = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.1)));
      return (top.reduce((s, t) => s + t.pnlPercent, 0) / gross) * 100;
    })(),
    yearly,
    curve: slicedCurve,
    dates: slicedDates,
  };
}

function buyHoldBenchmark(stocks: Stock[], startDate: string, endDate: string): PortfolioStat {
  const results: SimResult[] = stocks.map((s) => {
    const dates: string[] = [];
    const fractions: number[] = [];
    let base = 0;
    for (const b of s.bars) {
      if (!base && b.date >= startDate) base = b.close;
      if (b.date >= startDate) {
        dates.push(b.date);
        fractions.push(base ? b.close / base : 1);
      }
    }
    return { dates, fractions, trades: [], exposure: 1 };
  });
  return summarize({ id: 'buyhold', label: '等权买入持有', buy: () => false, sell: () => false }, results, startDate, endDate);
}

// ---------------------------------------------------------------------------
// 策略变体
// ---------------------------------------------------------------------------

const has = (v: number) => Number.isFinite(v);

const V = (id: string, label: string, buy: Variant['buy'], sell: Variant['sell']): Variant => ({ id, label, buy, sell });

const ltTrigger = (ind: Indicators, i: number, bars: Bar[]): boolean =>
  has(ind.hh55Prev[i]) && has(ind.ma100[i]) && bars[i].close > ind.hh55Prev[i] && bars[i].close > ind.ma100[i];

const obvTrigger = (ind: Indicators, i: number, bars: Bar[]): boolean =>
  has(ind.ma50[i]) && has(ind.obvMax20Prev[i]) && bars[i].close > ind.ma50[i] && ind.obv[i] > ind.obvMax20Prev[i];

const obvAccumulating = (ind: Indicators, i: number): boolean =>
  has(ind.obvAvg20[i]) && ind.obv[i] > ind.obvAvg20[i] && has(ind.obvSlope20[i]) && ind.obvSlope20[i] > 0;

const ltExit20 = (ind: Indicators, i: number, bars: Bar[]): boolean =>
  has(ind.ll20Prev[i]) && bars[i].close < ind.ll20Prev[i];

const ltExit10 = (ind: Indicators, i: number, bars: Bar[]): boolean =>
  has(ind.ll10Prev[i]) && bars[i].close < ind.ll10Prev[i];

const obvExit = (ind: Indicators, i: number, bars: Bar[]): boolean =>
  has(ind.ma50[i]) && has(ind.obvAvg20[i]) && bars[i].close < ind.ma50[i] && ind.obv[i] < ind.obvAvg20[i];

const VARIANTS: Variant[] = [
  V('lt_base', 'LT breakout (基准)', ltTrigger, ltExit20),
  V('obv_base', 'OBV accumulation (基准)', obvTrigger, obvExit),
  V(
    'lt_obv_and',
    'LT breakout + OBV 20日新高',
    (ind, i, bars) => ltTrigger(ind, i, bars) && obvTrigger(ind, i, bars),
    ltExit20,
  ),
  V(
    'lt_obv_confirm',
    'LT breakout + OBV 均线/斜率确认',
    (ind, i, bars) => ltTrigger(ind, i, bars) && obvAccumulating(ind, i),
    ltExit20,
  ),
  V(
    'lt_obv_confirm_tight',
    'LT + OBV 确认 + 10日低点止损',
    (ind, i, bars) => ltTrigger(ind, i, bars) && obvAccumulating(ind, i),
    ltExit10,
  ),
  V(
    'obv_early_trend',
    'OBV 先行 + 100日趋势 + 逼近55日高',
    (ind, i, bars) =>
      obvTrigger(ind, i, bars) &&
      has(ind.ma100[i]) &&
      bars[i].close > ind.ma100[i] &&
      has(ind.hh55Prev[i]) &&
      bars[i].close >= ind.hh55Prev[i] * 0.97,
    ltExit20,
  ),
  V(
    'lt_obv_dual_exit',
    'LT + OBV确认 + 双条件离场',
    (ind, i, bars) => ltTrigger(ind, i, bars) && obvAccumulating(ind, i),
    (ind, i, bars, entry) => ltExit10(ind, i, bars) || (obvExit(ind, i, bars) && i - entry.index > 5),
  ),
  V(
    'hybrid_or',
    'LT 或 (OBV + 100日趋势)',
    (ind, i, bars) =>
      ltTrigger(ind, i, bars) ||
      (obvTrigger(ind, i, bars) && has(ind.ma100[i]) && bars[i].close > ind.ma100[i]),
    ltExit20,
  ),
  V(
    'lt_volume_obv',
    'LT breakout + 放量 + OBV确认',
    (ind, i, bars) =>
      ltTrigger(ind, i, bars) && obvAccumulating(ind, i) && has(ind.volRatio[i]) && ind.volRatio[i] >= 1.2,
    ltExit20,
  ),
  V(
    'lt_obv_rising_ma',
    'LT + OBV确认 + 100日MA上行',
    (ind, i, bars) =>
      ltTrigger(ind, i, bars) &&
      obvAccumulating(ind, i) &&
      has(ind.s100[i]) &&
      ind.s100[i] > 0,
    ltExit20,
  ),
  // --- 放宽离场以延长持仓/提高暴露 (趋势跟随) ---
  V(
    'lt_ma50_exit',
    'LT breakout + 50日MA离场',
    ltTrigger,
    (ind, i, bars) => has(ind.ma50[i]) && bars[i].close < ind.ma50[i],
  ),
  V(
    'lt_ma100_exit',
    'LT breakout + 100日MA离场',
    ltTrigger,
    (ind, i, bars) => has(ind.ma100[i]) && bars[i].close < ind.ma100[i],
  ),
  V(
    'obv_ma50_exit',
    'OBV + 50日MA离场',
    obvTrigger,
    (ind, i, bars) => has(ind.ma50[i]) && bars[i].close < ind.ma50[i],
  ),
  V(
    'obv_ma100_exit',
    'OBV + 100日MA离场',
    obvTrigger,
    (ind, i, bars) => has(ind.ma100[i]) && bars[i].close < ind.ma100[i],
  ),
  V(
    'trend_rider',
    '趋势延续: LT 或 OBV + MA50>MA100',
    (ind, i, bars) =>
      (ltTrigger(ind, i, bars) || (obvTrigger(ind, i, bars) && has(ind.ma100[i]) && bars[i].close > ind.ma100[i])) &&
      has(ind.ma50[i]) &&
      has(ind.ma100[i]) &&
      ind.ma50[i] > ind.ma100[i],
    (ind, i, bars) => has(ind.ma50[i]) && bars[i].close < ind.ma50[i],
  ),
  V(
    'ma100_hold',
    '纯趋势: 收盘>MA100 持有',
    (ind, i, bars) => has(ind.ma100[i]) && bars[i].close > ind.ma100[i],
    (ind, i, bars) => has(ind.ma100[i]) && bars[i].close < ind.ma100[i],
  ),
  V(
    'ma50_ma100',
    '纯趋势: MA50>MA100 且 收盘>MA50',
    (ind, i, bars) => has(ind.ma50[i]) && has(ind.ma100[i]) && ind.ma50[i] > ind.ma100[i] && bars[i].close > ind.ma50[i],
    (ind, i, bars) => has(ind.ma50[i]) && bars[i].close < ind.ma50[i],
  ),
  // --- OBV + 长期趋势过滤 / 不追高 ---
  V(
    'obv_trend',
    'OBV + 收盘>MA100',
    (ind, i, bars) => obvTrigger(ind, i, bars) && has(ind.ma100[i]) && bars[i].close > ind.ma100[i],
    obvExit,
  ),
  V(
    'obv_trend_ma50',
    'OBV + MA100>MA50 多头排列',
    (ind, i, bars) =>
      obvTrigger(ind, i, bars) && has(ind.ma100[i]) && has(ind.ma50[i]) && bars[i].close > ind.ma100[i] && ind.ma50[i] > ind.ma100[i],
    obvExit,
  ),
  V(
    'obv_no_chase',
    'OBV + 不过度偏离MA20 (<=6%)',
    (ind, i, bars) => obvTrigger(ind, i, bars) && has(ind.ext20[i]) && ind.ext20[i] <= 0.06,
    obvExit,
  ),
  V(
    'obv_trend_no_chase',
    'OBV + 收盘>MA100 + 不追高',
    (ind, i, bars) =>
      obvTrigger(ind, i, bars) && has(ind.ma100[i]) && bars[i].close > ind.ma100[i] && has(ind.ext20[i]) && ind.ext20[i] <= 0.06,
    obvExit,
  ),
  V(
    'lt_no_chase',
    'LT + 不追高 (<=6%偏离MA20)',
    (ind, i, bars) => ltTrigger(ind, i, bars) && has(ind.ext20[i]) && ind.ext20[i] <= 0.06,
    ltExit20,
  ),
  V(
    'lt_obv_no_chase',
    'LT + OBV确认 + 不追高',
    (ind, i, bars) =>
      ltTrigger(ind, i, bars) && obvAccumulating(ind, i) && has(ind.ext20[i]) && ind.ext20[i] <= 0.06,
    ltExit20,
  ),
];

// ---------------------------------------------------------------------------
// IC 面板
// ---------------------------------------------------------------------------

interface FactorPanelRow {
  symbol: string;
  i: number;
  close: number;
  lt: number;
  obv: number;
  combo: number;
  eligibleFinal: boolean;
  trigLT: boolean;
  trigOBV: boolean;
  trigFinal: boolean;
}

function buildPanel(stocks: Stock[]): Map<string, Ref[]> {
  const byDate = new Map<string, Ref[]>();
  for (const s of stocks) {
    const inds = (s as unknown as { __ind?: Indicators }).__ind;
    if (!inds) continue;
    for (let i = WARMUP; i < s.bars.length; i++) {
      if (!has(inds.b55[i]) && !has(inds.obvBreak[i])) continue;
      const d = s.bars[i].date;
      const arr = byDate.get(d);
      if (arr) arr.push({ stock: s, i, close: s.bars[i].close });
      else byDate.set(d, [{ stock: s, i, close: s.bars[i].close }]);
    }
  }
  return byDate;
}

function getInd(s: Stock): Indicators {
  return (s as unknown as { __ind: Indicators }).__ind;
}

function forwardReturn(s: Stock, i: number, h: number): number | null {
  const j = i + h;
  if (j >= s.bars.length) return null;
  return s.bars[j].close / s.bars[i].close - 1;
}

interface IcResult {
  factor: string;
  horizon: number;
  mean: number;
  ir: number;
  irAnnual: number;
  t: number;
  n: number;
  posRate: number;
}

function runIc(byDate: Map<string, Ref[]>): {
  ics: IcResult[];
  corrLtObv: number;
  event: Record<string, { meanExcess: number; hitRate: number; events: number; ir: number }>;
} {
  const series = new Map<string, number[]>();
  const push = (k: string, v: number | null) => {
    if (v === null || !Number.isFinite(v)) return;
    const arr = series.get(k);
    if (arr) arr.push(v);
    else series.set(k, [v]);
  };

  const corrSeries: number[] = [];
  const eventDaily = new Map<string, number[]>();
  const eventHits = new Map<string, number[]>();
  const eventCount = new Map<string, number[]>();

  for (const [date, refs] of byDate) {
    if (date < SIM_START) continue;
    const valid = refs.filter((r) => {
      const ind = getInd(r.stock);
      return has(ind.b55[r.i]) && has(ind.t100[r.i]) && has(ind.s100[r.i]) && has(ind.obvBreak[r.i]) && has(ind.obvSlopeNorm[r.i]) && has(ind.t50[r.i]);
    });
    if (valid.length < 30) continue;

    const b55 = valid.map((r) => getInd(r.stock).b55[r.i]);
    const t100 = valid.map((r) => getInd(r.stock).t100[r.i]);
    const s100 = valid.map((r) => getInd(r.stock).s100[r.i]);
    const t50 = valid.map((r) => getInd(r.stock).t50[r.i]);
    const ob = valid.map((r) => getInd(r.stock).obvBreak[r.i]);
    const os = valid.map((r) => getInd(r.stock).obvSlopeNorm[r.i]);
    const ext = valid.map((r) => getInd(r.stock).ext20[r.i]);
    const dsb = valid.map((r) => getInd(r.stock).daysSinceBreak[r.i]);
    const dso = valid.map((r) => getInd(r.stock).daysSinceObvHigh[r.i]);

    const rb = percentileRanks(b55);
    const rt = percentileRanks(t100);
    const rs = percentileRanks(s100);
    const r50 = percentileRanks(t50);
    const ro = percentileRanks(ob);
    const rosl = percentileRanks(os);
    const rext = percentileRanks(ext);
    const rdsb = percentileRanks(dsb);
    const rdso = percentileRanks(dso);

    const lt = valid.map((_, k) => (rb[k] + rt[k] + rs[k]) / 3);
    const obv = valid.map((_, k) => (ro[k] + rosl[k] + r50[k]) / 3);
    const combo = valid.map((_, k) => (lt[k] + obv[k]) / 2);
    // 质量动量: 趋势强度 + 不过度偏离 MA20
    const quality = valid.map((_, k) => (rt[k] + rs[k] + (1 - rext[k])) / 3);
    // 趋势 + 短期反转 (买回调而非追高)
    // 新鲜度: 突破/OBV 新高越新、越不追高，得分越高
    const fresh = valid.map((_, k) => ((1 - rdsb[k]) + (1 - rdso[k]) + (1 - rext[k])) / 3);
    const finalRank = valid.map(
      (_, k) => (rb[k] + rt[k] + rs[k] + ro[k] + rosl[k] + (1 - rext[k]) + (1 - rdsb[k])) / 7,
    );

    for (const h of HORIZONS) {
      const pairs = new Map<string, { x: number[]; y: number[] }>();
      const add = (name: string, x: number, y: number) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        const p = pairs.get(name);
        if (p) {
          p.x.push(x);
          p.y.push(y);
        } else pairs.set(name, { x: [x], y: [y] });
      };

      const rets: number[] = [];
      const triggers: { lt: number[]; obv: number[]; final: number[] } = { lt: [], obv: [], final: [] };
      const triggerRets: number[] = [];

      for (let k = 0; k < valid.length; k++) {
        const r = valid[k];
        const fr = forwardReturn(r.stock, r.i, h);
        if (fr === null || !Number.isFinite(fr)) continue;
        const ind = getInd(r.stock);
        const close = r.close;
        const ltOk = ltTrigger(ind, r.i, r.stock.bars);
        const obvOk = obvTrigger(ind, r.i, r.stock.bars);
        const eligible =
          has(ind.ma100[r.i]) &&
          has(ind.ma50[r.i]) &&
          close > ind.ma100[r.i] &&
          close > ind.ma50[r.i] &&
          obvAccumulating(ind, r.i);
        const finalOk = ltOk && eligible;

        rets.push(fr);
        triggerRets.push(fr);

        add('lt', lt[k], fr);
        add('obv', obv[k], fr);
        add('combo', combo[k], fr);
        if (eligible) add('combo_eligible', combo[k], fr);
        add('quality', quality[k], fr);
        add('fresh', fresh[k], fr);
        add('final_rank', finalRank[k], fr);
        add('trig_lt', ltOk ? 1 : 0, fr);
        add('trig_obv', obvOk ? 1 : 0, fr);
        add('trig_final', finalOk ? 1 : 0, fr);
        // 原始因子 (用于判断方向): 动量 / 反转 / 过度偏离 / 低波 / 接近 52 周高
        add('mom20', ind.ret20[r.i], fr);
        add('mom60', ind.ret60[r.i], fr);
        add('mom120', ind.ret120[r.i], fr);
        add('ext20', ind.ext20[r.i], fr);
        add('lowvol20', -ind.vol20[r.i], fr);
        add('near52w', ind.dist52w[r.i], fr);

        triggers.lt.push(ltOk ? 1 : 0);
        triggers.obv.push(obvOk ? 1 : 0);
        triggers.final.push(finalOk ? 1 : 0);
      }
      if (rets.length < 30) continue;

      for (const [name, p] of pairs) push(`${name}@${h}`, spearman(p.x, p.y));

      // 事件研究: 触发的股票未来收益 − 当日全样本平均
      const base = mean(rets);
      for (const [name, sig] of Object.entries(triggers)) {
        const idxs = sig.map((x, k) => (x > 0 ? k : -1)).filter((k) => k >= 0);
        if (!idxs.length) continue;
        const key = `${name}@${h}`;
        const arr = eventDaily.get(key) ?? [];
        arr.push(mean(idxs.map((k) => triggerRets[k])) - base);
        eventDaily.set(key, arr);
        eventHits.set(key, [...(eventHits.get(key) ?? []), idxs.length]);
        eventCount.set(key, [...(eventCount.get(key) ?? []), valid.length]);
      }
    }

    // LT 与 OBV 横截面相关
    const c = spearman(lt, obv);
    if (c !== null) corrSeries.push(c);
  }

  const ics: IcResult[] = [];
  for (const [key, vals] of series) {
    const [factor, hStr] = key.split('@');
    const h = Number(hStr);
    const st = icStat(vals, h);
    ics.push({
      factor,
      horizon: h,
      mean: st.mean,
      ir: st.ir,
      irAnnual: st.irAnnual,
      t: st.t,
      n: st.n,
      posRate: st.posRate,
    });
  }

  const event: Record<string, { meanExcess: number; hitRate: number; events: number; ir: number }> = {};
  for (const [key, vals] of eventDaily) {
    const hits = eventHits.get(key) ?? [];
    const counts = eventCount.get(key) ?? [];
    event[key] = {
      meanExcess: mean(vals) * 100,
      hitRate: hits.length ? mean(hits.map((h, k) => (counts[k] ? h / counts[k] : 0))) * 100 : 0,
      events: hits.reduce((s, h) => s + h, 0),
      ir: std(vals) > 0 ? mean(vals) / std(vals) : 0,
    };
  }

  return { ics, corrLtObv: mean(corrSeries), event };
}

// ---------------------------------------------------------------------------
// 横截面打分: 资格过滤 + 打分因子
// ---------------------------------------------------------------------------

type Eligibility = (ind: Indicators, i: number, bars: Bar[]) => boolean;
type ScorePart = (ind: Indicators, i: number, bars: Bar[]) => number;

const ELIGIBILITY: { id: string; label: string; fn: Eligibility }[] = [
  {
    id: 'obv_uptrend',
    label: 'OBV累积 + 收盘>MA100>MA50',
    fn: (ind, i, bars) =>
      has(ind.ma100[i]) &&
      has(ind.ma50[i]) &&
      bars[i].close > ind.ma100[i] &&
      bars[i].close > ind.ma50[i] &&
      obvAccumulating(ind, i),
  },
  {
    id: 'lt_breakout',
    label: '55日突破 + 收盘>MA100',
    fn: (ind, i, bars) => ltTrigger(ind, i, bars),
  },
  {
    id: 'either',
    label: 'LT突破 或 OBV累积',
    fn: (ind, i, bars) => ltTrigger(ind, i, bars) || (obvTrigger(ind, i, bars) && has(ind.ma100[i]) && bars[i].close > ind.ma100[i]),
  },
  {
    id: 'obv_state',
    label: 'OBV累积状态 (非触发日也可入场)',
    fn: (ind, i, bars) =>
      has(ind.ma100[i]) &&
      has(ind.ma50[i]) &&
      bars[i].close > ind.ma100[i] &&
      bars[i].close > ind.ma50[i] &&
      obvAccumulating(ind, i),
  },
  {
    id: 'obv_trigger',
    label: 'OBV 20日新高 + 收盘>MA50 (原版OBV入场)',
    fn: (ind, i, bars) => obvTrigger(ind, i, bars),
  },
  {
    id: 'obv_trigger_ma100',
    label: 'OBV 20日新高 + 收盘>MA50>MA100 (原版+长期过滤)',
    fn: (ind, i, bars) =>
      obvTrigger(ind, i, bars) && has(ind.ma100[i]) && bars[i].close > ind.ma100[i],
  },
];

const SCORES: { id: string; label: string; parts: ScorePart[] }[] = [
  { id: 'lowvol', label: '低波动', parts: [(ind, i) => -ind.vol20[i]] },
  { id: 'obv_only', label: 'OBV 20日斜率 (轮动评分)', parts: [(ind, i) => ind.obvSlopeNorm[i]] },
  { id: 'lowvol_ext', label: '低波动 + 不追高', parts: [(ind, i) => -ind.vol20[i], (ind, i) => -ind.ext20[i]] },
  {
    id: 'lv_obv',
    label: '低波动 + 不追高 + OBV斜率',
    parts: [(ind, i) => -ind.vol20[i], (ind, i) => -ind.ext20[i], (ind, i) => ind.obvSlopeNorm[i]],
  },
  {
    id: 'lv_obv_near',
    label: '低波动 + 不追高 + OBV斜率 + 近52周高',
    parts: [(ind, i) => -ind.vol20[i], (ind, i) => -ind.ext20[i], (ind, i) => ind.obvSlopeNorm[i], (ind, i) => ind.dist52w[i]],
  },
  {
    id: 'lv_obv_fresh',
    label: '低波动 + 不追高 + OBV斜率 + 突破新鲜度',
    parts: [
      (ind, i) => -ind.vol20[i],
      (ind, i) => -ind.ext20[i],
      (ind, i) => ind.obvSlopeNorm[i],
      (ind, i) => ind.dist52w[i],
      (ind, i) => -ind.daysSinceBreak[i],
    ],
  },
  { id: 'trend_lv', label: '趋势强度 + 低波动 + 不追高 + OBV', parts: [
      (ind, i) => ind.t100[i],
      (ind, i) => ind.s100[i],
      (ind, i) => -ind.vol20[i],
      (ind, i) => -ind.ext20[i],
      (ind, i) => ind.obvSlopeNorm[i],
    ],
  },
  { id: 'proxy', label: '执行器 confidence 代理 (低波动 + 不追高)', parts: [
      (ind, i) => -ind.vol20[i] / 0.03 - ind.ext20[i] / 0.1,
    ],
  },
];

/** 对 eligible 集合计算复合分: 每个分量横截面百分位排名后取均值 */
function compositeScores(
  refs: Ref[],
  score: { parts: ScorePart[] },
): { ref: Ref; score: number }[] {
  const cols: number[][] = score.parts.map((part) =>
    refs.map((r) => {
      const v = part(getInd(r.stock), r.i, r.stock.bars);
      return Number.isFinite(v) ? v : NaN;
    }),
  );
  // 只保留所有分量都有效的样本
  const keep: number[] = [];
  for (let k = 0; k < refs.length; k++) {
    if (cols.every((c) => Number.isFinite(c[k]))) keep.push(k);
  }
  if (keep.length < 10) return [];
  const ranks = cols.map((c) => {
    const sub = keep.map((k) => c[k]);
    const r = percentileRanks(sub);
    return r;
  });
  return keep.map((k, pos) => ({
    ref: refs[k],
    score: mean(ranks.map((r) => r[pos])),
  }));
}

function runConditionalIc(byDate: Map<string, Ref[]>): IcResult[] {
  const series = new Map<string, number[]>();
  for (const [date, refs] of byDate) {
    if (date < SIM_START) continue;
    for (const elig of ELIGIBILITY) {
      const pool = refs.filter((r) => {
        if (!elig.fn(getInd(r.stock), r.i, r.stock.bars)) return false;
        const ind = getInd(r.stock);
        return has(ind.vol20[r.i]) && has(ind.ext20[r.i]) && has(ind.obvSlopeNorm[r.i]) && has(ind.dist52w[r.i]) && has(ind.daysSinceBreak[r.i]);
      });
      if (pool.length < 10) continue;

      for (const score of SCORES) {
        const scored = compositeScores(pool, score);
        if (scored.length < 10) continue;
        for (const h of HORIZONS) {
          const xs: number[] = [];
          const ys: number[] = [];
          for (const s of scored) {
            const fr = forwardReturn(s.ref.stock, s.ref.i, h);
            if (fr === null) continue;
            xs.push(s.score);
            ys.push(fr);
          }
          if (xs.length < 10) continue;
          const ic = spearman(xs, ys);
          if (ic === null) continue;
          const key = `${elig.id}|${score.id}@${h}`;
          const arr = series.get(key);
          if (arr) arr.push(ic);
          else series.set(key, [ic]);
        }
      }
    }
  }

  const out: IcResult[] = [];
  for (const [key, vals] of series) {
    const [factor, hStr] = key.split('@');
    const h = Number(hStr);
    const st = icStat(vals, h);
    out.push({ factor, horizon: h, mean: st.mean, ir: st.ir, irAnnual: st.irAnnual, t: st.t, n: st.n, posRate: st.posRate });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 横截面 top-K 组合
// ---------------------------------------------------------------------------

interface CsPortfolioStat {
  id: string;
  totalReturn: number;
  annualReturn: number;
  maxDrawdown: number;
  sharpe: number;
  avgInvested: number;
  avgHoldings: number;
  trades: number;
  turnovers: number;
  dates: string[];
  curve: number[];
}

function simulateCrossSectional(
  byDateDates: string[],
  byDate: Map<string, Ref[]>,
  elig: Eligibility,
  score: { parts: ScorePart[] },
  topK: number,
  bufferMult: number,
  rebalanceDays: number,
  startDate: string,
  endDate: string,
): CsPortfolioStat {
  const allDates = byDateDates.filter((d) => d >= startDate && d <= endDate);
  let cash = INITIAL_CASH;
  const holdings = new Map<string, { shares: number; cost: number }>();
  const curve: number[] = [];
  const equityDates: string[] = [];
  let investedSum = 0;
  let holdingsSum = 0;
  let trades = 0;
  let turnovers = 0;

  let slot = 0;
  const lastClose = new Map<string, number>();
  for (const date of allDates) {
    const refs = byDate.get(date) ?? [];
    const closeMap = new Map<string, number>();
    const prevCloseMap = new Map<string, number>();
    for (const r of refs) {
      closeMap.set(r.stock.symbol, r.close);
      lastClose.set(r.stock.symbol, r.close);
      const prev = r.i > 0 ? r.stock.bars[r.i - 1].close : null;
      if (prev !== null) prevCloseMap.set(r.stock.symbol, prev);
    }

    const doRebalance = slot % rebalanceDays === 0;
    if (doRebalance) {
      const pool = refs.filter((r) => {
        if (!elig(getInd(r.stock), r.i, r.stock.bars)) return false;
        const ind = getInd(r.stock);
        return has(ind.vol20[r.i]) && has(ind.ext20[r.i]) && has(ind.obvSlopeNorm[r.i]) && has(ind.dist52w[r.i]) && has(ind.daysSinceBreak[r.i]);
      });
      const scored = compositeScores(pool, score).sort((a, b) => b.score - a.score);
      const keepSet = new Set(scored.slice(0, topK * bufferMult).map((s) => s.ref.stock.symbol));
      const target = scored.slice(0, topK);

      // 卖出: 跌出缓冲区的持仓
      for (const [symbol, h] of [...holdings]) {
        if (keepSet.has(symbol)) continue;
        const px = closeMap.get(symbol);
        if (!px) continue;
        const prev = prevCloseMap.get(symbol);
        if (prev && px <= limitDown(prev, symbol)) continue; // 跌停卖不出
        const value = h.shares * px;
        cash += value - fees(value, false);
        holdings.delete(symbol);
        trades++;
        turnovers++;
      }

      // 买入: 目标集合中未持有的, 等权分配可用现金
      const equity = cash + [...holdings].reduce((s, [sym, h]) => s + h.shares * (lastClose.get(sym) ?? 0), 0);
      const targetValue = equity / topK;
      for (const t of target) {
        const symbol = t.ref.stock.symbol;
        if (holdings.has(symbol)) continue;
        const px = closeMap.get(symbol);
        if (!px) continue;
        const prev = prevCloseMap.get(symbol);
        if (prev && px >= limitUp(prev, symbol)) continue; // 涨停买不进
        // 每只最多买到 equity/topK
        const budget = Math.min(targetValue, cash);
        let sh = Math.floor(budget / px / 100) * 100;
        while (sh >= 100 && sh * px + fees(sh * px, true) > cash) sh -= 100;
        if (sh <= 0) continue;
        const cost = sh * px;
        cash -= cost + fees(cost, true);
        holdings.set(symbol, { shares: sh, cost: cost + fees(cost, true) });
        trades++;
        turnovers++;
      }
    }

    const equity = cash + [...holdings].reduce((s, [sym, h]) => s + h.shares * (lastClose.get(sym) ?? 0), 0);
    curve.push(equity / INITIAL_CASH);
    equityDates.push(date);
    // 记录平均仓位: 用当日持仓市值占比
    const invested = equity > 0 ? 1 - cash / equity : 0;
    investedSum += invested;
    holdingsSum += holdings.size;
    slot++;
  }

  const total = curve[curve.length - 1] - 1;
  const years = equityDates.length / 252;
  return {
    id: '',
    totalReturn: total * 100,
    annualReturn: years > 0 && total > -1 ? ((1 + total) ** (1 / years) - 1) * 100 : 0,
    maxDrawdown: maxDrawdown(curve),
    sharpe: sharpe(curve),
    avgInvested: equityDates.length ? (investedSum / equityDates.length) * 100 : 0,
    avgHoldings: equityDates.length ? holdingsSum / equityDates.length : 0,
    trades,
    turnovers,
    dates: equityDates,
    curve,
  };
}

// ---------------------------------------------------------------------------
// 与项目 backtrader 执行器一致的组合模拟 (maxPositions + confidence 排序)
// ---------------------------------------------------------------------------

function simulateExecutorLike(
  byDateDates: string[],
  byDate: Map<string, Ref[]>,
  elig: Eligibility,
  exit: (ind: Indicators, i: number, bars: Bar[]) => boolean,
  confidence: (ind: Indicators, i: number) => number,
  maxPositions: number,
  startDate: string,
  endDate: string,
  fillAtNextOpen = false,
): CsPortfolioStat {
  const allDates = byDateDates.filter((d) => d >= startDate && d <= endDate);
  const lastClose = new Map<string, number>();
  const holdings = new Map<string, { shares: number; cost: number }>();
  let cash = INITIAL_CASH;
  const curve: number[] = [];
  const equityDates: string[] = [];
  let investedSum = 0;
  let holdingsSum = 0;
  let trades = 0;

  interface PendingBuy { symbol: string; conf: number }
  const pendingSells: string[] = [];
  const pendingBuys: PendingBuy[] = [];

  for (const date of allDates) {
    const refs = byDate.get(date) ?? [];
    const closeMap = new Map<string, number>();
    const prevCloseMap = new Map<string, number>();
    const openMap = new Map<string, number>();
    const bySymbol = new Map<string, Ref>();
    for (const r of refs) {
      closeMap.set(r.stock.symbol, r.close);
      lastClose.set(r.stock.symbol, r.close);
      openMap.set(r.stock.symbol, r.stock.bars[r.i].open);
      bySymbol.set(r.stock.symbol, r);
      if (r.i > 0) prevCloseMap.set(r.stock.symbol, r.stock.bars[r.i - 1].close);
    }

    const execPrice = (symbol: string): number | null => {
      const px = fillAtNextOpen ? openMap.get(symbol) : closeMap.get(symbol);
      return px && Number.isFinite(px) ? px : null;
    };

    // 0) 先撮合上一交易日收盘产生、今日开盘执行的订单
    if (fillAtNextOpen) {
      for (const symbol of pendingSells.splice(0)) {
        const h = holdings.get(symbol);
        const px = execPrice(symbol);
        if (!h || !px) continue;
        const prev = prevCloseMap.get(symbol);
        if (prev && px <= limitDown(prev, symbol)) continue;
        const value = h.shares * px;
        cash += value - fees(value, false);
        holdings.delete(symbol);
        trades++;
      }
      const equity0 = cash + [...holdings].reduce((s, [sym, h]) => s + h.shares * (lastClose.get(sym) ?? 0), 0);
      const budget0 = equity0 / maxPositions;
      for (const o of pendingBuys.splice(0)) {
        if (holdings.size >= maxPositions) continue;
        if (holdings.has(o.symbol)) continue;
        const px = execPrice(o.symbol);
        if (!px) continue;
        const prev = prevCloseMap.get(o.symbol);
        if (prev && px >= limitUp(prev, o.symbol)) continue;
        let sh = Math.floor(Math.min(budget0, cash) / px / 100) * 100;
        while (sh >= 100 && sh * px + fees(sh * px, true) > cash) sh -= 100;
        if (sh < 100) continue;
        const cost = sh * px;
        cash -= cost + fees(cost, true);
        holdings.set(o.symbol, { shares: sh, cost: cost + fees(cost, true) });
        trades++;
      }
    }

    // 1) 卖出信号
    for (const [symbol, h] of [...holdings]) {
      const r = bySymbol.get(symbol);
      const px = closeMap.get(symbol);
      if (!r || !px) continue;
      if (!exit(getInd(r.stock), r.i, r.stock.bars)) continue;
      if (fillAtNextOpen) {
        pendingSells.push(symbol);
        continue;
      }
      const prev = prevCloseMap.get(symbol);
      if (prev && px <= limitDown(prev, symbol)) continue;
      const value = h.shares * px;
      cash += value - fees(value, false);
      holdings.delete(symbol);
      trades++;
    }

    // 2) 买入信号 (按 confidence 降序填满空位)
    if (holdings.size < maxPositions) {
      const candidates = refs
        .filter((r) => {
          const sym = r.stock.symbol;
          if (holdings.has(sym)) return false;
          if (!elig(getInd(r.stock), r.i, r.stock.bars)) return false;
          const ind = getInd(r.stock);
          return has(ind.vol20[r.i]) && has(ind.ext20[r.i]);
        })
        .map((r) => ({ symbol: r.stock.symbol, conf: confidence(getInd(r.stock), r.i) }))
        .filter((c) => Number.isFinite(c.conf))
        .sort((a, b) => b.conf - a.conf);

      if (fillAtNextOpen) {
        for (const c of candidates) {
          if (holdings.size + pendingBuys.length >= maxPositions) break;
          if (pendingSells.includes(c.symbol)) continue;
          pendingBuys.push(c);
        }
      } else {
        const equity = cash + [...holdings].reduce((s, [sym, h]) => s + h.shares * (lastClose.get(sym) ?? 0), 0);
        const budgetPer = equity / maxPositions;
        let used = holdings.size;
        for (const c of candidates) {
          if (used >= maxPositions) break;
          const px = closeMap.get(c.symbol);
          if (!px) continue;
          const prev = prevCloseMap.get(c.symbol);
          if (prev && px >= limitUp(prev, c.symbol)) continue;
          let sh = Math.floor(Math.min(budgetPer, cash) / px / 100) * 100;
          while (sh >= 100 && sh * px + fees(sh * px, true) > cash) sh -= 100;
          if (sh < 100) continue;
          const cost = sh * px;
          cash -= cost + fees(cost, true);
          holdings.set(c.symbol, { shares: sh, cost: cost + fees(cost, true) });
          trades++;
          used++;
        }
      }
    }

    const equity = cash + [...holdings].reduce((s, [sym, h]) => s + h.shares * (lastClose.get(sym) ?? 0), 0);
    curve.push(equity / INITIAL_CASH);
    equityDates.push(date);
    investedSum += equity > 0 ? 1 - cash / equity : 0;
    holdingsSum += holdings.size;
  }

  const total = curve[curve.length - 1] - 1;
  const years = equityDates.length / 252;
  return {
    id: '',
    totalReturn: total * 100,
    annualReturn: years > 0 && total > -1 ? ((1 + total) ** (1 / years) - 1) * 100 : 0,
    maxDrawdown: maxDrawdown(curve),
    sharpe: sharpe(curve),
    avgInvested: equityDates.length ? (investedSum / equityDates.length) * 100 : 0,
    avgHoldings: equityDates.length ? holdingsSum / equityDates.length : 0,
    trades,
    turnovers: trades,
    dates: equityDates,
    curve,
  };
}



function pct(v: number, digits = 2): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

// ---------------------------------------------------------------------------
// 触发事件 × 长期趋势位置 (验证长期过滤是否真的增强 OBV)
// ---------------------------------------------------------------------------

interface SplitRow {
  event: string;
  side: string;
  horizon: number;
  excess: number;
  hitRate: number;
  avgEventsPerDay: number;
}

function runTriggerSplit(byDate: Map<string, Ref[]>): SplitRow[] {
  const exBuckets = new Map<string, number[]>();
  const hitBuckets = new Map<string, number[]>();
  const countBuckets = new Map<string, number[]>();

  for (const [date, refs] of byDate) {
    if (date < SIM_START) continue;
    const valid = refs.filter((r) => {
      const ind = getInd(r.stock);
      return has(ind.b55[r.i]) && has(ind.t100[r.i]) && has(ind.obvBreak[r.i]) && has(ind.ma100[r.i]);
    });
    if (valid.length < 30) continue;

    for (const h of [20, 60]) {
      const rows: { fr: number; obv: boolean; lt: boolean; above: boolean }[] = [];
      const rets: number[] = [];
      for (const r of valid) {
        const fr = forwardReturn(r.stock, r.i, h);
        if (fr === null) continue;
        const ind = getInd(r.stock);
        rets.push(fr);
        rows.push({
          fr,
          obv: obvTrigger(ind, r.i, r.stock.bars),
          lt: ltTrigger(ind, r.i, r.stock.bars),
          above: r.close > ind.ma100[r.i],
        });
      }
      if (rets.length < 30) continue;
      const base = mean(rets);

      for (const ev of ['obv_trigger', 'lt_breakout'] as const) {
        const isHit = (x: { obv: boolean; lt: boolean }) => (ev === 'obv_trigger' ? x.obv : x.lt);
        for (const side of ['above_ma100', 'below_ma100'] as const) {
          const wantAbove = side === 'above_ma100';
          const hits = rows.filter((x) => isHit(x) && x.above === wantAbove);
          if (!hits.length) continue;
          const key = `${ev}|${side}|${h}`;
          const vals = hits.map((x) => x.fr);
          const ex = exBuckets.get(key) ?? [];
          ex.push(mean(vals) - base);
          exBuckets.set(key, ex);
          const hit = hitBuckets.get(key) ?? [];
          hit.push((vals.filter((v) => v > 0).length / vals.length) * 100);
          hitBuckets.set(key, hit);
          const cnt = countBuckets.get(key) ?? [];
          cnt.push(hits.length);
          countBuckets.set(key, cnt);
        }
      }
    }
  }

  const out: SplitRow[] = [];
  for (const ev of ['obv_trigger', 'lt_breakout']) {
    for (const side of ['above_ma100', 'below_ma100']) {
      for (const h of [20, 60]) {
        const ex = exBuckets.get(`${ev}|${side}|${h}`);
        const hit = hitBuckets.get(`${ev}|${side}|${h}`);
        const cnt = countBuckets.get(`${ev}|${side}|${h}`);
        if (!ex || !hit || !cnt) continue;
        out.push({
          event: ev,
          side,
          horizon: h,
          excess: mean(ex),
          hitRate: mean(hit),
          avgEventsPerDay: mean(cnt),
        });
      }
    }
  }
  return out;
}

function main() {
  console.log('加载本地 K 线与成分股 ...');
  const stocks = loadUniverse();
  console.log(`股票数 ${stocks.length} (hs300 ${stocks.filter((s) => s.index === 'hs300').length}, zz500 ${stocks.filter((s) => s.index === 'zz500').length})`);

  for (const s of stocks) (s as unknown as { __ind: Indicators }).__ind = computeIndicators(s);

  const maxDate = stocks.reduce((m, s) => {
    const d = s.bars[s.bars.length - 1].date;
    return d > m ? d : m;
  }, '');
  console.log(`数据区间 ${DATA_START} ~ ${maxDate}`);

  // ---- IC / IR ----
  console.log('\n构建横截面面板并计算 IC ...');
  const byDate = buildPanel(stocks);
  const ic = runIc(byDate);

  console.log('\n===== 因子 IC / IR (横截面 Spearman) =====');
  console.log(
    ['factor'.padEnd(18), 'h'.padStart(3), 'IC'.padStart(8), 'IR'.padStart(8), 'IR年化'.padStart(8), 't'.padStart(7), '正IC率'.padStart(8), '样本'.padStart(6)].join(' '),
  );
  for (const r of ic.ics.filter((x) => x.horizon === 5 || x.horizon === 20 || x.horizon === 60).sort((a, b) => a.factor.localeCompare(b.factor) || a.horizon - b.horizon)) {
    console.log(
      [
        r.factor.padEnd(18),
        String(r.horizon).padStart(3),
        r.mean.toFixed(4).padStart(8),
        r.ir.toFixed(3).padStart(8),
        r.irAnnual.toFixed(2).padStart(8),
        r.t.toFixed(2).padStart(7),
        `${(r.posRate * 100).toFixed(0)}%`.padStart(8),
        String(r.n).padStart(6),
      ].join(' '),
    );
  }
  console.log(`\nLT 与 OBV 因子横截面平均相关: ${ic.corrLtObv.toFixed(3)}`);
  console.log('\n===== 信号事件研究 (相对当日全样本未来收益) =====');
  for (const [k, v] of Object.entries(ic.event).filter(([k]) => k.endsWith('@20'))) {
    console.log(`${k.padEnd(14)} 超额 ${pct(v.meanExcess)} | 命中率 ${v.hitRate.toFixed(1)}% | 事件数 ${v.events} | 日度IR ${v.ir.toFixed(3)}`);
  }

  // ---- 条件 IC (在合格池内排序) ----
  console.log('\n===== 合格池内条件 IC / IR (5日) =====');
  const cond = runConditionalIc(byDate);
  console.log(['eligibility|score'.padEnd(34), 'IC'.padStart(8), 'IR'.padStart(8), 'IR年化'.padStart(8), 't'.padStart(7), '正IC率'.padStart(8)].join(' '));
  for (const r of cond.filter((x) => x.horizon === 5).sort((a, b) => b.mean - a.mean)) {
    console.log(
      [
        r.factor.padEnd(34),
        r.mean.toFixed(4).padStart(8),
        r.ir.toFixed(3).padStart(8),
        r.irAnnual.toFixed(2).padStart(8),
        r.t.toFixed(2).padStart(7),
        `${(r.posRate * 100).toFixed(0)}%`.padStart(8),
      ].join(' '),
    );
  }
  console.log('\n===== 合格池内条件 IC / IR (20日) =====');
  for (const r of cond.filter((x) => x.horizon === 20).sort((a, b) => b.mean - a.mean).slice(0, 12)) {
    console.log(
      [
        r.factor.padEnd(34),
        r.mean.toFixed(4).padStart(8),
        r.ir.toFixed(3).padStart(8),
        r.irAnnual.toFixed(2).padStart(8),
        r.t.toFixed(2).padStart(7),
        `${(r.posRate * 100).toFixed(0)}%`.padStart(8),
      ].join(' '),
    );
  }

  // ---- 组合模拟 ----
  console.log('\n===== 组合模拟 (等权, 收盘成交, 含费用/涨跌停) =====');
  const results: PortfolioStat[] = [];
  for (const v of VARIANTS) {
    const sims = stocks.map((s) => simulate(s, getInd(s), v, SIM_START));
    results.push(summarize(v, sims, SIM_START, maxDate));
  }
  const bh = buyHoldBenchmark(stocks, SIM_START, maxDate);

  const fmt = (r: PortfolioStat) =>
    [
      r.id.padEnd(22),
      pct(r.totalReturn).padStart(9),
      pct(r.annualReturn).padStart(8),
      `${r.maxDrawdown.toFixed(1)}%`.padStart(8),
      r.sharpe.toFixed(2).padStart(7),
      `${r.exposure.toFixed(0)}%`.padStart(7),
      String(r.trades).padStart(6),
      `${r.winRate.toFixed(1)}%`.padStart(7),
      pct(r.avgTrade).padStart(8),
      r.payoff.toFixed(2).padStart(7),
      r.avgHolding.toFixed(0).padStart(5),
      `${r.profitConcentration.toFixed(0)}%`.padStart(7),
    ].join(' ');
  console.log(
    ['variant'.padEnd(22), 'ret'.padStart(9), 'annual'.padStart(8), 'maxDD'.padStart(8), 'sharpe'.padStart(7), 'expo'.padStart(7), 'trades'.padStart(6), 'win'.padStart(7), 'avgTrade'.padStart(8), 'payoff'.padStart(7), 'hold'.padStart(5), 'top10%'.padStart(7)].join(' '),
  );
  console.log(fmt(bh));
  for (const r of results) console.log(fmt(r));

  // IS / OOS 拆分
  const splits = [
    { label: 'IS 2023-06~2025-06', start: '2023-06-01', end: '2025-06-30' },
    { label: 'OOS 2025-07~2026-10', start: '2025-07-01', end: maxDate },
  ];
  console.log('\n===== 样本内 / 样本外 =====');
  for (const sp of splits) {
    console.log(`\n[${sp.label}]`);
    console.log(['variant'.padEnd(22), 'ret'.padStart(9), 'maxDD'.padStart(8), 'sharpe'.padStart(7), 'trades'.padStart(6), 'win'.padStart(7)].join(' '));
    for (const v of VARIANTS) {
      const sims = stocks.map((s) => simulate(s, getInd(s), v, sp.start));
      const st = summarize(v, sims, sp.start, sp.end);
      console.log([st.id.padEnd(22), pct(st.totalReturn).padStart(9), `${st.maxDrawdown.toFixed(1)}%`.padStart(8), st.sharpe.toFixed(2).padStart(7), String(st.trades).padStart(6), `${st.winRate.toFixed(1)}%`.padStart(7)].join(' '));
    }
    const b = buyHoldBenchmark(stocks, sp.start, sp.end);
    console.log(['BUYHOLD'.padEnd(22), pct(b.totalReturn).padStart(9), `${b.maxDrawdown.toFixed(1)}%`.padStart(8), b.sharpe.toFixed(2).padStart(7), '-'.padStart(6), '-'.padStart(7)].join(' '));
  }

  // ---- 触发 × 长期趋势位置 ----
  console.log('\n===== 触发事件 split by 100 日线位置 (20/60 日超额 vs 当日全池) =====');
  const split = runTriggerSplit(byDate);
  console.log(['event'.padEnd(14), 'side'.padEnd(12), 'h'.padStart(3), '超额'.padStart(9), '命中率'.padStart(8), '日均事件数'.padStart(10)].join(' '));
  for (const r of split) {
    console.log(
      [
        r.event.padEnd(14),
        r.side.padEnd(12),
        String(r.horizon).padStart(3),
        pct(r.excess).padStart(9),
        `${r.hitRate.toFixed(1)}%`.padStart(8),
        r.avgEventsPerDay.toFixed(1).padStart(10),
      ].join(' '),
    );
  }
  if (process.env.QUICK === '1') {
    fs.writeFileSync(
      path.join(BASE, 'reports', 'breakout-obv-split.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), split }, null, 2),
      'utf-8',
    );
    console.log('\n[QUICK 模式] 已跳过横截面与变体模拟');
    return;
  }

  // ---- 横截面 top-K 组合 ----
  console.log('\n===== 横截面 top-K 组合 (全期) =====');
  const allDates = [...byDate.keys()].sort();
  const grid: CsPortfolioStat[] = [];
  let idx = 0;
  for (const elig of ELIGIBILITY) {
    for (const score of SCORES) {
      for (const k of [10, 20]) {
        for (const reb of [5, 20]) {
          const st = simulateCrossSectional(allDates, byDate, elig.fn, score, k, 2, reb, SIM_START, maxDate);
          st.id = `${elig.id}|${score.id}|K${k}|R${reb}`;
          grid.push(st);
          idx++;
        }
      }
    }
  }
  console.log(['config'.padEnd(40), 'ret'.padStart(9), 'annual'.padStart(8), 'maxDD'.padStart(8), 'sharpe'.padStart(7), 'invested'.padStart(8), 'holdings'.padStart(8), 'trades'.padStart(7)].join(' '));
  for (const r of [...grid].sort((a, b) => b.annualReturn - a.annualReturn).slice(0, 20)) {
    console.log(
      [
        r.id.padEnd(40),
        pct(r.totalReturn).padStart(9),
        pct(r.annualReturn).padStart(8),
        `${r.maxDrawdown.toFixed(1)}%`.padStart(8),
        r.sharpe.toFixed(2).padStart(7),
        `${r.avgInvested.toFixed(0)}%`.padStart(8),
        r.avgHoldings.toFixed(1).padStart(8),
        String(r.trades).padStart(7),
      ].join(' '),
    );
  }

  // 按 Sharpe 的 top 配置做 IS/OOS
  const topBySharpe = [...grid].sort((a, b) => b.sharpe - a.sharpe).slice(0, 4);
  console.log('\n===== top-K 配置的样本内 / 样本外 =====');
  const csSplits = [
    { label: 'IS 2023-06~2025-06', start: '2023-06-01', end: '2025-06-30' },
    { label: 'OOS 2025-07~2026-10', start: '2025-07-01', end: maxDate },
  ];
  for (const sp of csSplits) {
    console.log(`\n[${sp.label}]`);
    console.log(['config'.padEnd(40), 'ret'.padStart(9), 'maxDD'.padStart(8), 'sharpe'.padStart(7), 'invested'.padStart(8)].join(' '));
    for (const base of topBySharpe) {
      const [eligId, scoreId, kStr, rStr] = base.id.split('|');
      const elig = ELIGIBILITY.find((e) => e.id === eligId)!;
      const score = SCORES.find((s) => s.id === scoreId)!;
      const st = simulateCrossSectional(
        allDates,
        byDate,
        elig.fn,
        score,
        Number(kStr.slice(1)),
        2,
        Number(rStr.slice(1)),
        sp.start,
        sp.end,
      );
      console.log(
        [
          base.id.padEnd(40),
          pct(st.totalReturn).padStart(9),
          `${st.maxDrawdown.toFixed(1)}%`.padStart(8),
          st.sharpe.toFixed(2).padStart(7),
          `${st.avgInvested.toFixed(0)}%`.padStart(8),
        ].join(' '),
      );
    }
    const b = buyHoldBenchmark(stocks, sp.start, sp.end);
    console.log(['BUYHOLD'.padEnd(40), pct(b.totalReturn).padStart(9), `${b.maxDrawdown.toFixed(1)}%`.padStart(8), b.sharpe.toFixed(2).padStart(7), '100%'.padStart(8)].join(' '));
  }

  // ---- 与项目执行器一致的模拟 (每日撮合 + confidence 排序 + maxPositions) ----
  console.log('\n===== 执行器口径模拟 (maxPositions + confidence 排序, T+1 开盘成交) =====');
  const proxyConf = (ind: Indicators, i: number) => -ind.vol20[i] / 0.03 - ind.ext20[i] / 0.1;
  const confs: { id: string; fn: (ind: Indicators, i: number) => number }[] = [
    { id: 'none', fn: () => 0.5 },
    { id: 'lowvol', fn: (ind, i) => -ind.vol20[i] },
    { id: 'proxy', fn: proxyConf },
    { id: 'lv_obv', fn: (ind, i) => -ind.vol20[i] / 0.03 - ind.ext20[i] / 0.1 + ind.obvSlopeNorm[i] },
    { id: 'lv_near', fn: (ind, i) => -ind.vol20[i] / 0.03 - ind.ext20[i] / 0.1 + ind.dist52w[i] },
  ];
  const exits: { id: string; fn: (ind: Indicators, i: number, bars: Bar[]) => boolean }[] = [
    { id: 'ma50', fn: (ind, i, bars) => has(ind.ma50[i]) && bars[i].close < ind.ma50[i] },
    { id: 'll20', fn: (ind, i, bars) => has(ind.ll20Prev[i]) && bars[i].close < ind.ll20Prev[i] },
    { id: 'ma100', fn: (ind, i, bars) => has(ind.ma100[i]) && bars[i].close < ind.ma100[i] },
    { id: 'obv_ma50', fn: (ind, i, bars) => obvExit(ind, i, bars) },
    { id: 'state_off', fn: (ind, i, bars) => !(has(ind.ma100[i]) && has(ind.ma50[i]) && bars[i].close > ind.ma100[i] && bars[i].close > ind.ma50[i] && obvAccumulating(ind, i)) },
    { id: 'hh20_15', fn: (ind, i, bars) => has(ind.hh20Prev[i]) && bars[i].close < ind.hh20Prev[i] * 0.85 },
    { id: 'hh20_12', fn: (ind, i, bars) => has(ind.hh20Prev[i]) && bars[i].close < ind.hh20Prev[i] * 0.88 },
  ];
  const execResults: { id: string; eligId: string; confId: string; exitId: string; k: number; stat: CsPortfolioStat }[] = [];
  for (const elig of ELIGIBILITY) {
    for (const cf of confs) {
      for (const ex of exits) {
        for (const k of [10]) {
          const st = simulateExecutorLike(allDates, byDate, elig.fn, ex.fn, cf.fn, k, SIM_START, maxDate, false);
          execResults.push({ id: `${elig.id}|${cf.id}|${ex.id}|K${k}`, eligId: elig.id, confId: cf.id, exitId: ex.id, k, stat: st });
        }
      }
    }
  }
  for (const id of ['obv_trigger|none|obv_ma50|K10', 'lt_breakout|none|ll20|K10', 'lowvol_placeholder']) {
    const r = execResults.find((x) => x.id === id);
    if (r) console.log(`[口径校验] ${id} = ${pct(r.stat.totalReturn)} (生产实测 OBV +106.39% / LT +21.03%)`);
  }
  console.log(['config'.padEnd(42), 'ret'.padStart(9), 'annual'.padStart(8), 'maxDD'.padStart(8), 'sharpe'.padStart(7), 'invested'.padStart(8), 'trades'.padStart(7)].join(' '));
  for (const r of [...execResults].sort((a, b) => b.stat.sharpe - a.stat.sharpe).slice(0, 18)) {
    console.log(
      [
        r.id.padEnd(42),
        pct(r.stat.totalReturn).padStart(9),
        pct(r.stat.annualReturn).padStart(8),
        `${r.stat.maxDrawdown.toFixed(1)}%`.padStart(8),
        r.stat.sharpe.toFixed(2).padStart(7),
        `${r.stat.avgInvested.toFixed(0)}%`.padStart(8),
        String(r.stat.trades).padStart(7),
      ].join(' '),
    );
  }

  console.log('\n===== 执行器口径 top 配置的样本内 / 样本外 (T+1 开盘) =====');
  const execTop = [...execResults].sort((a, b) => b.stat.sharpe - a.stat.sharpe).slice(0, 4);
  for (const sp of csSplits) {
    console.log(`\n[${sp.label}]`);
    console.log(['config'.padEnd(42), 'ret'.padStart(9), 'maxDD'.padStart(8), 'sharpe'.padStart(7), 'invested'.padStart(8)].join(' '));
    for (const base of execTop) {
      const elig = ELIGIBILITY.find((e) => e.id === base.eligId)!;
      const cf = confs.find((e) => e.id === base.confId)!;
      const ex = exits.find((e) => e.id === base.exitId)!;
      const st = simulateExecutorLike(allDates, byDate, elig.fn, ex.fn, cf.fn, base.k, sp.start, sp.end, true);
      console.log(
        [
          base.id.padEnd(42),
          pct(st.totalReturn).padStart(9),
          `${st.maxDrawdown.toFixed(1)}%`.padStart(8),
          st.sharpe.toFixed(2).padStart(7),
          `${st.avgInvested.toFixed(0)}%`.padStart(8),
        ].join(' '),
      );
    }
    const b = buyHoldBenchmark(stocks, sp.start, sp.end);
    console.log(['BUYHOLD'.padEnd(42), pct(b.totalReturn).padStart(9), `${b.maxDrawdown.toFixed(1)}%`.padStart(8), b.sharpe.toFixed(2).padStart(7), '100%'.padStart(8)].join(' '));
  }

  // ---- 落盘 ----
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(
    OUT_JSON,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataRange: { start: DATA_START, end: maxDate },
        simStart: SIM_START,
        stocks: stocks.length,
        ic: ic.ics,
        conditionalIc: cond,
        corrLtObv: ic.corrLtObv,
        event: ic.event,
        buyHold: { totalReturn: bh.totalReturn, annualReturn: bh.annualReturn, maxDrawdown: bh.maxDrawdown, sharpe: bh.sharpe, yearly: bh.yearly },
        crossSectional: [...grid].sort((a, b) => b.sharpe - a.sharpe).slice(0, 12).map((r) => ({
          id: r.id,
          totalReturn: r.totalReturn,
          annualReturn: r.annualReturn,
          maxDrawdown: r.maxDrawdown,
          sharpe: r.sharpe,
          avgInvested: r.avgInvested,
          avgHoldings: r.avgHoldings,
          trades: r.trades,
        })),
        executor: [...execResults].sort((a, b) => b.stat.sharpe - a.stat.sharpe).map((r) => ({
          id: r.id,
          totalReturn: r.stat.totalReturn,
          annualReturn: r.stat.annualReturn,
          maxDrawdown: r.stat.maxDrawdown,
          sharpe: r.stat.sharpe,
          avgInvested: r.stat.avgInvested,
          avgHoldings: r.stat.avgHoldings,
          trades: r.stat.trades,
        })),
        variants: results.map((r) => ({
          id: r.id,
          label: r.label,
          totalReturn: r.totalReturn,
          annualReturn: r.annualReturn,
          maxDrawdown: r.maxDrawdown,
          sharpe: r.sharpe,
          exposure: r.exposure,
          trades: r.trades,
          winRate: r.winRate,
          avgTrade: r.avgTrade,
          avgWin: r.avgWin,
          avgLoss: r.avgLoss,
          payoff: r.payoff,
          avgHolding: r.avgHolding,
          medianTrade: r.medianTrade,
          yearly: r.yearly,
        })),
      },
      null,
      2,
    ),
    'utf-8',
  );
  console.log(`\n结果已写入 ${OUT_JSON}`);
}

main();
