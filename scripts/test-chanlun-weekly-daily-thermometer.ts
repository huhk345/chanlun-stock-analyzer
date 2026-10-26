/**
 * Strategy-specific historical checks for the weekly/daily Chanlun strategy.
 *
 * Run with:
 *   pnpm test:strategy:thermometer
 *   pnpm exec tsx scripts/test-chanlun-weekly-daily-thermometer.ts --symbols 600519.SH,601318.SH
 *
 * The checks cover ledger validity, formal Chanlun entry points, and prefix
 * invariance. Period returns are reported as diagnostics; they are not tuned
 * into pass/fail thresholds, which would encourage fitting to this sample.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';


import { runBacktest } from '../server/engine/backtestRunner.ts';
import type { BacktestTrade, BSPoint, Kline } from '../src/types/stock.ts';
import { runChanlunPipeline } from '../src/utils/chanlun.ts';
import { chanlunWeeklyDailyThermometerStrategy } from '../server/strategies/chanlun-weekly-daily-thermometer.ts';
import { MARKET_STRENGTH_ROWS } from '../server/strategies/data/market-strength.ts';
import { buildStrategyParams } from '../server/engine/strategyAdapter.ts';

const INITIAL_CASH = 500_000;
// 601816.SH 覆盖真实的"末端笔买点后来被延伸改写"场景：2024-12-24 的三买在
// 当时的前缀里存在，完整数据里消失，旧实现会据此在 2024-12-27 买入。
const DEFAULT_SYMBOLS = ['600519.SH', '601318.SH', '000001.SZ', '000333.SZ', '000858.SZ', '300750.SZ', '601816.SH'];
const PERIODS = [
  ['2016–2020', '2016-01-01', '2020-12-31'],
  ['2021–2023', '2021-01-01', '2023-12-31'],
  ['2024–latest', '2024-01-01', '9999-12-31'],
] as const;

const failures: string[] = [];
let checks = 0;
let prefixComparisons = 0;

function check(condition: boolean, message: string): void {
  checks++;
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

function parseArgs(): Record<string, string> {
  const options: Record<string, string> = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const value = args[i + 1];
    if (value && !value.startsWith('--')) {
      options[key] = value;
      i++;
    } else options[key] = 'true';
  }
  return options;
}

function loadKlines(symbol: string): Kline[] {
  const file = join(process.cwd(), 'data', 'hs300', `${symbol}.csv`);
  const lines = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const header = lines[0].split(',').map((value) => value.trim());
  const col = (name: string) => header.indexOf(name);
  const indexes = ['date', 'open', 'high', 'low', 'close', 'volume', 'amount'].map(col);
  if (indexes.some((index) => index < 0)) throw new Error(`${file} is missing required OHLCV columns`);
  return lines.slice(1).flatMap((line) => {
    const row = line.split(',');
    if (row.length < header.length) return [];
    const [date, open, high, low, close, volume, amount] = indexes.map((index) => row[index].trim());
    const bar = { date, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume), amount: Number(amount) };
    return date && Object.values(bar).slice(1).every((value) => Number.isFinite(value)) ? [bar] : [];
  });
}

function backtest(symbol: string, klines: readonly Kline[], gateCounts?: Map<string, number>) {
  const strategy = gateCounts
    ? {
      ...chanlunWeeklyDailyThermometerStrategy,
      decide(input: Parameters<typeof chanlunWeeklyDailyThermometerStrategy.decide>[0]) {
        const decision = chanlunWeeklyDailyThermometerStrategy.decide(input);
        if (decision.reason?.startsWith('[filter:')) {
          const gate = decision.reason.split(']')[0] + ']';
          gateCounts.set(gate, (gateCounts.get(gate) ?? 0) + 1);
        }
        return decision;
      },
    }
    : chanlunWeeklyDailyThermometerStrategy;
  return runBacktest({
    klines,
    symbol,
    userId: 'strategy-validation',
    initialCash: INITIAL_CASH,
    currency: 'CNY',
    strategy,
  });
}

function tradeProjection(trades: readonly BacktestTrade[]): string {
  return JSON.stringify(trades.map(({ type, date, price, shares, value, fee, pnl, reason, signalType }) =>
    ({ type, date, price, shares, value, fee, pnl, reason, signalType })),
  );
}

function equityAt(output: ReturnType<typeof backtest>, index: number): number {
  return output.equityCurve?.[index] ?? Number.NaN;
}

function periodSummary(klines: readonly Kline[], equity: readonly number[], from: string, through: string) {
  let first = klines.findIndex((bar) => bar.date >= from && bar.date <= through);
  if (first < 0) return null;
  let last = first;
  while (last + 1 < klines.length && klines[last + 1].date <= through) last++;
  if (klines[last].date < from) return null;
  const startingEquity = first > 0 ? equity[first - 1] : INITIAL_CASH;
  const endingEquity = equity[last];
  if (!(startingEquity > 0) || !Number.isFinite(endingEquity)) return null;
  let peak = startingEquity;
  let maxDrawdown = 0;
  for (let i = first; i <= last; i++) {
    peak = Math.max(peak, equity[i]);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity[i]) / peak * 100);
  }
  // Match the strategy's prior-close equity baseline, so the buy-and-hold
  // comparator includes the same first in-period price move.
  const buyHoldStartPrice = first > 0 ? klines[first - 1].close : klines[first].close;
  return {
    returnPercent: (endingEquity / startingEquity - 1) * 100,
    buyHoldPercent: (klines[last].close / buyHoldStartPrice - 1) * 100,
    maxDrawdownPercent: maxDrawdown,
    start: klines[first].date,
    end: klines[last].date,
  };
}

function validateLedger(symbol: string, klines: readonly Kline[], output: ReturnType<typeof backtest>): void {
  const label = `${symbol} ${klines[0]?.date}..${klines.at(-1)?.date}`;
  const barsByDate = new Map(klines.map((bar) => [bar.date, bar]));
  // 看板口径：用同一段完整数据算出的最终买卖点。
  const dashboardPoints = new Map<string, BSPoint>(
    runChanlunPipeline([...klines]).bsPoints.map((point) => [`${point.type}@${point.date}`, point]),
  );
  let shares = 0;
  let cash = INITIAL_CASH;
  let averageCost = 0;
  let atrTrimCount = 0;
  let previousTradeDate = '';
  let previousTradeType = '';

  for (const trade of output.result.trades) {
    const bar = barsByDate.get(trade.date);
    check(!!bar, `${label}: ${trade.type} date exists in source bars (${trade.date})`);
    if (bar) {
      check(trade.price >= bar.low - 0.011 && trade.price <= bar.high + 0.011,
        `${label}: ${trade.type} price is within daily OHLC (${trade.date})`);
    }
    check(Number.isInteger(trade.shares) && trade.shares > 0, `${label}: positive integer shares (${trade.date})`);
    if (trade.type === 'BUY') {
      check(trade.shares % 100 === 0, `${label}: BUY respects A-share 100-share lots (${trade.date})`);
      check(/^B3\||^B2\||^B1\|/.test(trade.reason ?? ''), `${label}: BUY is a formal Chanlun B3/B2/B1 point (${trade.date}; ${trade.reason ?? 'no reason'})`);
      const pointMatch = trade.reason?.match(/(?:^|\|)point=(\d{4}-\d{2}-\d{2})/);
      const pointType = trade.reason?.match(/^(B[123])\|/)?.[1];
      const supportMatch = trade.reason?.match(/(?:^|\|)support=([0-9]+(?:\.[0-9]+)?)/);
      const dashboardPoint = pointMatch && pointType ? dashboardPoints.get(`${pointType}@${pointMatch[1]}`) : undefined;
      check(!!dashboardPoint,
        `${label}: BUY trigger point exists in dashboard Chanlun points (${trade.date}; ${pointType ?? '?'}@${pointMatch?.[1] ?? 'missing'})`);
      if (dashboardPoint && supportMatch) {
        check(Math.abs(dashboardPoint.price - Number(supportMatch[1])) <= 0.0001,
          `${label}: BUY support equals the dashboard point price (${trade.date}; ${dashboardPoint.date})`);
      }
      check(trade.reason?.includes('周线') && trade.reason.includes('日线 MA20 上行'),
        `${label}: BUY reason records weekly and rising daily trend confirmation (${trade.date})`);
      if (trade.date === previousTradeDate && previousTradeType === 'SELL') {
        check(false, `${label}: does not buy and sell on one day (${trade.date})`);
      }
      shares += trade.shares;
      averageCost = ((averageCost * (shares - trade.shares)) + trade.price * trade.shares) / shares;
      cash -= trade.value + (trade.fee ?? 0);
    } else {
      check(trade.shares <= shares, `${label}: SELL does not exceed held shares (${trade.date})`);
      if (trade.shares < shares) check(trade.shares % 100 === 0, `${label}: partial SELL respects A-share 100-share lots (${trade.date})`);
      if (trade.reason?.startsWith('[time-stop]|') && averageCost > 0) {
        const markedReturn = (trade.price / averageCost - 1) * 100;
        check(markedReturn < 2.01, `${label}: time-stop does not sell while marked return is at least 2% (${trade.date}: ${markedReturn.toFixed(2)}%)`);
        check(trade.reason.includes('周线多头未确认'), `${label}: time-stop reason confirms weekly trend is not bullish (${trade.date})`);
      }
      if (trade.reason?.startsWith('[atr-trailing-trim]|')) {
        atrTrimCount++;
        check(atrTrimCount === 1, `${label}: ATR trailing trim occurs at most once per position (${trade.date})`);
      }
      shares -= trade.shares;
      if (shares === 0) {
        averageCost = 0;
        atrTrimCount = 0;
      }
      cash += trade.value - (trade.fee ?? 0);
      if (trade.date === previousTradeDate && previousTradeType === 'BUY') {
        check(false, `${label}: does not sell on buy date (${trade.date})`);
      }
    }
    check(cash >= -0.02, `${label}: ledger cash is non-negative after ${trade.type} (${trade.date})`);
    previousTradeDate = trade.date;
    previousTradeType = trade.type;
  }

  const lastClose = klines.at(-1)?.close ?? 0;
  const reconciledEquity = cash + shares * lastClose;
  check(Math.abs(reconciledEquity - output.result.finalBalance) <= 0.02,
    `${label}: trade ledger reconciles to final equity`);
  check(Math.abs(reconciledEquity - (output.equityCurve?.at(-1) ?? Number.NaN)) <= 0.02,
    `${label}: final equity matches equity curve`);
  check(output.diagnostics.every((item) => item.level !== 'error'), `${label}: no fatal strategy diagnostics`);
}

function validatePrefixInvariance(symbol: string, klines: readonly Kline[], fullOutput: ReturnType<typeof backtest>): void {
  const desiredCuts = ['2022-12-30', '2024-12-31'];
  for (const desiredDate of desiredCuts) {
    let index = -1;
    for (let i = 0; i < klines.length; i++) {
      if (klines[i].date <= desiredDate) index = i;
      else break;
    }
    if (index < 250 || index >= klines.length - 1) continue;
    const prefix = klines.slice(0, index + 1);
    const prefixOutput = backtest(symbol, prefix);
    const fullTradesThroughCut = fullOutput.result.trades.filter((trade) => trade.date <= prefix[index].date);
    check(tradeProjection(prefixOutput.result.trades) === tradeProjection(fullTradesThroughCut),
      `${symbol}: prefix trades through ${prefix[index].date} match full run`);
    check(Math.abs(prefixOutput.result.finalBalance - equityAt(fullOutput, index)) <= 0.02,
      `${symbol}: prefix final equity matches full run at ${prefix[index].date}`);
    prefixComparisons++;
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function feedDecision(symbol: string, bars: readonly Kline[], endIndex: number) {
  const klines = bars.slice(0, endIndex + 1);
  return chanlunWeeklyDailyThermometerStrategy.decide({
    symbol,
    timeframe: 'daily',
    klines,
    currentIndex: klines.length - 1,
    currentKline: klines.at(-1)!,
    account: { initialCash: INITIAL_CASH, cash: INITIAL_CASH, equity: INITIAL_CASH, currency: 'CNY' },
    position: { shares: 0, averageCost: 0, marketValue: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0 },
    trades: [],
    params: buildStrategyParams(chanlunWeeklyDailyThermometerStrategy),
    currency: 'CNY',
    initialCash: INITIAL_CASH,
  });
}

function validateFutureFallback(): void {
  const symbol = '601318.SH';
  const originalBars = loadKlines(symbol);
  // 2025-05-30 is a known daily B3 point; it only becomes actionable once the
  // following stroke exists, which is what this fixture verifies.
  const anchorIndex = originalBars.findIndex((bar) => bar.date === '2025-05-30');
  if (anchorIndex < 500) throw new Error('Missing known B3 fixture date for stale-feed check');

  // Shift dates by an exact number of weeks so the same completed-week and
  // Chanlun structures remain, and place the fixture 30+ days after the
  // embedded market feed. This stays valid when that feed is refreshed.
  const latestMarketDate = MARKET_STRENGTH_ROWS.at(-1)?.[0];
  if (!latestMarketDate) throw new Error('Missing market-strength rows for stale-feed check');
  const anchorMs = Date.parse(`${originalBars[anchorIndex].date}T00:00:00.000Z`);
  const latestMarketMs = Date.parse(`${latestMarketDate}T00:00:00.000Z`);
  const daysUntilLatestMarket = Math.max(0, Math.ceil((latestMarketMs - anchorMs) / 86_400_000));
  const shiftDays = Math.ceil((daysUntilLatestMarket + 30) / 7) * 7;
  const shiftedBars = originalBars.slice(0, Math.min(anchorIndex + 90, originalBars.length)).map((bar) => {
    const date = new Date(`${bar.date}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + shiftDays);
    return { ...bar, date: date.toISOString().slice(0, 10) };
  });

  // 1) 买点当日尚未确认，不允许提前入场。
  const anchorDecision = feedDecision(symbol, shiftedBars, anchorIndex);
  console.log(`\nFuture-feed fixture ${shiftedBars[anchorIndex].date} (B3 point day): ${anchorDecision.action} — ${anchorDecision.reason ?? 'no reason'}`);
  check(anchorDecision.action === 'HOLD' && (anchorDecision.reason ?? '').startsWith('[filter:chanlun-point]'),
    `unconfirmed B3 is not bought on its own bar (${anchorDecision.action}; ${anchorDecision.reason ?? 'no reason'})`);

  // 2) 该买点确认后，一旦满足其他条件即可入场。
  let entryIndex = -1;
  for (let i = anchorIndex + 1; i < shiftedBars.length; i++) {
    if (feedDecision(symbol, shiftedBars, i).action === 'BUY') { entryIndex = i; break; }
  }
  const entryDate = entryIndex >= 0 ? shiftedBars[entryIndex].date : 'none';
  const entryDecision = entryIndex >= 0 ? feedDecision(symbol, shiftedBars, entryIndex) : null;
  console.log(`Future-feed fixture entry ${entryDate}: ${entryDecision?.action ?? 'NONE'} — ${entryDecision?.reason ?? 'no reason'}`);
  check(!!entryDecision && entryDecision.action === 'BUY',
    `confirmed B3 becomes buyable after the following stroke forms (${entryDate})`);
  if (!entryDecision || entryDecision.action !== 'BUY') return;
  check(entryIndex - anchorIndex <= 30,
    `confirmed B3 entry arrives within the confirmation window (${entryDate}, +${entryIndex - anchorIndex} bars)`);
  check((entryDecision.reason ?? '').startsWith('B3|') &&
    (entryDecision.reason ?? '').includes(`point=${shiftedBars[anchorIndex].date}`),
    `confirmed B3 entry references the dashboard point date (${entryDecision.reason ?? 'no reason'})`);
  check(entryDecision.reason?.includes('个股趋势回退'),
    `stale-feed entry records stock-only fallback (${entryDecision.reason ?? 'no reason'})`);
  check(entryDecision.amount.unit === 'percent' && entryDecision.amount.value === 25,
    `stale-feed fallback caps B3 allocation at 25% (${JSON.stringify(entryDecision.amount)})`);
}

async function main(): Promise<void> {
  const options = parseArgs();
  const symbols = (options.symbols ?? DEFAULT_SYMBOLS.join(',')).split(',').map((value) => value.trim()).filter(Boolean);
  const prefixSymbols = new Set((options['prefix-symbols'] ?? symbols.slice(0, 2).join(',')).split(',').filter(Boolean));
  const marketLastDate = MARKET_STRENGTH_ROWS.at(-1)?.[0] ?? '';
  console.log(`Strategy: ${chanlunWeeklyDailyThermometerStrategy.id}`);
  console.log(`Symbols: ${symbols.join(', ')}`);
  console.log(`Market data ends: ${marketLastDate}`);
  check(!!marketLastDate, 'market strength dataset is non-empty');

  const summaries: Array<{ symbol: string; returnPercent: number; buyHoldPercent: number; maxDrawdownPercent: number; sharpe: number; buys: number; sells: number }> = [];
  const periodReturns = new Map<string, number[]>();
  const periodBuyHoldReturns = new Map<string, number[]>();
  let totalBuys = 0;

  for (const symbol of symbols) {
    const klines = loadKlines(symbol);
    if (options.bars) {
      const count = Number(options.bars);
      if (Number.isInteger(count) && count > 0) klines.splice(0, Math.max(0, klines.length - count));
    }
    if (klines.length < 300) throw new Error(`${symbol} has only ${klines.length} bars; at least 300 are needed`);
    const gateCounts = new Map<string, number>();
    const output = backtest(symbol, klines, gateCounts);
    validateLedger(symbol, klines, output);
    const buys = output.result.trades.filter((trade) => trade.type === 'BUY').length;
    const sells = output.result.trades.filter((trade) => trade.type === 'SELL').length;
    totalBuys += buys;
    summaries.push({
      symbol,
      returnPercent: output.result.totalReturnPercent,
      buyHoldPercent: output.result.buyHoldReturnPercent,
      maxDrawdownPercent: output.result.maxDrawdownPercent,
      sharpe: output.result.sharpeRatio,
      buys,
      sells,
    });
    console.log(`\n${symbol} ${klines[0].date}..${klines.at(-1)?.date}: strategy ${output.result.totalReturnPercent.toFixed(2)}%, buy&hold ${output.result.buyHoldReturnPercent.toFixed(2)}%, maxDD ${output.result.maxDrawdownPercent.toFixed(2)}%, Sharpe ${output.result.sharpeRatio.toFixed(2)}, ${buys} buys / ${sells} sells`);
    for (const [gate, count] of gateCounts) console.log(`  ${gate}: ${count} days`);
    for (const trade of output.result.trades) {
      if (trade.type === 'BUY') {
        console.log(`  BUY ${trade.date}: ${trade.reason ?? trade.signalType}`);
      } else {
        const returnSinceExit = klines.at(-1) ? (klines.at(-1)!.close / trade.price - 1) * 100 : 0;
        console.log(`  SELL ${trade.date}: realized ${(trade.pnlPercent ?? 0).toFixed(2)}%; stock since exit ${returnSinceExit.toFixed(2)}%, ${trade.reason ?? trade.signalType}`);
      }
    }

    for (const [name, from, through] of PERIODS) {
      const summary = periodSummary(klines, output.equityCurve ?? [], from, through);
      if (!summary) continue;
      const values = periodReturns.get(name) ?? [];
      values.push(summary.returnPercent);
      periodReturns.set(name, values);
      const buyHoldValues = periodBuyHoldReturns.get(name) ?? [];
      buyHoldValues.push(summary.buyHoldPercent);
      periodBuyHoldReturns.set(name, buyHoldValues);
      console.log(`  ${name} (${summary.start}..${summary.end}): ${summary.returnPercent.toFixed(2)}%, buy&hold ${summary.buyHoldPercent.toFixed(2)}%, maxDD ${summary.maxDrawdownPercent.toFixed(2)}%`);
    }

    // 回归：601816.SH 在 2024-12-24 的末端三买被后续笔延伸改写，旧实现
    // 会在 2024-12-27 用这个"幻影买点"入场；修复后不应再出现该笔交易。
    if (symbol === '601816.SH') {
      const phantom = output.result.trades.filter((trade) => trade.type === 'BUY' && trade.date === '2024-12-27');
      check(phantom.length === 0,
        `no entry on the vanished 2024-12-24 B3 (${phantom.map((t) => t.date).join(',') || 'none'})`);
    }

    // 回归：2025-09 至 2026 年上半年市场温度长期高于 70，旧实现会全年停止开仓。
    // 温度开关已整体移除，该区间内已确认的买点应能正常入场。
    if (symbol === '300750.SZ') {
      const hotBandBuy = output.result.trades.find((trade) =>
        trade.type === 'BUY' && trade.date >= '2025-10-01' && trade.date <= '2025-12-31');
      check(!!hotBandBuy, `confirmed B3 still fires after 2025-09 without the temperature switch (${hotBandBuy?.date ?? 'none'})`);
    }

    if (prefixSymbols.has(symbol)) validatePrefixInvariance(symbol, klines, output);
  }

  check(totalBuys > 0, `strategy produces at least one historical entry (${totalBuys})`);
  validateFutureFallback();
  for (const [name, values] of periodReturns) {
    const buyHoldValues = periodBuyHoldReturns.get(name) ?? [];
    console.log(`\nMedian ${name} return across ${values.length} symbols: strategy ${median(values).toFixed(2)}%, buy&hold ${median(buyHoldValues).toFixed(2)}%`);
  }
  console.log(`\nChecks: ${checks} passed; ${failures.length} failed.`);
  console.log(`Prefix invariance: ${prefixComparisons} cutoff runs compared.`);
  if (failures.length) {
    console.error('\nFailed checks:');
    for (const failure of failures) console.error(` - ${failure}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
