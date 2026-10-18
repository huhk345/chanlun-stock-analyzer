/**
 * 回测可靠性验证脚本 —— 无未来数据 (no look-ahead) / 信号当根收盘价成交 / T+1 / 涨跌停 / 止损。
 *
 * 用法:
 *   pnpm exec tsx scripts/test-backtest-causality.ts
 *   pnpm exec tsx scripts/test-backtest-causality.ts --symbols 600519.SH,000001.SZ --bars 420 --cuts 5
 *   pnpm exec tsx scripts/test-backtest-causality.ts --no-real     # 只跑合成数据用例 (不读取行情)
 *
 * 验证的核心思想:
 *
 *   1) 前缀不变性 (prefix invariance) —— 检测未来数据的标准工具:
 *      用 klines[0..c] 单独跑一次回测, 其结果必须与「全量数据回测中截止第 c 根的
 *      全部成交与权益」逐笔一致。只要任何环节 (策略 / 指标 / 缠论 / 引擎) 用到
 *      第 c 根之后的数据, 截断后的结果必然不同。
 *
 *   2) 成交时点 / 价格 / 规则 —— 用构造的合成 K 线逐条断言:
 *      - 信号当根收盘价成交 (尾盘/收盘竞价模型, 价格 = 当根 close);
 *      - T+1: 盘中止损在当日买入成交之前执行, 不会当日买入又当日卖出;
 *      - 盘中止损: 触及按止损价成交, 跳空低开按开盘价, 一字跌停顺延;
 *      - 收盘封涨停无法按收盘价买入 / 收盘封跌停无法按收盘价卖出;
 *      - 确定性: 同样输入两次运行结果完全一致;
 *      - 一致性: 单步回测 (createBacktestStepper) 与批量回测 (runBacktest) 逐笔一致。
 *
 *   3) 账本不变量 —— 真实行情全量回测:
 *      - 成交价必落在当日 [low, high] 区间内;
 *      - 现金全程不为负, 持仓不为负, 卖出不超过持有;
 *      - 期末现金 + 持仓市值 == 期末权益 == 权益曲线最后一根。
 */

import { installLocalStorageShim } from '../server/localStorageShim.ts';

// 回测引擎间接依赖 localStorage (用户指标本地存储), Node.js 下先安装空 shim
installLocalStorageShim();

import { runBacktest } from '../src/utils/backtestRunner.ts';
import { createBacktestStepper } from '../src/utils/backtestStepper.ts';
import { loadStrategies } from '../src/strategies/user/index.ts';
import { getKlines } from '../server/klines.ts';
import type { Kline, BacktestTrade } from '../src/types/stock.ts';
import type { UserStrategyDefinition, UserStrategyDecision } from '../src/types/strategy.ts';

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------

const failures: string[] = [];
let passedChecks = 0;

/** 真实行情用例的初始资金: 需覆盖高价股 1 手 (100 股), 例如贵州茅台 ~¥1500 → 15 万/手 */
const REAL_INITIAL_CASH = 500_000;

