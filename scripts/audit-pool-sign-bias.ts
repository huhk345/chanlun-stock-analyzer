/**
 * 「逐标的回测排行榜全为正收益?」审计脚本。
 *
 * 用与 server/poolBacktest.ts 完全相同的路径 (getKlines + runBacktest) 回放:
 *   1. always-HOLD 空策略       -> 收益必须恒为 0 (检验账本)
 *   2. 首根买入一直持有         -> 必须 ≈ buy&hold (检验成交/费用记账是否系统性偏乐观)
 *   3. 固定种子随机买卖         -> 均值应 ≈ 市场均值 × 平均仓位 (检验「随便买卖都赚钱」的系统性偏差)
 *   4. 真实策略                 -> 与 buy&hold 分布对比, 看正收益占比是否与市场环境一致
 *
 * 用法: pnpm exec tsx scripts/audit-pool-sign-bias.ts [--symbols N] [--sample-ids file]
 */

import fs from 'node:fs';
import path from 'node:path';
import { runBacktest } from '../server/engine/backtestRunner.ts';
import { loadStrategies } from '../server/strategies/index.ts';
import type { Kline } from '../src/types/stock';
import type { UserStrategyDefinition, UserStrategyDecision } from '../src/types/strategy';
import type { BacktestTrade } from '../src/types/stock';

const CACHE_DIR = path.resolve(import.meta.dirname, '..', '.cache', 'klines');
const BARS = 400;
const CASH = 100_000;
const SAMPLE = (() => {
  const v = process.argv.find((a) => a.startsWith('--symbols='));
  return v ? parseInt(v.split('=')[1], 10) : 120;
})();

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 固定种子随机策略: 无持仓时 pBuy 概率买入 50%, 有持仓时 pSell 概率清仓 */
function randomStrategyImpl(seed: number, pBuy = 0.06, pSell = 0.06): UserStrategyDefinition {
  const rnd = mulberry32(seed);
  let lastDecision: UserStrategyDecision = { action: 'HOLD' };
  return {
    id: `random-${seed}`,
    name: `Random(${seed})`,
    decide({ position }): UserStrategyDecision {
      if (position.shares > 0) {
        lastDecision = rnd() < pSell
          ? { action: 'SELL', amount: { unit: 'percent', value: 100 }, reason: 'random' }
          : { action: 'HOLD' };
      } else {
        lastDecision = rnd() < pBuy
          ? { action: 'BUY', amount: { unit: 'percent', value: 50 }, reason: 'random' }
          : { action: 'HOLD' };
      }
      return lastDecision;
    },
  };
}

function alwaysHoldStrategy(): UserStrategyDefinition {
  return { id: 'hold-only', name: 'HoldOnly', decide(): UserStrategyDecision { return { action: 'HOLD' }; } };
}

function buyOnceStrategy(buyAt = 20): UserStrategyDefinition {
  return {
    id: 'buy-once',
    name: 'BuyOnce',
    decide({ currentIndex, position }): UserStrategyDecision {
      if (currentIndex === buyAt && position.shares === 0) {
        return { action: 'BUY', amount: { unit: 'percent', value: 100 }, reason: 'probe buy once' };
      }
      return { action: 'HOLD' };
    },
  };
}

interface Stats { min: number; p5: number; median: number; p95: number; max: number; mean: number; positivePct: number }

function stats(values: number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  const mean = values.reduce((x, v) => x + v, 0) / (values.length || 1);
  return {
    min: s[0], p5: q(0.05), median: q(0.5), p95: q(0.95), max: s[s.length - 1], mean,
    positivePct: (values.filter((v) => v > 0).length / (values.length || 1)) * 100,
  };
}

function fmt(name: string, st: Stats, n: number): string {
  return `${name.padEnd(28)} n=${String(n).padStart(4)}  min=${st.min.toFixed(2).padStart(8)}  p5=${st.p5.toFixed(2).padStart(8)}  median=${st.median.toFixed(2).padStart(8)}  mean=${st.mean.toFixed(2).padStart(8)}  p95=${st.p95.toFixed(2).padStart(8)}  max=${st.max.toFixed(2).padStart(8)}  正收益占比=${st.positivePct.toFixed(1)}%`;
}

