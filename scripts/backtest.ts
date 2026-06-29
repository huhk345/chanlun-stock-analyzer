import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock Vite's import.meta.env for Node.js/CLI environment
// @ts-ignore
import.meta.env = { DEV: false, MODE: 'production' };

// Mock localStorage for Node.js/CLI environment
if (typeof globalThis.localStorage === 'undefined') {
  // @ts-ignore
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    key: () => null,
    length: 0,
  };
}

import { userStrategies } from '../src/strategies/user/index.ts';
import { runBacktest } from '../src/utils/backtestRunner.ts';
import {
  calcAStockFees,
  isLimitUp,
  isLimitDown,
  resolveOrderShares,
  buildStrategyParams,
} from '../src/utils/strategyAdapter.ts';
import {
  mergeKlines,
  findFractions,
  calculateStrokes,
  calculateSegments,
  calculateHubs,
} from '../src/utils/chanlun.ts';
type Kline = import('../src/types/stock.ts').Kline;
import type { BacktestTradeSnapshot, UserStrategyDefinition, BacktestPositionState } from '../src/types/strategy.ts';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

interface StockPosition {
  symbol: string;
  shares: number;
  averageCost: number;
  trades: BacktestTradeSnapshot[];
}

interface PortfolioBacktestResult {
  startDate: string;
  endDate: string;
  initialCash: number;
  finalEquity: number;
  totalReturnPct: number;
  totalTrades: number;
  winningTrades: number;
  winRate: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  buyHoldReturnPct: number;
  totalFees: number;
  trades: Array<{
    date: string;
    symbol: string;
    action: 'BUY' | 'SELL';
    price: number;
    shares: number;
    value: number;
    fee: number;
    pnl?: number;
    pnlPct?: number;
    reason?: string;
  }>;
  equityCurve: number[];
  dates: string[];
}

// ---------------------------------------------------------------------------
// Helper: ChanLun snapshot builder
// ---------------------------------------------------------------------------

function buildChanLunCache(klines: readonly Kline[]) {
  const mutableKlines = [...klines];
  const merged = mergeKlines(mutableKlines);
  const fractions = findFractions(merged, mutableKlines);
  const strokes = calculateStrokes(fractions);
  const segments = calculateSegments(strokes);
  const hubs = calculateHubs(strokes);
  return { mergedKlines: merged, fractions, strokes, segments, hubs };
}

// ---------------------------------------------------------------------------
// Helper: calculate portfolio equity
// ---------------------------------------------------------------------------

function calculatePortfolioEquity(
  cash: number,
  positions: Map<string, StockPosition>,
  date: string,
  stockDataMap: Map<string, Kline[]>,
  stockDateIndex: Map<string, Map<string, number>>,
): number {
  let marketValue = 0;
  for (const [symbol, pos] of positions.entries()) {
    if (pos.shares <= 0) continue;
    const dateMap = stockDateIndex.get(symbol)!;
    const klineIdx = dateMap.get(date);
    if (klineIdx !== undefined) {
      marketValue += pos.shares * stockDataMap.get(symbol)![klineIdx].close;
    } else {
      // Use last known close price on or before this date
      const klines = stockDataMap.get(symbol)!;
      let lastClose = pos.averageCost;
      for (let i = klines.length - 1; i >= 0; i--) {
        if (klines[i].date <= date) {
          lastClose = klines[i].close;
          break;
        }
      }
      marketValue += pos.shares * lastClose;
    }
  }
  return cash + marketValue;
}

// ---------------------------------------------------------------------------
// Helper: check if a stock is on the main board (主板)
//   主板: 60xxxx (上海), 000xxx/002xxx/001xxx (深圳)
//   排除: 300xxx (创业板), 688xxx (科创板), 4x/8x (三板)
// ---------------------------------------------------------------------------

function isMainBoardStock(symbol: string): boolean {
  const code = symbol.replace(/\.(SS|SZ|SH|BJ)$/, '').trim();
  return /^(60|000|002|001)/.test(code);
}

// ---------------------------------------------------------------------------
// Portfolio Backtest Implementation
// ---------------------------------------------------------------------------