function check(cond: boolean, label: string): void {
  if (cond) {
    passedChecks++;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function approx(a: number, b: number, eps = 1e-6): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
}

function section(title: string): void {
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  ${title}`);
  console.log(`──────────────────────────────────────────────`);
}

function parseArgs(): Record<string, string> {
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
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// 合成 K 线 & 探针策略
// ---------------------------------------------------------------------------

interface BarSpec {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

function makeKlines(specs: BarSpec[]): Kline[] {
  return specs.map((s) => ({
    date: s.date,
    open: s.open,
    high: s.high,
    low: s.low,
    close: s.close,
    volume: 100_000,
    amount: 100_000 * s.close,
  }));
}

function day(i: number): string {
  // 2024-01-01 + i 天 (只用于构造唯一且可排序的日期)
  const d = new Date(Date.UTC(2024, 0, 1 + i));
  return d.toISOString().slice(0, 10);
}

/** 在指定索引收盘发出 BUY / SELL 的探针策略 (仅依赖 currentIndex 与持仓) */
function makeProbeStrategy(buyAt: number[], sellAt: number[]): UserStrategyDefinition {
  return {
    id: 'probe',
    name: 'Probe',
    decide({ currentIndex, position }): UserStrategyDecision {
      if (buyAt.includes(currentIndex) && position.shares === 0) {
        return { action: 'BUY', amount: { unit: 'percent', value: 100 }, reason: `probe buy @${currentIndex}` };
      }
      if (sellAt.includes(currentIndex) && position.shares > 0) {
        return { action: 'SELL', amount: { unit: 'percent', value: 100 }, reason: `probe sell @${currentIndex}` };
      }
      return { action: 'HOLD' };
    },
  };
}

function runSynthetic(
  klines: Kline[],
  strategy: UserStrategyDefinition,
  stopLossPercent?: number,
) {
  return runBacktest({
    klines,
    symbol: '600000.SH',
    userId: 'test',
    initialCash: 100_000,
    currency: 'CNY',
    strategy,
    stopLossPercent,
  });
}

// ---------------------------------------------------------------------------
// 合成用例
// ---------------------------------------------------------------------------

function testSameBarCloseExecution(): void {
  section('合成用例 1: 信号当根收盘价成交 (尾盘模型, 价格 = 当根 close)');
  const specs: BarSpec[] = [];
  for (let i = 0; i < 30; i++) {
    specs.push({
      date: day(i),
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 100.5 + i,
    });
  }
  const klines = makeKlines(specs);
  const strategy = makeProbeStrategy([9], [15]);
  const { result } = runSynthetic(klines, strategy);
  const trades = result.trades;

  check(trades.length === 2, `恰好 2 笔成交 (实际 ${trades.length})`);
  if (trades.length >= 2) {
    const buy = trades[0];
    const sell = trades[1];
    check(
      buy.type === 'BUY' && buy.date === klines[9].date && approx(buy.price, klines[9].close),
      `BUY 在第 9 根 (信号当根) 按收盘价 ${klines[9].close} 成交 (实际 ${buy.date} @ ${buy.price})`,
    );
    check(
      sell.type === 'SELL' && sell.date === klines[15].date && approx(sell.price, klines[15].close),
      `SELL 在第 15 根 (信号当根) 按收盘价 ${klines[15].close} 成交 (实际 ${sell.date} @ ${sell.price})`,
    );
    check(
      !approx(buy.price, klines[9].open) && !approx(sell.price, klines[15].open),
      '成交价使用收盘价 (不是当根开盘价 / 次日价格)',
    );
  }
}

function testT1NoSameDayStop(): void {
  section('合成用例 2: T+1 —— 盘中止损在当日买入之前执行, 不会当日买入又当日卖出');
  const klines = makeKlines([
    { date: day(0), open: 100, high: 101, low: 80, close: 100 },    // 信号当根收盘买入 @100; 当日低点 80 破止损 90 也不可卖
    { date: day(1), open: 95, high: 96, low: 85, close: 90 },       // 隔日: 盘中触及 90 → 止损按 90 成交
  ]);
  const strategy = makeProbeStrategy([0], []);
  const { result } = runSynthetic(klines, strategy, 10);
  const trades = result.trades;

  const day0Trades = trades.filter((t) => t.date === klines[0].date);
  check(
    day0Trades.length === 1 && day0Trades[0].type === 'BUY' && approx(day0Trades[0].price, 100),
    '第 0 根只有买入成交 (收盘价 100), 当日低点破止损不触发当日卖出',
  );
  const sell = trades.find((t) => t.type === 'SELL');
  check(
    !!sell && sell.date === klines[1].date && sell.signalType === 'stop-loss' && approx(sell.price, 90),
    `第 1 根按止损价 90 成交 (实际 ${sell?.date} @ ${sell?.price})`,
  );
}

function testStopGapFillAtOpen(): void {
  section('合成用例 3: 止损跳空低开 → 按开盘价成交 (不按止损价)');
  const klines = makeKlines([
    { date: day(0), open: 100, high: 101, low: 99, close: 100 },    // 信号当根收盘买入 @100, 止损价 90
    { date: day(1), open: 85, high: 92, low: 84, close: 86 },       // 跳空低开 85 < 止损 90 → 按 85 成交
  ]);
  const strategy = makeProbeStrategy([0], []);
  const { result } = runSynthetic(klines, strategy, 10);
  const sell = result.trades.find((t) => t.type === 'SELL');
  check(
    !!sell && sell.date === klines[1].date && approx(sell.price, 85),
    `按跳空开盘价 85 成交 (实际 ${sell?.date} @ ${sell?.price})`,
  );
}

function testStopLimitDownDeferred(): void {
  section('合成用例 4: 一字跌停无法卖出 → 止损顺延到下一交易日');
  const klines = makeKlines([
    { date: day(0), open: 100, high: 101, low: 99, close: 100 },    // 信号当根收盘买入 @100, 止损价 90
    { date: day(1), open: 90, high: 90, low: 90, close: 90 },       // 一字跌停 (前收 100 → 跌停价 90)
    { date: day(2), open: 85, high: 88, low: 84, close: 86 },       // 顺延: 跳空 → 按 85 成交
  ]);
  const strategy = makeProbeStrategy([0], []);
  const { result } = runSynthetic(klines, strategy, 10);
  const trades = result.trades;

  check(
    trades.filter((t) => t.date === klines[1].date).length === 0,
    '一字跌停日没有任何成交',
  );
  const sell = trades.find((t) => t.type === 'SELL');
  check(
    !!sell && sell.date === klines[2].date && approx(sell.price, 85),
    `止损顺延至下一交易日按 85 成交 (实际 ${sell?.date} @ ${sell?.price})`,
  );
}

function testLimitUpBlocksBuy(): void {
  section('合成用例 5: 信号当根收盘封涨停 → 无法按收盘价买入, 交易作废');
  const klines = makeKlines([
    { date: day(0), open: 100, high: 101, low: 99, close: 100 },
    { date: day(1), open: 110, high: 110, low: 110, close: 110 },   // 前收 100 → 涨停价 110, 全天封死
  ]);
  const strategy = makeProbeStrategy([1], []);
  const { result, diagnostics } = runSynthetic(klines, strategy);
  check(result.trades.length === 0, `0 笔成交 (实际 ${result.trades.length})`);
  check(
    diagnostics.some((d) => d.message.includes('涨停')),
    '产生「涨停无法买入」诊断',
  );
}

function testLimitDownBlocksSell(): void {
  section('合成用例 6: 信号当根收盘封跌停 → 无法按收盘价卖出, 交易作废');
  const klines = makeKlines([
    { date: day(0), open: 100, high: 101, low: 99, close: 100 },    // 信号当根收盘买入 @100
    { date: day(1), open: 90, high: 90, low: 90, close: 90 },       // 前收 100 → 跌停价 90, 全天封死
  ]);
  const strategy = makeProbeStrategy([0], [1]);
  const { result, diagnostics } = runSynthetic(klines, strategy);
  const buys = result.trades.filter((t) => t.type === 'BUY');
  const sells = result.trades.filter((t) => t.type === 'SELL');
  check(buys.length === 1 && sells.length === 0, `仅 1 笔买入、0 笔卖出 (实际 ${buys.length}/${sells.length})`);
  check(
    diagnostics.some((d) => d.message.includes('跌停')),
    '产生「跌停无法卖出」诊断',
  );
}

function testDeterminism(): void {
  section('合成用例 7: 确定性 —— 同输入两次运行完全一致');
  const klines = makeKlines(
    Array.from({ length: 40 }, (_, i) => ({
      date: day(i),
      open: 100 + i,
      high: 102 + i,
      low: 99 + i,
      close: 100.5 + i,
    })),
  );
  const strategy = makeProbeStrategy([5, 20], [10, 30]);
  const a = runSynthetic(klines, strategy, 15);
  const b = runSynthetic(klines, strategy, 15);
  const strip = (t: BacktestTrade) =>
    `${t.date}|${t.type}|${t.price.toFixed(8)}|${t.shares}|${t.value.toFixed(8)}|${(t.fee ?? 0).toFixed(8)}|${t.signalType}`;
  check(
    JSON.stringify(a.result.trades.map(strip)) === JSON.stringify(b.result.trades.map(strip)),
    '两次运行逐笔成交一致',
  );
  check(
    JSON.stringify(a.equityCurve) === JSON.stringify(b.equityCurve),
    '两次运行权益曲线一致',
  );
  check(
    approx(a.result.finalBalance, a.equityCurve?.[a.equityCurve.length - 1] ?? NaN),
    '期末权益 == 权益曲线最后一根',
  );
}

function testStepperNavigation(): void {
  section('合成用例 8: 单步回测 前进/后退/跳转 状态一致 (导航不破坏账本)');
  const klines = makeKlines(
    Array.from({ length: 40 }, (_, i) => ({
      date: day(i),
      open: 100 + (i % 5) * 2 + i * 0.1,
      high: 104 + (i % 5) * 2 + i * 0.1,
      low: 97 + (i % 5) * 2 + i * 0.1,
      close: 101 + (i % 3) * 2 + i * 0.1,
    })),
  );
  const strategy = makeProbeStrategy([5, 20], [10, 30]);
  const makeStepper = () =>
    createBacktestStepper({
      klines,
      symbol: '600000.SH',
      userId: 'test',
      initialCash: 100_000,
      currency: 'CNY',
      strategy,
      stopLossPercent: 15,
    });

  const stepper = makeStepper();
  stepper.start();
  const s1 = stepper.stepForward();
  const s2 = stepper.stepForward();
  const s3 = stepper.stepForward();

  // 后退一步再前进一步: 状态必须与首次到达完全一致
  const back2 = stepper.stepBackward();
  check(
    back2.currentStepIndex === 2 && JSON.stringify(back2.accountAfter) === JSON.stringify(s2.accountAfter),
    '后退到第 2 步的账户状态与前进时一致',
  );
  const fwd3 = stepper.stepForward();
  check(
    fwd3.currentStepIndex === 3 && JSON.stringify(fwd3.accountAfter) === JSON.stringify(s3.accountAfter),
    '再前进到第 3 步的账户状态与首次到达一致',
  );

  // 跳转回退
  const jump1 = stepper.jumpTo(1);
  check(
    jump1.currentStepIndex === 1 && JSON.stringify(jump1.accountAfter) === JSON.stringify(s1.accountAfter),
    'jumpTo(1) 回退状态与首次到达一致',
  );

  // 跳转到未来, 与逐步前进比较
  const jump9 = stepper.jumpTo(9);
  const stepper2 = makeStepper();
  stepper2.start();
  for (let i = 0; i < 9; i++) stepper2.stepForward();
  check(
    JSON.stringify(jump9.accountAfter) === JSON.stringify(stepper2.getCurrentState().accountAfter),
    'jumpTo(9) 与逐步前进到第 9 步状态一致',
  );

  // 导航后 runAll 的最终成交必须与全新实例 runAll 完全一致
  const navOut = stepper.runAll();
  const fresh = makeStepper();
  fresh.start();
  const freshOut = fresh.runAll();
  const strip = (t: BacktestTrade) =>
    `${t.date}|${t.type}|${t.price.toFixed(8)}|${t.shares}|${t.value.toFixed(8)}|${t.signalType}`;
  check(
    JSON.stringify(navOut.result.trades.map(strip)) === JSON.stringify(freshOut.result.trades.map(strip)),
    '经过前进/后退/跳转后 runAll 的成交与全新实例完全一致',
  );
}

// ---------------------------------------------------------------------------
// 真实行情: 前缀不变性 (未来数据检测)
// ---------------------------------------------------------------------------

const stripTrade = (t: BacktestTrade) =>
  `${t.date}|${t.type}|${t.price.toFixed(6)}|${t.shares}|${t.value.toFixed(6)}|` +
  `${(t.fee ?? 0).toFixed(6)}|${t.signalType}|${(t.pnl ?? 0).toFixed(6)}|${(t.pnlPercent ?? 0).toFixed(6)}`;

function pickCuts(n: number, count: number): number[] {
  const ratios = [0.4, 0.55, 0.7, 0.8, 0.88, 0.94];
  const cuts = ratios
    .slice(0, Math.max(1, count - 1))
    .map((r) => Math.round(n * r))
    .concat(n - 2);
  const uniq = [...new Set(cuts)].filter((c) => c > 20 && c < n - 1);
  return uniq.sort((a, b) => a - b);
}

interface RealRunConfig {
  symbol: string;
  strategy: UserStrategyDefinition;
  stopLossPercent?: number;
  label: string;
}

function testPrefixInvariance(allKlines: Kline[], cfg: RealRunConfig, cutCount: number): void {
  const makeInput = (klines: Kline[]) => ({
    klines,
    symbol: cfg.symbol,
    userId: 'test',
    initialCash: REAL_INITIAL_CASH,
    currency: 'CNY',
    strategy: cfg.strategy,
    stopLossPercent: cfg.stopLossPercent,
  });

  const full = runBacktest(makeInput(allKlines));
  const cuts = pickCuts(allKlines.length, cutCount);

  const stCount = full.result.trades.filter((t) => t.signalType === 'stop-loss').length;
  console.log(`  · ${cfg.label}: 全量 ${full.result.trades.length} 笔成交 (含 ${stCount} 笔止损)`);

  for (const c of cuts) {
    const prefix = runBacktest(makeInput(allKlines.slice(0, c + 1)));
    const cutoffDate = allKlines[c].date;

    const expected = full.result.trades.filter((t) => t.date <= cutoffDate).map(stripTrade);
    const got = prefix.result.trades.map(stripTrade);

    const tradesOk = JSON.stringify(expected) === JSON.stringify(got);
    check(
      tradesOk,
      `${cfg.label} cut=${c} (${cutoffDate}): 截断回测成交与全量一致 (期望 ${expected.length} 笔, 实际 ${got.length} 笔)`,
    );
    if (!tradesOk) {
      for (let i = 0; i < Math.max(expected.length, got.length); i++) {
        if (expected[i] !== got[i]) {
          console.log(`      第一处差异 #${i}: 期望 ${expected[i] ?? '(无)'} / 实际 ${got[i] ?? '(无)'}`);
          break;
        }
      }
    }

    const expectedEquity = full.equityCurve?.[c] ?? NaN;
    check(
      approx(prefix.result.finalBalance, expectedEquity, 1e-6),
      `${cfg.label} cut=${c}: 截断期末权益 ${prefix.result.finalBalance.toFixed(4)} == 全量当日权益 ${expectedEquity.toFixed(4)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 真实行情: 账本不变量
// ---------------------------------------------------------------------------

function testInvariants(allKlines: Kline[], cfg: RealRunConfig): void {
  const run = runBacktest({
    klines: allKlines,
    symbol: cfg.symbol,
    userId: 'test',
    initialCash: REAL_INITIAL_CASH,
    currency: 'CNY',
    strategy: cfg.strategy,
    stopLossPercent: cfg.stopLossPercent,
  });

  const barByDate = new Map(allKlines.map((k) => [k.date, k]));
  let cash = REAL_INITIAL_CASH;
  let shares = 0;
  let priceInRange = true;
  let noNegativeCash = true;
  let noNegativeShares = true;

  for (const t of run.result.trades) {
    const bar = barByDate.get(t.date);
    if (!bar) {
      priceInRange = false;
      continue;
    }
    if (t.price < bar.low - 1e-9 || t.price > bar.high + 1e-9) priceInRange = false;
    if (t.type === 'BUY') {
      cash -= t.value + (t.fee ?? 0);
      shares += t.shares;
    } else {
      cash += t.value - (t.fee ?? 0);
      shares -= t.shares;
    }
    if (cash < -1e-6) noNegativeCash = false;
    if (shares < 0) noNegativeShares = false;
  }

  const lastClose = allKlines[allKlines.length - 1].close;
  const finalCheck = approx(cash + shares * lastClose, run.result.finalBalance, 1e-6);

  check(priceInRange, `${cfg.label}: 全部成交价落在当日 [low, high] 区间内`);
  check(noNegativeCash, `${cfg.label}: 现金全程不为负 (含手续费)`);
  check(noNegativeShares, `${cfg.label}: 持仓不为负, 卖出不超过持有 (长仓)`);
  check(finalCheck, `${cfg.label}: 期末现金+持仓市值 == 期末权益`);
  check(
    run.equityCurve?.length === allKlines.length,
    `${cfg.label}: 权益曲线长度 == K 线根数 (${run.equityCurve?.length}/${allKlines.length})`,
  );
  check(
    approx(run.result.finalBalance, run.equityCurve?.[run.equityCurve.length - 1] ?? NaN),
    `${cfg.label}: 期末权益 == 权益曲线最后一根`,
  );
}

// ---------------------------------------------------------------------------
// 真实行情: 单步回测 与 批量回测 一致性
// ---------------------------------------------------------------------------

function testStepperParity(allKlines: Kline[], cfg: RealRunConfig): void {
  const common = {
    klines: allKlines,
    symbol: cfg.symbol,
    userId: 'test',
    initialCash: REAL_INITIAL_CASH,
    currency: 'CNY',
    strategy: cfg.strategy,
    stopLossPercent: cfg.stopLossPercent,
  };

  const runnerOut = runBacktest(common);
  const stepper = createBacktestStepper(common);
  stepper.start();
  const stepperOut = stepper.runAll();

  const a = runnerOut.result.trades.map(stripTrade);
  const b = stepperOut.result.trades.map(stripTrade);
  const same = JSON.stringify(a) === JSON.stringify(b);
  check(same, `${cfg.label}: 单步回测与批量回测逐笔一致 (${a.length} 笔 vs ${b.length} 笔)`);
  if (!same) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log(`      第一处差异 #${i}: runner ${a[i] ?? '(无)'} / stepper ${b[i] ?? '(无)'}`);
        break;
      }
    }
  }
  check(
    approx(stepperOut.result.finalBalance, runnerOut.result.finalBalance, 1e-6),
    `${cfg.label}: 单步回测与批量回测期末权益一致`,
  );
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function loadRealKlines(symbols: string[], bars: number): Promise<Map<string, Kline[]>> {
  const out = new Map<string, Kline[]>();
  for (const s of symbols) {
    try {
      const res = await getKlines(s, '1d', bars, 'forward', false);
      if (res.klines.length >= 150) {
        out.set(s, res.klines);
      } else {
        console.warn(`  ⚠ 跳过 ${s}: 数据不足 (${res.klines.length} 根)`);
      }
    } catch (err) {
      console.warn(`  ⚠ 跳过 ${s}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs();
  const noReal = options['no-real'] !== undefined || options.noreal !== undefined;
  const symbols = (options.symbols ? String(options.symbols) : '600519.SH,000001.SZ')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const bars = options.bars ? parseInt(String(options.bars), 10) : 420;
  const cutCount = options.cuts ? parseInt(String(options.cuts), 10) : 5;
  const strategyIds = (options.strategies ? String(options.strategies) : 'ma-cross,chanlun-volume-pullback')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  console.log(`\n══════════════════════════════════════════════`);
  console.log(`  回测可靠性验证 (无未来数据 / 当日收盘价成交 / T+1 / 涨跌停 / 止损)`);
  console.log(`══════════════════════════════════════════════`);

  // --- 合成用例 ---
  testSameBarCloseExecution();
  testT1NoSameDayStop();
  testStopGapFillAtOpen();
  testStopLimitDownDeferred();
  testLimitUpBlocksBuy();
  testLimitDownBlocksSell();
  testDeterminism();
  testStepperNavigation();

  // --- 真实行情 ---
  if (!noReal) {
    section('真实行情: 加载数据');
    const data = await loadRealKlines(symbols, bars);
    if (data.size === 0) {
      console.warn('  ⚠ 没有可用行情 (缓存缺失且网络不可用), 跳过真实数据用例。');
    } else {
      const strategies = await loadStrategies();
      const selected = strategies.filter((s) => strategyIds.includes(s.id));
      if (selected.length === 0) {
        console.warn(`  ⚠ 未找到策略 (${strategyIds.join(', ')}), 跳过真实数据用例。`);
      }

      for (const [symbol, klines] of data.entries()) {
        console.log(`  · ${symbol}: ${klines.length} 根 (${klines[0].date} ~ ${klines[klines.length - 1].date})`);

        for (const strategy of selected) {
          const baseLabel = `${symbol}/${strategy.id}`;

          section(`真实行情 ${baseLabel}: 前缀不变性 (无未来数据)`);
          testPrefixInvariance(klines, { symbol, strategy, label: `${baseLabel}(无止损)` }, cutCount);
          testPrefixInvariance(
            klines,
            { symbol, strategy, stopLossPercent: 3, label: `${baseLabel}(止损3%)` },
            cutCount,
          );

          section(`真实行情 ${baseLabel}: 账本不变量`);
          testInvariants(klines, { symbol, strategy, label: `${baseLabel}(无止损)` });
          testInvariants(klines, { symbol, strategy, stopLossPercent: 3, label: `${baseLabel}(止损3%)` });

          section(`真实行情 ${baseLabel}: 单步/批量一致性`);
          testStepperParity(klines, { symbol, strategy, label: baseLabel });
        }
      }
    }
  }

  // --- 汇总 ---
  console.log(`\n══════════════════════════════════════════════`);
  if (failures.length === 0) {
    console.log(`  ✅ 全部通过: ${passedChecks} 项检查`);
  } else {
    console.log(`  ❌ ${failures.length} 项检查失败 (共 ${passedChecks + failures.length} 项):`);
    for (const f of failures) console.log(`     - ${f}`);
  }
  console.log(`══════════════════════════════════════════════\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('验证脚本异常:', err);
  process.exit(1);
});