async function main() {
  // --- 载入缓存: 与 pool 默认参数一致 (1d/forward/最近 400 根) ---
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('_1d_forward.json'));
  if (files.length === 0) {
    console.error('缓存目录为空, 先运行一次扫描/池回测生成 .cache/klines');
    process.exit(1);
  }
  // 打乱的固定顺序, 避免只取前 N 个而偏向前缀字母序
  const shuffled = files
    .map((f) => ({ f, k: mulberry32(42)() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.f);

  interface SymbolData { symbol: string; klines: Kline[] }
  const data: SymbolData[] = [];
  for (const f of shuffled) {
    if (data.length >= SAMPLE) break;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
      const klines: Kline[] = (j.klines as Kline[]).slice(-BARS);
      if (klines.length === BARS) data.push({ symbol: f.replace('_1d_forward.json', ''), klines });
    } catch { /* skip */ }
  }
  console.log(`样本: ${data.length} 只 (缓存 ${files.length} 只中取 ${SAMPLE}), 窗口 = 最近 ${BARS} 根日线/前复权\n`);

  const bh = data.map(({ klines }) => ((klines[klines.length - 1].close - klines[0].close) / klines[0].close) * 100);
  console.log('── 市场环境 (买入持有收益 %) ──');
  console.log(fmt('buy&hold (原始K线)', stats(bh), bh.length));

  const strip = (t: BacktestTrade) => t.date;
  const run = (klines: Kline[], strategy: UserStrategyDefinition, label: string) => {
    const { result } = runBacktest({
      klines, symbol: 'AUDIT', userId: 'audit', initialCash: CASH, currency: 'CNY',
      strategy, commissionRate: 0.00025, minCommission: 5,
    });
    void strip;
    return {
      ret: result.totalReturnPercent,
      nTrades: result.totalTrades,
      sellPnlSum: result.trades.filter((t) => t.type === 'SELL').reduce((s, t) => s + (t.pnl ?? 0), 0),
    };
  };

  console.log('\n── 1) always-HOLD 空策略 (期望全部恒为 0) ──');
  const holdRet = data.map(({ klines }) => run(klines, alwaysHoldStrategy(), 'hold').ret);
  console.log(fmt('always-HOLD', stats(holdRet), holdRet.length));
  const nonzeroHold = holdRet.filter((v) => Math.abs(v) > 1e-6);
  console.log(nonzeroHold.length === 0
    ? '  ✓ 恒为 0, 账本无泄漏'
    : `  ✗ 有 ${nonzeroHold.length} 只非零: ${nonzeroHold.slice(0, 5).map((v) => v.toFixed(3)).join(', ')}`);

  console.log('\n── 2) 首根#20 买入并持有 (应 ≈ buy&hold − 费用) ──');
  const pairs: { sym: string; bh: number; strat: number }[] = [];
  const onceRet: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const r = run(data[i].klines, buyOnceStrategy(20), 'buy-once');
    onceRet.push(r.ret);
    pairs.push({ sym: data[i].symbol, bh: bh[i], strat: r.ret });
  }
  console.log(fmt('buy-once@20 & hold', stats(onceRet), onceRet.length));
  const diffs = pairs.map((p) => p.strat - p.bh);
  console.log(fmt('buy-once − buy&hold 差', stats(diffs), diffs.length));
  const positiveDiff = diffs.filter((d) => d > 0.05).length;
  console.log(`  差值>0.05% 的标的数: ${positiveDiff}/${diffs.length} (费用影响应使差值略为负, 大量正值=记账偏乐观)`);

  console.log('\n── 3) 随机策略 × 3 个种子 (随便买卖的系统收益应 ≈ 市场均值×仓位, 不应系统性为正) ──');
  for (const seed of [7, 12345, 987654]) {
    const ret = data.map(({ klines }) => run(klines, randomStrategyImpl(seed), 'random').ret);
    console.log(fmt(`random seed=${seed}`, stats(ret), ret.length));
  }
  const marketMean = stats(bh).mean;
  void marketMean;

  console.log('\n── 4) 真实策略 ──');
  const strategies = await loadStrategies();
  for (const strategy of strategies) {
    const ret: number[] = [];
    const excess: number[] = [];
    let totalTrades = 0;
    for (let i = 0; i < data.length; i++) {
      try {
        const r = run(data[i].klines, strategy, strategy.id);
        ret.push(r.ret);
        excess.push(r.ret - bh[i]);
        totalTrades += r.nTrades;
      } catch (err) {
        console.warn(`  ⚠ ${data[i].symbol} ${strategy.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`\n  [${strategy.id}] 平均交易数/只 = ${(totalTrades / (ret.length || 1)).toFixed(2)}`);
    console.log(`  盈利占比: ${(ret.filter((v) => v > 0).length / (ret.length || 1) * 100).toFixed(1)}%`);
    console.log(fmt(`${strategy.id} 策略收益`, stats(ret), ret.length));
    console.log(fmt(`${strategy.id} 超额(vs B&H)`, stats(excess), excess.length));
    // 收益与 buy&hold 的相关系数
    const n = ret.length;
    const mRet = ret.reduce((s, v) => s + v, 0) / n;
    const mBh = bh.reduce((s, v) => s + v, 0) / n;
    const cov = ret.reduce((s, v, i) => s + (v - mRet) * (bh[i] - mBh), 0);
    const vRet = Math.sqrt(ret.reduce((s, v) => s + (v - mRet) ** 2, 0));
    const vBh = Math.sqrt(bh.reduce((s, v) => s + (v - mBh) ** 2, 0));
    console.log(`  与 buy&hold 相关系数 = ${(cov / (vRet * vBh || 1)).toFixed(3)}`);
    // 输出收益最低的 5 只, 便于对照
    const worst = pairsOf(ret).slice(0, 5);
    function pairsOf(vals: number[]) {
      return vals
        .map((v, i) => ({ v, sym: data[i].symbol }))
        .sort((a, b) => a.v - b.v);
    }
    console.log(`  最低 5 只: ${worst.map((w) => `${w.sym}=${w.v.toFixed(2)}%`).join(', ')}`);
  }

  console.log('\n结论参考: 若「随机策略/买入持有」也大面积为正 → 是市场环境 (bull) 或数据口径问题, 而非引擎作弊; 若只有真实策略全为正而随机为负 → 需重点排查策略与执行层。');
}

main().catch((e) => { console.error(e); process.exit(1); });