function runMultiStockBacktest(
  stockDataMap: Map<string, Kline[]>,
  startDate: string,
  endDate: string,
  initialCash: number,
  strategy: UserStrategyDefinition,
  strategyParams: Record<string, any>,
  warmupMonths: number = 6,
  mainBoardOnly: boolean = false,
): PortfolioBacktestResult {
  // Calculate warmup start date
  const warmupStartDate = (() => {
    const d = new Date(startDate);
    d.setMonth(d.getMonth() - warmupMonths);
    return d.toISOString().slice(0, 10);
  })();

  // Collect all unique trading dates across all stocks in sorted order
  const dateSet = new Set<string>();
  for (const klines of stockDataMap.values()) {
    for (const k of klines) {
      if (k.date >= warmupStartDate && k.date <= endDate) {
        dateSet.add(k.date);
      }
    }
  }
  const allDates = [...dateSet].sort();
  const tradingDates = allDates.filter((d) => d >= startDate && d <= endDate);

  if (tradingDates.length === 0) {
    return {
      startDate,
      endDate,
      initialCash,
      finalEquity: initialCash,
      totalReturnPct: 0,
      totalTrades: 0,
      winningTrades: 0,
      winRate: 0,
      maxDrawdownPct: 0,
      sharpeRatio: 0,
      buyHoldReturnPct: 0,
      totalFees: 0,
      trades: [],
      equityCurve: [],
      dates: [],
    };
  }

  // Build date-to-index map for each stock for fast lookup
  const stockDateIndex = new Map<string, Map<string, number>>();
  for (const [symbol, klines] of stockDataMap.entries()) {
    const m = new Map<string, number>();
    for (let i = 0; i < klines.length; i++) {
      m.set(klines[i].date, i);
    }
    stockDateIndex.set(symbol, m);
  }

  // Portfolio state
  let cash = initialCash;
  const positions = new Map<string, StockPosition>();
  let totalFees = 0;
  const allTrades: PortfolioBacktestResult['trades'] = [];

  const equityCurve: number[] = [];
  const equityCurveDates: string[] = [];
  let peakEquity = initialCash;
  let maxDrawdownPct = 0;
  let tradeCounter = 0;

  for (const date of allDates) {
    const isWarmup = date < startDate;

    // Compute current portfolio equity using today's price (or last close if not trading today)
    const currentEquity = calculatePortfolioEquity(cash, positions, date, stockDataMap, stockDateIndex);

    // Track equity and drawdown during trading period
    if (!isWarmup) {
      equityCurve.push(currentEquity);
      equityCurveDates.push(date);
      if (currentEquity > peakEquity) peakEquity = currentEquity;
      const dd = ((peakEquity - currentEquity) / peakEquity) * 100;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }

    // --- 1. Process SELL signals first ---
    for (const [symbol, pos] of positions.entries()) {
      if (pos.shares <= 0) continue;
      const dateMap = stockDateIndex.get(symbol)!;
      const klineIdx = dateMap.get(date);
      if (klineIdx === undefined) continue; // stock not trading today

      const klines = stockDataMap.get(symbol)!;
      const slice = klines.slice(0, klineIdx + 1);

      // Build ChanLun if strategy requires it
      const chanlun = strategy.requiresChanLun !== false ? buildChanLunCache(slice) : undefined;

      const positionState: BacktestPositionState = {
        shares: pos.shares,
        averageCost: pos.averageCost,
        marketValue: pos.shares * klines[klineIdx].close,
        unrealizedPnl: pos.shares * (klines[klineIdx].close - pos.averageCost),
        unrealizedPnlPercent: pos.averageCost > 0 ? ((klines[klineIdx].close - pos.averageCost) / pos.averageCost) * 100 : 0,
      };

      const strategyInput: any = {
        symbol,
        timeframe: 'daily',
        klines: slice,
        currentIndex: klineIdx,
        currentKline: klines[klineIdx],
        account: {
          initialCash,
          cash,
          equity: currentEquity,
          currency: 'CNY',
        },
        position: positionState,
        trades: pos.trades,
        params: strategyParams,
        chanlun,
        currency: 'CNY',
        initialCash,
      };

      let decision;
      try {
        decision = strategy.decide(strategyInput);
      } catch (err) {
        console.error(`Strategy error for ${symbol} on ${date}:`, err);
        decision = { action: 'HOLD' };
      }

      if (!isWarmup && decision && decision.action === 'SELL') {
        const { shares: sellShares, actualValue } = resolveOrderShares(
          decision,
          strategyInput.account,
          positionState,
          klines[klineIdx].close,
        );

        if (sellShares > 0) {
          if (isLimitDown(klines[klineIdx], klines, symbol)) {
            // Blocked by limit-down
            continue;
          }

          const fee = calcAStockFees(actualValue, false);
          totalFees += fee;
          cash += actualValue - fee;

          const costBasis = sellShares * pos.averageCost;
          const pnl = actualValue - costBasis - fee;
          const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

          const trade: BacktestTradeSnapshot = {
            id: `trade-${Date.now()}-${++tradeCounter}`,
            date,
            action: 'SELL',
            price: klines[klineIdx].close,
            shares: sellShares,
            value: actualValue,
            fee,
            reason: decision.reason,
          };
          pos.trades.push(trade);

          allTrades.push({
            date,
            symbol,
            action: 'SELL',
            price: klines[klineIdx].close,
            shares: sellShares,
            value: actualValue,
            fee,
            pnl,
            pnlPct,
            reason: decision.reason,
          });

          pos.shares -= sellShares;
          if (pos.shares <= 0) {
            pos.shares = 0;
            pos.averageCost = 0;
          }
        }
      }
    }

    // --- 2. Collect BUY signals ---
    const buySignals: Array<{
      symbol: string;
      decision: any;
      price: number;
      klineIdx: number;
    }> = [];

    if (!isWarmup) {
      for (const [symbol, klines] of stockDataMap.entries()) {
        const existingPos = positions.get(symbol);
        if (existingPos && existingPos.shares > 0) continue; // skip if already holding

        if (mainBoardOnly && !isMainBoardStock(symbol)) continue; // skip non-main-board

        const dateMap = stockDateIndex.get(symbol)!;
        const klineIdx = dateMap.get(date);
        if (klineIdx === undefined) continue; // stock not trading today

        const slice = klines.slice(0, klineIdx + 1);
        const chanlun = strategy.requiresChanLun !== false ? buildChanLunCache(slice) : undefined;

        const positionState: BacktestPositionState = {
          shares: 0,
          averageCost: 0,
          marketValue: 0,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
        };

        const strategyInput: any = {
          symbol,
          timeframe: 'daily',
          klines: slice,
          currentIndex: klineIdx,
          currentKline: klines[klineIdx],
          account: {
            initialCash,
            cash,
            equity: currentEquity,
            currency: 'CNY',
          },
          position: positionState,
          trades: existingPos?.trades ?? [],
          params: strategyParams,
          chanlun,
          currency: 'CNY',
          initialCash,
        };

        let decision;
        try {
          decision = strategy.decide(strategyInput);
        } catch (err) {
          console.error(`Strategy error for ${symbol} on ${date}:`, err);
          decision = { action: 'HOLD' };
        }

        if (decision && decision.action === 'BUY') {
          buySignals.push({
            symbol,
            decision,
            price: klines[klineIdx].close,
            klineIdx,
          });
        }
      }
    }

    // --- 3. Execute BUY signals with equal allocation ---
    if (buySignals.length > 0 && cash > 0) {
      const allocPerStock = cash / buySignals.length;

      for (const sig of buySignals) {
        const klines = stockDataMap.get(sig.symbol)!;
        const currentKline = klines[sig.klineIdx];

        if (isLimitUp(currentKline, klines, sig.symbol)) {
          // Blocked by limit-up
          continue;
        }

        const positionState: BacktestPositionState = {
          shares: 0,
          averageCost: 0,
          marketValue: 0,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
        };

        // Resolve order size based on allocated cash
        const mockAccount = {
          initialCash,
          cash: allocPerStock,
          equity: currentEquity,
          currency: 'CNY',
        };

        const { shares: buyShares, actualValue } = resolveOrderShares(
          sig.decision,
          mockAccount,
          positionState,
          sig.price,
        );

        if (buyShares > 0) {
          const fee = calcAStockFees(actualValue, true);
          if (actualValue + fee <= cash) {
            cash -= actualValue + fee;

            const pos = positions.get(sig.symbol) ?? { symbol: sig.symbol, shares: 0, averageCost: 0, trades: [] };
            const totalCost = pos.averageCost * pos.shares + actualValue;
            const totalShares = pos.shares + buyShares;
            pos.averageCost = totalShares > 0 ? totalCost / totalShares : 0;
            pos.shares = totalShares;

            const trade: BacktestTradeSnapshot = {
              id: `trade-${Date.now()}-${++tradeCounter}`,
              date,
              action: 'BUY',
              price: sig.price,
              shares: buyShares,
              value: actualValue,
              fee,
              reason: sig.decision.reason,
            };
            pos.trades.push(trade);
            positions.set(sig.symbol, pos);

            allTrades.push({
              date,
              symbol: sig.symbol,
              action: 'BUY',
              price: sig.price,
              shares: buyShares,
              value: actualValue,
              fee,
              reason: sig.decision.reason,
            });
          }
        }
      }
    }
  }

  // --- Calculate Results ---
  const finalEquity = equityCurve[equityCurve.length - 1] ?? initialCash;
  const totalReturnPct = ((finalEquity - initialCash) / initialCash) * 100;
  const totalTrades = allTrades.length;
  const sellTrades = allTrades.filter((t) => t.action === 'SELL');
  const winningTrades = sellTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = sellTrades.length > 0 ? (winningTrades / sellTrades.length) * 100 : 0;

  // Sharpe ratio
  let sharpeRatio = 0;
  if (equityCurve.length > 1) {
    const dailyReturns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      dailyReturns.push(equityCurve[i - 1] > 0 ? (equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1] : 0);
    }
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length;
    const std = Math.sqrt(variance);
    sharpeRatio = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  }

  // Buy & Hold comparison
  let buyHoldReturnPct = 0;
  const stockSymbols = [...stockDataMap.keys()];
  if (stockSymbols.length > 0) {
    let totalBhReturn = 0;
    let count = 0;
    for (const [symbol, klines] of stockDataMap.entries()) {
      const firstInRange = klines.find((k) => k.date >= startDate);
      const lastInRange = [...klines].reverse().find((k) => k.date <= endDate);
      if (firstInRange && lastInRange && firstInRange.close > 0) {
        totalBhReturn += ((lastInRange.close - firstInRange.close) / firstInRange.close) * 100;
        count++;
      }
    }
    buyHoldReturnPct = count > 0 ? totalBhReturn / count : 0;
  }

  return {
    startDate: tradingDates[0],
    endDate: tradingDates[tradingDates.length - 1],
    initialCash,
    finalEquity,
    totalReturnPct,
    totalTrades,
    winningTrades,
    winRate,
    maxDrawdownPct,
    sharpeRatio,
    buyHoldReturnPct,
    totalFees,
    trades: allTrades,
    equityCurve,
    dates: equityCurveDates,
  };
}

