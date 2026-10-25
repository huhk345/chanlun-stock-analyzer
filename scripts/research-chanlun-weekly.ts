/**
 * 缠论「大周期确认趋势 + 日线第三类买点」因果关系验证。
 *
 * 不做参数搜索, 只检验一条结构假设:
 *   1) 周线级别用缠论中枢判定趋势 (中枢依次上移 = 上升趋势);
 *   2) 日线级别用第三类买点 (离开中枢后回抽不回中枢上沿) 作为顺势入场点;
 *   3) 比较「周线上升趋势中的第三类买点」与「逆势第三类买点」的未来超额收益。
 *
 * 若结构假设成立, 顺势组应显著优于逆势组, 且不依赖任何阈值参数。
 *
 * 用法: pnpm exec tsx scripts/research-chanlun-weekly.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Kline } from '../src/types/stock';
import { mergeKlines, findFractions, calculateStrokes, calculateHubs } from '../src/utils/chanlun';

const BASE = process.cwd();
const CACHE_DIR = path.join(BASE, '.cache', 'klines');
const INDEXES = ['hs300', 'zz500'];
const DATA_START = '2023-01-01';
const HORIZONS = [10, 20, 60];

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
  index: string;
  bars: Bar[];
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

function loadUniverse(): Stock[] {
  const meta = new Map<string, string>();
  for (const idx of INDEXES) {
    const file = path.join(BASE, 'data', idx, '_constituents.json');
    if (!fs.existsSync(file)) continue;
    const list = JSON.parse(fs.readFileSync(file, 'utf-8')) as string[];
    for (const symbol of list) meta.set(symbol, idx);
  }
  const stocks: Stock[] = [];
  for (const [symbol, idx] of meta) {
    const file = path.join(CACHE_DIR, `${symbol}_1d_forward.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { klines?: Bar[] };
      const bars = (raw.klines ?? []).filter((b) => b.date >= DATA_START && b.close > 0);
      if (bars.length < 200) continue;
      stocks.push({ symbol, index: idx, bars });
    } catch {
      // 跳过损坏文件
    }
  }
  stocks.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return stocks;
}

// ---------------------------------------------------------------------------
// 周线聚合 (只用已走完的周)
// ---------------------------------------------------------------------------

function weekKeyOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dowFromMonday = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dowFromMonday * 86_400_000).toISOString().slice(0, 10);
}

interface WeeklyBar extends Kline {
  endDate: string;
}

/** 把日线聚合成周线, 每根周线记录该周最后一个交易日 */
function toWeeklyBars(bars: readonly Bar[]): WeeklyBar[] {
  const out: WeeklyBar[] = [];
  for (const b of bars) {
    const key = weekKeyOf(b.date);
    const last = out[out.length - 1];
    if (!last || weekKeyOf(last.endDate) !== key) {
      out.push({
        date: key,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        amount: b.close * b.volume,
        endDate: b.date,
      });
    } else {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume;
      last.amount += b.close * b.volume;
      last.endDate = b.date;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 周线缠论趋势判定 (结构性, 无参数)
// ---------------------------------------------------------------------------

interface WeeklyTrend {
  up: boolean;
  reason: string;
}

/**
 * 周线上升趋势 = 缠论的「趋势」定义:
 *   - 最后一个已确认的周线笔向上;
 *   - 且最近两个周线中枢依次上移 (后中枢的 zd/zg 都高于前中枢);
 *   - 只有一个中枢时, 要求周线收盘站在该中枢上沿之上。
 */
function weeklyTrendAt(weekly: readonly WeeklyBar[], weekIdx: number): WeeklyTrend {
  if (weekIdx < 20) return { up: false, reason: '周线样本不足' };
  const slice = weekly.slice(0, weekIdx + 1) as Kline[];
  const merged = mergeKlines(slice);
  const fractions = findFractions(merged, slice);
  const strokes = calculateStrokes(fractions);
  // 最后一笔的终点仍可能被后续 K 线改写, 不能作为已完成结构
  const confirmed = strokes.slice(0, -1);
  if (confirmed.length < 3) return { up: false, reason: '周线笔不足' };
  if (confirmed[confirmed.length - 1].direction !== 'up') {
    return { up: false, reason: '周线最后一笔向下' };
  }
  const hubs = calculateHubs(confirmed);
  if (hubs.length === 0) return { up: false, reason: '周线无中枢' };
  const last = hubs[hubs.length - 1];
  if (hubs.length === 1) {
    const above = slice[slice.length - 1].close > last.zg;
    return { up: above, reason: above ? '收盘在周线中枢上方' : '收盘未站上周线中枢' };
  }
  const prev = hubs[hubs.length - 2];
  const shifted = last.zd > prev.zd && last.zg > prev.zg;
  return { up: shifted, reason: shifted ? '周线中枢依次上移' : '周线中枢未上移' };
}

/** 找到事件日对应的最后一个已完成周线下标 */
function completedWeekIndex(weekly: readonly WeeklyBar[], date: string): number {
  let lo = 0;
  let hi = weekly.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (weekly[mid].endDate <= date) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

// ---------------------------------------------------------------------------
// 日线第三类买点 (复用项目已有的缠论买卖点判定)
// ---------------------------------------------------------------------------

interface BuyPoint {
  index: number;
  date: string;
  price: number;
  type: 'B2' | 'B3';
  /** 该买点在逐根回放中「可被确认」的那一根 K 线 (下一笔走完时, 本笔才不再是最后一笔) */
  confirmIndex: number;
  confirmDate: string;
}

/**
 * 第三类买点: 中枢 (最近三个次级别走势) 被向上离开后, 回抽的低点不跌回中枢上沿。
 * 这里用笔级别的简化判定 (与 src/utils/chanlun.ts 的 B3 定义一致)。
 */
function thirdBuyPoints(bars: readonly Bar[]): BuyPoint[] {
  const slice = bars as Kline[];
  const strokes = calculateStrokes(findFractions(mergeKlines(slice), slice));
  const out: BuyPoint[] = [];
  const low = (s: (typeof strokes)[number]) => Math.min(s.start.price, s.end.price);
  const high = (s: (typeof strokes)[number]) => Math.max(s.start.price, s.end.price);
  for (let e = 4; e < strokes.length; e++) {
    const b1 = strokes[e - 4];
    const b3 = strokes[e - 2];
    const b5 = strokes[e];
    const zd = Math.max(low(b1), low(b3));
    const zg = Math.min(high(b1), high(b3));
    if (zd > zg) continue;
    if (b5.direction === 'down' && low(b5) > zg) {
      // 策略只能读到「已被后续走势确认」的笔: 下一笔走完时, 这一笔才不再可能被改写
      const next = strokes[e + 1];
      out.push({
        index: b5.end.originalIndex,
        date: b5.end.date,
        price: b5.end.price,
        type: 'B3',
        confirmIndex: next ? next.end.originalIndex : -1,
        confirmDate: next ? next.end.date : '',
      });
    }
  }
  return out;
}

/**
 * 可操作的三类买点信号 (逐根可判定, 不依赖「下一笔走完」):
 *   以最近一个已完成中枢为参照, 中枢上沿 zg;
 *   1) 中枢之后出现过收盘价站上 zg (离开中枢);
 *   2) 离开之后的回抽最低价始终不跌回 zg 之下 (回抽不进中枢);
 *   3) 当日收盘价 > 前一日最高价 (底分型成立, 向上转折);
 *   4) 当日收盘价仍站在 zg 之上。
 * 每一步都是缠论结构含义, 没有可调阈值。
 */
function hubThirdBuySignals(bars: readonly Bar[]): number[] {
  const slice = bars as Kline[];
  const strokes = calculateStrokes(findFractions(mergeKlines(slice), slice));
  const hubs = calculateHubs(strokes.slice(0, -1));
  const out: number[] = [];
  if (!hubs.length) return out;

  let hi = 0;
  for (let i = 1; i < bars.length; i++) {
    // 只取 endIndex < i 的最近一个已完成中枢
    while (hi + 1 < hubs.length && hubs[hi + 1].endIndex < i) hi++;
    const hub = hubs[hi];
    if (!hub || hub.endIndex >= i || hub.zg <= 0) continue;
    const zg = hub.zg;

    let broke = false;
    let pullbackLow = Infinity;
    for (let j = hub.endIndex + 1; j < i; j++) {
      if (!broke) {
        if (bars[j].close > zg) broke = true;
      } else if (bars[j].low < pullbackLow) {
        pullbackLow = bars[j].low;
      }
    }
    if (!broke) continue;
    if (pullbackLow <= zg) continue;
    if (bars[i].close <= zg) continue;
    if (bars[i].close <= bars[i - 1].high) continue;
    // 只保留「转折的第一根」: 前一根不满足同一条件, 避免连续上涨日重复计数
    const prevOk =
      bars[i - 1].close > zg && bars[i - 1].close > bars[i - 2].high;
    if (prevOk) continue;
    out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 事件研究
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface EventRow {
  symbol: string;
  date: string;
  index: number;
  type: string;
  weeklyUp: boolean;
  reason: string;
}

function main() {
  console.log('加载本地 K 线 ...');
  const stocks = loadUniverse();
  console.log(`股票数 ${stocks.length}`);

  // 1) 先构建全样本的「同日未来收益」基准, 用于计算超额
  const benchByDate = new Map<string, Map<number, number[]>>();
  for (const s of stocks) {
    for (let i = 0; i < s.bars.length; i++) {
      for (const h of HORIZONS) {
        const j = i + h;
        if (j >= s.bars.length) continue;
        const r = s.bars[j].close / s.bars[i].close - 1;
        const key = s.bars[i].date;
        let m = benchByDate.get(key);
        if (!m) {
          m = new Map();
          benchByDate.set(key, m);
        }
        const arr = m.get(h);
        if (arr) arr.push(r);
        else m.set(h, [r]);
      }
    }
  }
  const benchMean = new Map<string, Map<number, number>>();
  for (const [date, m] of benchByDate) {
    const out = new Map<number, number>();
    for (const [h, arr] of m) out.set(h, mean(arr));
    benchMean.set(date, out);
  }

  // 2) 逐只股票找买点, 判定当时的周线趋势
  console.log('计算日线买点与周线趋势 ...');
  const events: EventRow[] = [];
  const excess: Record<string, Record<number, number[]>> = {};
  let weeklyCacheSymbol = '';
  let weekly: WeeklyBar[] = [];
  /** 周线下标 -> 趋势判定 (同一周只需算一次, 该判定是重计算) */
  const trendCache = new Map<number, WeeklyTrend>();

  for (let si = 0; si < stocks.length; si++) {
    const s = stocks[si];
    weekly = toWeeklyBars(s.bars);
    weeklyCacheSymbol = s.symbol;
    trendCache.clear();
    const trendAt = (wIdx: number): WeeklyTrend => {
      let t = trendCache.get(wIdx);
      if (!t) {
        t = weeklyTrendAt(weekly, wIdx);
        trendCache.set(wIdx, t);
      }
      return t;
    };
    if (si % 100 === 0) process.stdout.write(` ${si}/${stocks.length}`);

    const points = thirdBuyPoints(s.bars);
    // 可操作版三类买点: 逐根可判定, 无需等下一笔走完
    const actionable = hubThirdBuySignals(s.bars);
    for (const i of actionable) {
      if (i < 60 || i >= s.bars.length) continue;
      const date = s.bars[i].date;
      const wIdx = completedWeekIndex(weekly, date);
      if (wIdx < 0) continue;
      const trend = trendAt(wIdx);
      const group = trend.up ? '三买可操作|周线趋势向上' : '三买可操作|周线趋势不向上';
      for (const h of HORIZONS) {
        const j = i + h;
        if (j >= s.bars.length) continue;
        const r = s.bars[j].close / s.bars[i].close - 1;
        const b = benchMean.get(date)?.get(h);
        if (b === undefined) continue;
        (excess[group] ??= {});
        (excess[group][h] ??= []).push(r - b);
      }
    }

    // 对照组: 拆解「中枢结构」与「周线趋势」各自的增量
    //   C1 仅向上转折 (无中枢、无周线) —— 基准形态
    //   C2 向上转折 + 周线趋势向上 —— 单看大周期确认的贡献
    //   C3/C4 三买可操作 + 周线向上/不向上 —— 已在上面, 用于与 C2 比较中枢结构的增量
    for (let i = 1; i < s.bars.length; i++) {
      if (i < 60) continue;
      if (s.bars[i].close <= s.bars[i - 1].high) continue;
      if (s.bars[i - 1].close > s.bars[i - 2].high) continue; // 同样只取转折第一根
      const date = s.bars[i].date;
      const wIdx = completedWeekIndex(weekly, date);
      if (wIdx < 0) continue;
      const trend = trendAt(wIdx);
      const c1 = 'C1仅向上转折';
      const c2 = trend.up ? 'C2向上转折|周线趋势向上' : 'C2向上转折|周线趋势不向上';
      for (const h of HORIZONS) {
        const j = i + h;
        if (j >= s.bars.length) continue;
        const r = s.bars[j].close / s.bars[i].close - 1;
        const b = benchMean.get(date)?.get(h);
        if (b === undefined) continue;
        (excess[c1] ??= {});
        (excess[c1][h] ??= []).push(r - b);
        (excess[c2] ??= {});
        (excess[c2][h] ??= []).push(r - b);
      }
    }

    for (const p of points) {
      if (p.index < 60 || p.confirmIndex < 0) continue;
      const wIdx = completedWeekIndex(weekly, p.date);
      if (wIdx < 0) continue;
      // 同一周内重复判定周线趋势代价高, 按周缓存
      const trend = trendAt(wIdx);
      const row: EventRow = {
        symbol: s.symbol,
        date: p.date,
        index: p.index,
        type: p.type,
        weeklyUp: trend.up,
        reason: trend.reason,
      };
      events.push(row);

      const group = trend.up ? `${p.type}|周线趋势向上` : `${p.type}|周线趋势不向上`;
      for (const h of HORIZONS) {
        const j = p.index + h;
        if (j >= s.bars.length) continue;
        const r = s.bars[j].close / s.bars[p.index].close - 1;
        const b = benchMean.get(p.date)?.get(h);
        if (b === undefined) continue;
        (excess[group] ??= {});
        (excess[group][h] ??= []).push(r - b);
      }

      // 可部署版本: 在「买点被确认」的那一根收盘入场, 而不是在事后才知道的笔端点入场
      const c = p.confirmIndex;
      if (c >= s.bars.length) continue;
      const cGroup = (trend.up ? 'B3确认|周线趋势向上' : 'B3确认|周线趋势不向上');
      for (const h of HORIZONS) {
        const j = c + h;
        if (j >= s.bars.length) continue;
        const r = s.bars[j].close / s.bars[c].close - 1;
        const b = benchMean.get(s.bars[c].date)?.get(h);
        if (b === undefined) continue;
        (excess[cGroup] ??= {});
        (excess[cGroup][h] ??= []).push(r - b);
      }
    }
  }
  void weeklyCacheSymbol;
  console.log('');

  // 3) 汇总
  console.log('\n===== 第三类买点 × 周线趋势: 超额收益 (相对同日全样本均值) =====');
  console.log(
    ['group'.padEnd(26), 'h'.padStart(3), '超额'.padStart(9), '中位'.padStart(8), '命中率'.padStart(8), '样本'.padStart(7)].join(' '),
  );
  for (const group of Object.keys(excess).sort()) {
    for (const h of HORIZONS) {
      const arr = excess[group][h];
      if (!arr || arr.length < 20) continue;
      const hit = arr.filter((v) => v > 0).length / arr.length;
      console.log(
        [
          group.padEnd(26),
          String(h).padStart(3),
          `${(mean(arr) * 100).toFixed(2)}%`.padStart(9),
          `${(median(arr) * 100).toFixed(2)}%`.padStart(8),
          `${(hit * 100).toFixed(1)}%`.padStart(8),
          String(arr.length).padStart(7),
        ].join(' '),
      );
    }
  }

  const upCount = events.filter((e) => e.weeklyUp).length;
  console.log(`\n买点事件合计 ${events.length}, 其中周线趋势向上 ${upCount} (${((upCount / Math.max(events.length, 1)) * 100).toFixed(1)}%)`);

  // 4) 买点到确认的滞后分布 (用于判断是否需要额外的确认窗口)
  const lags = events.map((e) => 0);
  void lags;

  fs.mkdirSync(path.join(BASE, 'reports'), { recursive: true });
  fs.writeFileSync(
    path.join(BASE, 'reports', 'chanlun-weekly-research.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        stocks: stocks.length,
        eventCount: events.length,
        weeklyUpCount: upCount,
        excess: Object.fromEntries(
          Object.entries(excess).map(([g, byH]) => [
            g,
            Object.fromEntries(
              Object.entries(byH).map(([h, arr]) => [
                h,
                { n: arr.length, mean: mean(arr), median: median(arr), hitRate: arr.filter((v) => v > 0).length / arr.length },
              ]),
            ),
          ]),
        ),
        reasonBreakdown: events.reduce<Record<string, number>>((acc, e) => {
          acc[e.reason] = (acc[e.reason] ?? 0) + 1;
          return acc;
        }, {}),
      },
      null,
      2,
    ),
    'utf-8',
  );
  console.log('\n[明细] reports/chanlun-weekly-research.json');
}

main();
