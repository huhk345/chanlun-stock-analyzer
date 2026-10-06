/* 选股 pad 烟雾测试: 默认策略加载 + 信号评估 + 过滤排序 + 单股回测可运行性 */
// @ts-ignore
import.meta.env = { DEV: false, MODE: 'production' };

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

import type { Kline } from '../src/types/stock.ts';
import { loadStrategies } from '../src/strategies/user/index.ts';
import {
  evaluateScreenerSignal,
  evaluateScreenerBatch,
  filterScreenerSignals,
  sortScreenerSignals,
} from '../src/utils/screener.ts';
import {
  sliceKlinesByRange,
  yearsAgoStr,
  todayStr,
} from '../src/utils/screener.ts';
import { runBacktest } from '../src/utils/backtestRunner.ts';
import {
  scoreScreenerStrategy,
  validateScreenerStrategy,
  buildScreenerTestRegimes,
} from '../src/utils/screenerStrategyTest.ts';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  PASS: ${msg}`);
  } else {
    fail++;
    console.error(`  FAIL: ${msg}`);
  }
}

function mkKlines(closes: number[], startDay = 1): Kline[] {
  return closes.map((c, i) => ({
    date: `2024-01-${String(startDay + i).padStart(2, '0')}`,
    open: c * 0.995,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 100000 + i * 100,
    amount: c * 100000,
  }));
}

// 稳步上行 60 根: 10 -> 16, 每根 +0.1
const uptrend = mkKlines(Array.from({ length: 60 }, (_, i) => 10 + i * 0.1));
// 箱体后突破: 40 根 10 附近震荡, 最后 1 根跳到 12
const breakoutCloses = Array.from({ length: 40 }, (_, i) => 10 + Math.sin(i) * 0.1);
breakoutCloses.push(12);
const breakout = mkKlines(breakoutCloses);
// 单边下跌 60 根
const downtrend = mkKlines(Array.from({ length: 60 }, (_, i) => 16 - i * 0.1));

console.log('== Test 1: 默认选股策略可加载 ==');
const strategies = await loadStrategies();
const ids = strategies.map((s) => s.id);
assert(ids.includes('screener-ma-bull'), 'screener-ma-bull 已注册');
assert(ids.includes('screener-chanlun-b23'), 'screener-chanlun-b23 已注册');
assert(ids.includes('screener-donchian-breakout'), 'screener-donchian-breakout 已注册');
assert(ids.includes('ma-cross'), 'ma-cross 仍可用');
assert(new Set(ids).size === ids.length, '策略 id 无重复');

const maBull = strategies.find((s) => s.id === 'screener-ma-bull')!;
const donchian = strategies.find((s) => s.id === 'screener-donchian-breakout')!;
const maCross = strategies.find((s) => s.id === 'ma-cross')!;

console.log('== Test 2: 信号评估不抛异常, 含行情摘要 ==');
const sigUp = evaluateScreenerSignal(maBull, uptrend, '000001.SZ');
assert(['BUY', 'SELL', 'HOLD'].includes(sigUp.action), `ma-bull 上行趋势返回合法动作 (${sigUp.action})`);
assert(sigUp.close === uptrend[uptrend.length - 1].close, '现价取自末根K线');
assert(sigUp.dataDate === uptrend[uptrend.length - 1].date, '数据日期取自末根K线');
assert(typeof sigUp.changePct === 'number', '涨跌幅为数字');

const sigBreak = evaluateScreenerSignal(donchian, breakout, '600519.SH');
assert(sigBreak.action === 'BUY', `donchian 箱体突破返回 BUY (得 ${sigBreak.action}: ${sigBreak.reason})`);

const sigDown = evaluateScreenerSignal(maBull, downtrend, '000001.SZ');
assert(sigDown.action !== 'BUY', `ma-bull 下跌趋势不买入 (得 ${sigDown.action})`);

const sigEmpty = evaluateScreenerSignal(maBull, [], '000001.SZ');
assert(sigEmpty.action === 'HOLD' && sigEmpty.error === 'empty-klines', '空K线降级为 HOLD');

console.log('== Test 3: 批量/过滤/排序 ==');
const batch = evaluateScreenerBatch(donchian, [
  { symbol: 'A.SH', klines: breakout },
  { symbol: 'B.SH', klines: downtrend },
]);
assert(batch.length === 2, '批量返回逐只信号');
const buysOnly = filterScreenerSignals(batch, { onlyBuy: true });
assert(buysOnly.every((s) => s.action === 'BUY'), 'onlyBuy 过滤有效');
assert(buysOnly.length === 1 && buysOnly[0].symbol === 'A.SH', '突破股被筛选为买入');
const sorted = sortScreenerSignals(batch, 'confidenceDesc');
assert(sorted[0].action === 'BUY', '排序把 BUY 放前面');

console.log('== Test 4: 默认策略可跑通单股回测 (选股页回测验证链路) ==');
for (const s of [maBull, donchian, maCross]) {
  const { result, diagnostics } = runBacktest({
    klines: uptrend,
    symbol: '000001.SZ',
    userId: 'smoke',
    initialCash: 100000,
    currency: 'CNY',
    strategy: s,
  });
  assert(Array.isArray(result.trades), `${s.id} 回测返回交易数组`);
  assert(result.startDate === uptrend[0].date && result.endDate === uptrend[uptrend.length - 1].date, `${s.id} 回测起止日期正确`);
  assert(Array.isArray(diagnostics), `${s.id} 回测返回 diagnostics`);
}

console.log('== Test 5: 缠论二买三买策略 (B2→B3次日买, 跌破B3卖) ==');
const b23 = strategies.find((s) => s.id === 'screener-chanlun-b23')!;
assert(b23.requiresChanLun === true, 'b23 声明 requiresChanLun (选股链路会构建笔/中枢)');
for (const key of ['entryWindow', 'b2Lookback', 'stopBufferPct', 'hardStopLossPct', 'trailingActivationPct', 'buyPercent']) {
  assert((b23.params ?? []).some((p) => p.key === key), `b23 参数含 ${key}`);
}
// 合成行情 + 空数据: 永不抛异常, 动作合法
for (const r of buildScreenerTestRegimes()) {
  const sig = evaluateScreenerSignal(b23, r.klines, `T.${r.id}`);
  assert(['BUY', 'SELL', 'HOLD'].includes(sig.action), `b23 ${r.label}返回合法动作 (${sig.action}: ${sig.reason})`);
}
const b23Down = evaluateScreenerSignal(b23, downtrend, '000001.SZ');
assert(b23Down.action !== 'BUY', `b23 下跌趋势不买入 (得 ${b23Down.action})`);
// 持有中硬止损分支: 成本16, 现价~10, 必须 SELL (直接调用 decide, 确定性覆盖卖出逻辑)
{
  const last = downtrend[downtrend.length - 1];
  const decision = b23.decide({
    symbol: '000001.SZ',
    timeframe: 'daily',
    klines: downtrend,
    currentIndex: downtrend.length - 1,
    currentKline: last,
    account: { initialCash: 100000, cash: 0, equity: 100000, currency: 'CNY' },
    position: { shares: 1000, averageCost: 16, marketValue: 10000, unrealizedPnl: -6000, unrealizedPnlPercent: -37.5 },
    trades: [{ id: 't1', date: downtrend[0].date, action: 'BUY', price: 16, shares: 1000, value: 16000 }],
    params: { hardStopLossPct: 6 },
    currency: 'CNY',
    initialCash: 100000,
  });
  assert(decision.action === 'SELL', `b23 持仓大亏触发卖出 (得 ${decision.action}: ${decision.reason})`);
}
// 全历史回测可跑通 (覆盖持有/卖出循环)
{
  const { result } = runBacktest({
    klines: uptrend,
    symbol: '000001.SZ',
    userId: 'smoke',
    initialCash: 100000,
    currency: 'CNY',
    strategy: b23,
  });
  assert(Array.isArray(result.trades), 'b23 回测返回交易数组');
}

console.log('== Test 6: 策略实验室框架 (validate + score) ==');
{
  const checks = validateScreenerStrategy(b23);
  assert(checks.length === 5, `validate 返回5项检查 (得 ${checks.length})`);
  assert(checks.every((c) => c.pass), `b23 通过全部静态/动态检查 (${checks.map((c) => c.id).join(',')})`);
  const report = scoreScreenerStrategy(maBull);
  assert(report.regimes.length === 5, `score 返回5套行情结果 (得 ${report.regimes.length})`);
  assert(typeof report.summary === 'string' && report.summary.length > 0, 'score 返回中文摘要');
  assert(typeof report.allPass === 'boolean', 'score 返回 allPass 结论');
  const b23Report = scoreScreenerStrategy(b23);
  assert(b23Report.regimes.length === 5 && !b23Report.regimes.some((r) => r.error), 'b23 合成评分无崩溃');
}

console.log('== Test 7: 回测区间切片 (默认近3年) ==');
{
  assert(/^\d{4}-\d{2}-\d{2}$/.test(todayStr()), `todayStr 格式正确 (${todayStr()})`);
  assert(yearsAgoStr(3) < todayStr(), `yearsAgoStr(3) 早于今天 (${yearsAgoStr(3)})`);
  assert(sliceKlinesByRange(uptrend).length === uptrend.length, '无界返回全量');
  assert(sliceKlinesByRange(uptrend, '', '').length === uptrend.length, '空字符串视为无界');
  const startOnly = sliceKlinesByRange(uptrend, '2024-01-30');
  assert(startOnly.length > 0 && startOnly.length < uptrend.length, '起始过滤生效');
  assert(startOnly.every((k) => k.date >= '2024-01-30'), '起始闭区间正确');
  const endOnly = sliceKlinesByRange(uptrend, undefined, '2024-01-10');
  assert(endOnly.every((k) => k.date <= '2024-01-10'), '结束闭区间正确');
  const both = sliceKlinesByRange(uptrend, '2024-01-10', '2024-01-20');
  assert(both.length === 11, `双界切片 11 根 (得 ${both.length})`);
  assert(sliceKlinesByRange(uptrend, '2025-01-01', '2025-12-31').length === 0, '无交集返回空数组 (不静默回退)');
  assert(sliceKlinesByRange([], '2024-01-01', '2024-12-31').length === 0, '空输入返回空数组');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