// ---------------------------------------------------------------------------
// Argument Parser Helper
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        options[key] = val;
        i++;
      } else {
        options[key] = 'true';
      }
    } else if (args[i].startsWith('-')) {
      const key = args[i].slice(1);
      const val = args[i + 1];
      if (val && !val.startsWith('-')) {
        options[key] = val;
        i++;
      } else {
        options[key] = 'true';
      }
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// CLI Help Printer
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`
缠论/通用策略回测框架 CLI 工具 (Generic Backtest CLI)
===================================================
用法:
  npx tsx scripts/backtest.ts --strategy <strategyId> --startDate <startDate> --endDate <endDate> [options]

必填参数:
  --strategy, -s    策略ID (可用值: ${userStrategies.map((s) => s.id).join(', ')})
  --startDate, -sd  回测开始日期 (格式: YYYY-MM-DD)
  --endDate, -ed    回测结束日期 (格式: YYYY-MM-DD)

可选参数:
  --cash, -c        初始资金 (默认: 1000000)
  --mode, -m        回测模式: portfolio (多股组合, 默认) | single (个股独立回测)
  --params, -p      JSON格式的参数覆盖 (例如: '{"fastPeriod":10,"slowPeriod":30}')
  --warmup, -w      策略计算所需的预热月份数 (默认: 6)
  --data, -d        合并CSV文件路径或个股CSV文件夹路径 (默认: data/  下所有CSV)
  --output, -o      结果输出文件夹 (默认: reports)
  --mainBoard       仅交易主板股票 (60xxxx/000xxx/002xxx/001xxx, 排除创业板/科创板)
  --help, -h        显示此帮助页面
  `);
}

// ---------------------------------------------------------------------------
// Main Executable Entry Point
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs();

  if (options.help || options.h || Object.keys(options).length === 0) {
    printHelp();
    process.exit(0);
  }

  // Validate required args
  const strategyId = options.strategy || options.s;
  const startDate = options.startDate || options.sd;
  const endDate = options.endDate || options.ed;

  if (!strategyId || !startDate || !endDate) {
    console.error('错误: 缺少必填参数 --strategy, --startDate 或 --endDate.');
    printHelp();
    process.exit(1);
  }

  // Load strategy
  const strategy = userStrategies.find((s) => s.id === strategyId);
  if (!strategy) {
    console.error(`错误: 未找到策略ID "${strategyId}". 可用策略: ${userStrategies.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  // Parse cash
  const cashStr = options.cash || options.c;
  const initialCash = cashStr ? parseFloat(cashStr) : 1_000_000;
  if (isNaN(initialCash) || initialCash <= 0) {
    console.error('错误: 初始资金必须为正数.');
    process.exit(1);
  }

  // Parse mode
  const mode = (options.mode || options.m || 'portfolio').toLowerCase();
  if (mode !== 'portfolio' && mode !== 'single') {
    console.error('错误: --mode 只能是 "portfolio" 或 "single".');
    process.exit(1);
  }

  // Parse warmup
  const warmupStr = options.warmup || options.w;
  const warmupMonths = warmupStr ? parseInt(warmupStr, 10) : 6;
  if (isNaN(warmupMonths) || warmupMonths < 0) {
    console.error('错误: 预热期月份数必须是大于等于 0 的整数.');
    process.exit(1);
  }

  // Parse params
  let customParams: Record<string, any> = {};
  const paramsStr = options.params || options.p;
  if (paramsStr) {
    try {
      customParams = JSON.parse(paramsStr);
    } catch (e: any) {
      console.error('错误: 无法解析 --params 中的 JSON 字符串:', e.message);
      process.exit(1);
    }
  }

  const strategyParams = buildStrategyParams(strategy, customParams);

  // Parse mainBoardOnly flag
  const mainBoardOnly = options.mainBoard !== undefined;

  // Parse data path (merged .csv file or directory of individual files)
  const dataPath = path.resolve(options.data || options.d || 'data');
  if (!fs.existsSync(dataPath)) {
    console.error(`错误: 数据路径不存在: ${dataPath}`);
    process.exit(1);
  }

  // Parse output directory
  const outputDir = path.resolve(options.output || options.o || 'reports');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Load K-line files
  console.log(`\n==================================================`);
  console.log(`  通用策略回测系统 (Generic Backtest CLI)`);
  console.log(`==================================================`);
  console.log(`策略名称:   ${strategy.name} (${strategy.id})`);
  console.log(`回测区间:   ${startDate} ~ ${endDate}`);
  console.log(`回测模式:   ${mode === 'portfolio' ? '多股组合组合回测 (Portfolio)' : '个股独立回测汇总 (Single)'}`);
  console.log(`初始资金:   ¥${initialCash.toLocaleString()}`);
  console.log(`数据路径:   ${dataPath}`);
  console.log(`主板限制:   ${mainBoardOnly ? '是 (仅交易主板股票)' : '否'}`);
  console.log(`策略参数:   ${JSON.stringify(strategyParams)}`);
  console.log(`--------------------------------------------------`);

  function parseKlineRecord(values: string[]): Kline | null {
    if (values.length < 6) return null;
    return {
      date: values[0],
      open: parseFloat(values[1]),
      high: parseFloat(values[2]),
      low: parseFloat(values[3]),
      close: parseFloat(values[4]),
      volume: parseInt(values[5], 10),
      amount: values.length > 6 ? parseFloat(values[6]) : 0,
    };
  }

  console.log(`正在加载 K 线数据...`);
  const stockDataMap = new Map<string, Kline[]>();

  const stat = fs.statSync(dataPath);
  if (stat.isFile()) {
    const raw = fs.readFileSync(dataPath, 'utf-8');
    const lines = raw.trim().split('\n');
    console.log(`发现合并 CSV 文件, 共 ${lines.length - 1} 条记录`);
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',');
      if (values.length < 7) continue;
      const symbol = values[0];
      const kline = parseKlineRecord(values.slice(1));
      if (!kline) continue;
      const arr = stockDataMap.get(symbol);
      if (arr) arr.push(kline);
      else stockDataMap.set(symbol, [kline]);
    }
    console.log(`解析完成: ${stockDataMap.size} 个股票`);
  } else if (stat.isDirectory()) {
    const files = fs.readdirSync(dataPath).filter((f) => f.endsWith('.csv'));
    console.log(`在目录下发现 ${files.length} 个合并 CSV 文件.`);
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dataPath, file), 'utf-8');
        const lines = raw.trim().split('\n');
        console.log(`  - ${file}: ${lines.length - 1} 条记录`);
        for (let i = 1; i < lines.length; i++) {
          const values = lines[i].split(',');
          if (values.length < 7) continue;
          const symbol = values[0];
          const kline = parseKlineRecord(values.slice(1));
          if (!kline) continue;
          const arr = stockDataMap.get(symbol);
          if (arr) arr.push(kline);
          else stockDataMap.set(symbol, [kline]);
        }
      } catch (err: any) {
        console.warn(`警告: 无法加载文件 ${file}: ${err.message}`);
      }
    }
    console.log(`解析完成: ${stockDataMap.size} 个股票`);
  }

  if (stockDataMap.size === 0) {
    console.error('错误: 没有成功加载任何股票 K 线数据.');
    process.exit(1);
  }

  const t0 = performance.now();

  // Executing backtest based on mode
  if (mode === 'portfolio') {
    console.log(`开始运行多股组合回测...`);
    const result = runMultiStockBacktest(stockDataMap, startDate, endDate, initialCash, strategy, strategyParams, warmupMonths, mainBoardOnly);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

    // Print to console
    console.log(`\n==================================================`);
    console.log(`  回测结果汇总 (多股组合模式)`);
    console.log(`==================================================`);
    console.log(`  回测区间:       ${result.startDate} ~ ${result.endDate}`);
    console.log(`  初始资金:       ¥${result.initialCash.toLocaleString()}`);
    console.log(`  期末权益:       ¥${result.finalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`  总收益率:       ${result.totalReturnPct.toFixed(2)}%`);
    console.log(`  最大回撤:       ${result.maxDrawdownPct.toFixed(2)}%`);
    console.log(`  夏普比率:       ${result.sharpeRatio.toFixed(2)}`);
    console.log(`  总交易次数:     ${result.totalTrades}`);
    console.log(`  盈利交易数:     ${result.winningTrades}`);
    console.log(`  交易胜率:       ${result.winRate.toFixed(1)}%`);
    console.log(`  总手续费:       ¥${result.totalFees.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`  等权买入持有:   ${result.buyHoldReturnPct.toFixed(2)}%`);
    console.log(`  回测耗时:       ${elapsed} 秒`);
    console.log(`==================================================\n`);

    // Output files
    const mdPath = path.join(outputDir, `backtest-${strategyId}-portfolio-${startDate}-${endDate}.md`);
    const tsvPath = path.join(outputDir, `backtest-trades-${strategyId}-portfolio-${startDate}-${endDate}.tsv`);

    // Generate trade table for MD
    const sellTrades = result.trades.filter((t) => t.action === 'SELL');

    let tradesMd = `### 交易历史明细 (前100笔)\n\n`;
    tradesMd += `| 日期 | 股票 | 方向 | 价格 | 数量 | 金额 | 费用 | 盈亏 (¥) | 盈亏 (%) | 原因 |\n`;
    tradesMd += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
    for (const t of result.trades.slice(0, 100)) {
      const pnlStr = t.pnl !== undefined ? t.pnl.toFixed(2) : '-';
      const pnlPctStr = t.pnlPct !== undefined ? `${t.pnlPct.toFixed(2)}%` : '-';
      tradesMd += `| ${t.date} | ${t.symbol} | ${t.action} | ${t.price.toFixed(2)} | ${t.shares} | ${t.value.toFixed(2)} | ${t.fee.toFixed(2)} | ${pnlStr} | ${pnlPctStr} | ${t.reason || ''} |\n`;
    }
    if (result.trades.length > 100) {
      tradesMd += `\n*... 还有 ${result.trades.length - 100} 笔交易，完整交易已写入 TSV 文件*\n`;
    }

    const mdContent = `
# 策略回测报告 (多股组合模式)
**策略:** ${strategy.name} (${strategy.id})  
**回测日期:** ${startDate} 至 ${endDate}  
**模式:** 多股组合资金池共享  

## 1. 核心绩效指标
| 指标 | 策略表现 | 备注 |
| --- | --- | --- |
| **初始资金** | ¥${result.initialCash.toLocaleString()} | - |
| **期末总权益** | ¥${result.finalEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | 现金 + 持仓市值 |
| **区间总收益率** | **${result.totalReturnPct.toFixed(2)}%** | 基准(等权买入持有): ${result.buyHoldReturnPct.toFixed(2)}% |
| **最大回撤** | ${result.maxDrawdownPct.toFixed(2)}% | 基于每日总资产计算 |
| **夏普比率** | ${result.sharpeRatio.toFixed(2)} | 年化指标 (252交易日) |
| **总交易次数** | ${result.totalTrades} | 包括买入和卖出 |
| **盈利交易数 / 卖出数** | ${result.winningTrades} / ${sellTrades.length} | 仅统计卖出平仓交易 |
| **交易胜率** | ${result.winRate.toFixed(1)}% | 盈利卖出次数 / 总卖出次数 |
| **总手续费** | ¥${result.totalFees.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | 包含佣金、印花税、过户费 |

## 2. 策略配置参数
\`\`\`json
${JSON.stringify(strategyParams, null, 2)}
\`\`\`

## 3. 交易汇总与统计
${tradesMd}
`;
    fs.writeFileSync(mdPath, mdContent.trim(), 'utf-8');
    console.log(`[报告保存] Markdown 报告已写入: ${mdPath}`);

    // Generate TSV file
    let tsvContent = `date\tsymbol\taction\tprice\tshares\tvalue\tfee\tpnl\tpnlPct\treason\n`;
    for (const t of result.trades) {
      const pnlStr = t.pnl !== undefined ? t.pnl.toFixed(4) : '';
      const pnlPctStr = t.pnlPct !== undefined ? t.pnlPct.toFixed(4) : '';
      tsvContent += `${t.date}\t${t.symbol}\t${t.action}\t${t.price}\t${t.shares}\t${t.value}\t${t.fee}\t${pnlStr}\t${pnlPctStr}\t${t.reason || ''}\n`;
    }
    fs.writeFileSync(tsvPath, tsvContent, 'utf-8');
    console.log(`[明细保存] 完整交易明细已写入 (TSV): ${tsvPath}\n`);

  } else if (mode === 'single') {
    console.log(`开始对 ${stockDataMap.size} 只股票运行独立的个股回测...`);

    const singleResults: Array<{
      symbol: string;
      totalReturnPct: number;
      sharpeRatio: number;
      maxDrawdownPct: number;
      totalTrades: number;
      winRate: number;
      finalBalance: number;
    }> = [];

    let totalTradesAcrossStocks = 0;
    let totalFeesAcrossStocks = 0;
    const allSingleTrades: Array<{
      symbol: string;
      date: string;
      action: 'BUY' | 'SELL';
      price: number;
      shares: number;
      value: number;
      fee: number;
      pnl?: number;
      pnlPercent?: number;
      signalType?: string;
    }> = [];

    let processedCount = 0;
    const symbols = [...stockDataMap.keys()];

    for (const symbol of symbols) {
      processedCount++;
      const klines = stockDataMap.get(symbol)!;
      const testKlines = klines.filter((k) => k.date <= endDate);

      if (testKlines.length === 0) continue;

      const backtestInput = {
        klines: testKlines,
        symbol,
        userId: 'cli-user',
        initialCash,
        currency: 'CNY',
        strategy,
        params: strategyParams,
        mainBoardOnly,
      };

      try {
        const { result } = runBacktest(backtestInput);
        
        // Filter trades to start after startDate
        const validTrades = result.trades.filter((t) => t.date >= startDate);

        // Calculate performance from valid trades
        const validFees = validTrades.reduce((sum, t) => sum + (t.fee || 0), 0);
        const sellTrades = validTrades.filter((t) => t.type === 'SELL');
        const winningTrades = sellTrades.filter((t) => (t.pnl ?? 0) > 0).length;
        const winRate = sellTrades.length > 0 ? (winningTrades / sellTrades.length) * 100 : 0;

        singleResults.push({
          symbol,
          totalReturnPct: result.totalReturnPercent,
          sharpeRatio: result.sharpeRatio,
          maxDrawdownPct: 0,
          totalTrades: validTrades.length,
          winRate,
          finalBalance: result.finalBalance,
        });

        totalTradesAcrossStocks += validTrades.length;
        totalFeesAcrossStocks += validFees;

        for (const t of validTrades) {
          allSingleTrades.push({
            symbol,
            date: t.date,
            action: t.type,
            price: t.price,
            shares: t.shares,
            value: t.value,
            fee: t.fee || 0,
            pnl: t.pnl,
            pnlPercent: t.pnlPercent,
            signalType: t.signalType,
          });
        }
      } catch (err: any) {
        console.error(`警告: 运行股票 ${symbol} 回测失败: ${err.message}`);
      }

      if (processedCount % 50 === 0 || processedCount === symbols.length) {
        console.log(`进度: 已完成 ${processedCount} / ${symbols.length} 只股票.`);
      }
    }

    if (singleResults.length === 0) {
      console.error('错误: 没有一个股票回测运行成功.');
      process.exit(1);
    }

    // Sort by return descending
    singleResults.sort((a, b) => b.totalReturnPct - a.totalReturnPct);

    // Calculate aggregated metrics
    const avgReturn = singleResults.reduce((sum, r) => sum + r.totalReturnPct, 0) / singleResults.length;
    const medianReturn = singleResults[Math.floor(singleResults.length / 2)].totalReturnPct;
    const winningStocksCount = singleResults.filter((r) => r.totalReturnPct > 0).length;
    const stockWinRate = (winningStocksCount / singleResults.length) * 100;
    const avgTrades = totalTradesAcrossStocks / singleResults.length;
    const avgSharpe = singleResults.reduce((sum, r) => sum + r.sharpeRatio, 0) / singleResults.length;

    const elapsed = ((performance.now() - t0) / 1000).toFixed(2);

    console.log(`\n==================================================`);
    console.log(`  回测结果汇总 (个股独立回测模式)`);
    console.log(`==================================================`);
    console.log(`  股票总数:       ${singleResults.length}`);
    console.log(`  个股平均收益:   ${avgReturn.toFixed(2)}%`);
    console.log(`  个股中位数收益: ${medianReturn.toFixed(2)}%`);
    console.log(`  取得正收益比例: ${stockWinRate.toFixed(1)}% (${winningStocksCount}/${singleResults.length})`);
    console.log(`  个股平均夏普:   ${avgSharpe.toFixed(2)}`);
    console.log(`  总计交易次数:   ${totalTradesAcrossStocks}`);
    console.log(`  个股平均交易:   ${avgTrades.toFixed(1)}`);
    console.log(`  总计交易费用:   ¥${totalFeesAcrossStocks.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    console.log(`  表现最好个股:   ${singleResults[0].symbol} (${singleResults[0].totalReturnPct.toFixed(2)}%)`);
    console.log(`  表现最差个股:   ${singleResults[singleResults.length - 1].symbol} (${singleResults[singleResults.length - 1].totalReturnPct.toFixed(2)}%)`);
    console.log(`  回测总耗时:     ${elapsed} 秒`);
    console.log(`==================================================\n`);

    // Output files
    const mdPath = path.join(outputDir, `backtest-${strategyId}-single-${startDate}-${endDate}.md`);
    const tsvPath = path.join(outputDir, `backtest-trades-${strategyId}-single-${startDate}-${endDate}.tsv`);

    // Generate MD list of top 30 and bottom 30 stocks
    let topStockList = `### 个股表现排行 (前30名)\n\n| 排名 | 股票 | 收益率 (%) | 交易次数 | 胜率 (%) | 期末价值 |\n| --- | --- | --- | --- | --- | --- |\n`;
    for (let i = 0; i < Math.min(30, singleResults.length); i++) {
      const r = singleResults[i];
      topStockList += `| ${i + 1} | ${r.symbol} | ${r.totalReturnPct.toFixed(2)}% | ${r.totalTrades} | ${r.winRate.toFixed(1)}% | ¥${r.finalBalance.toLocaleString()} |\n`;
    }

    let bottomStockList = `### 个股表现排行 (末30名)\n\n| 排名 | 股票 | 收益率 (%) | 交易次数 | 胜率 (%) | 期末价值 |\n| --- | --- | --- | --- | --- | --- |\n`;
    const startIdx = Math.max(0, singleResults.length - 30);
    for (let i = startIdx; i < singleResults.length; i++) {
      const r = singleResults[i];
      bottomStockList += `| ${i + 1} | ${r.symbol} | ${r.totalReturnPct.toFixed(2)}% | ${r.totalTrades} | ${r.winRate.toFixed(1)}% | ¥${r.finalBalance.toLocaleString()} |\n`;
    }

    const mdContent = `
# 策略回测报告 (个股独立回测模式)
**策略:** ${strategy.name} (${strategy.id})  
**回测日期:** ${startDate} 至 ${endDate}  
**模式:** 个股分配独立资金池回测汇总

## 1. 核心绩效指标
| 指标 | 汇总表现 | 备注 |
| --- | --- | --- |
| **参与回测股票数** | ${singleResults.length} 只 | - |
| **单股初始资金** | ¥${initialCash.toLocaleString()} | 每只股票回测的独立本金 |
| **个股平均收益率** | **${avgReturn.toFixed(2)}%** | 所有个股收益率的简单算术平均 |
| **个股中位数收益率** | **${medianReturn.toFixed(2)}%** | 中位数收益率 |
| **盈利股票比例** | **${stockWinRate.toFixed(1)}%** | ${winningStocksCount} 只取得正收益 / 共 ${singleResults.length} 只 |
| **平均个股夏普比率** | ${avgSharpe.toFixed(2)} | 所有个股夏普比率的平均 |
| **总计交易次数** | ${totalTradesAcrossStocks} 次 | 所有个股交易次数之和 |
| **个股平均交易次数** | ${avgTrades.toFixed(1)} 次 | 单只股票平均发生交易数 |
| **总计手续费支出** | ¥${totalFeesAcrossStocks.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} | 所有交易的手续费汇总 |

## 2. 策略配置参数
\`\`\`json
${JSON.stringify(strategyParams, null, 2)}
\`\`\`

## 3. 个股排名明细
${topStockList}

${bottomStockList}
`;
    fs.writeFileSync(mdPath, mdContent.trim(), 'utf-8');
    console.log(`[报告保存] Markdown 报告已写入: ${mdPath}`);

    // Generate TSV file of all trades across all stocks
    let tsvContent = `symbol\tdate\taction\tprice\tshares\tvalue\tfee\tpnl\tpnlPct\treason\n`;
    for (const t of allSingleTrades) {
      const pnlStr = t.pnl !== undefined ? t.pnl.toFixed(4) : '';
      const pnlPctStr = t.pnlPercent !== undefined ? t.pnlPercent.toFixed(4) : '';
      tsvContent += `${t.symbol}\t${t.date}\t${t.action}\t${t.price}\t${t.shares}\t${t.value}\t${t.fee}\t${pnlStr}\t${pnlPctStr}\t${t.signalType || ''}\n`;
    }
    fs.writeFileSync(tsvPath, tsvContent, 'utf-8');
    console.log(`[明细保存] 完整个股交易明细已写入 (TSV): ${tsvPath}\n`);
  }

  console.log(`回测任务运行成功！结果报告和明细已输出到 ${outputDir} 目录.`);
}

main().catch((err) => {
  console.error('回测出现未捕获异常:', err);
  process.exit(1);
});
