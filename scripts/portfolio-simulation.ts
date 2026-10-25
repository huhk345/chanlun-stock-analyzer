/**
 * 组合模拟 CLI (无 UI): 拉取历史数据 → TS 策略逐日信号 → backtrader 组合撮合。
 *
 * 用法:
 *   npx tsx scripts/portfolio-simulation.ts \
 *     --strategy chanlun-weekly-daily-thermometer \
 *     --indexes hs300,zz500 --limit 50 \
 *     --exclude-boards chinext,star \
 *     --start 2023-01-01 --end 2026-10-23 \
 *     --cash 100000 --max-positions 10 --position-percent 10 \
 *     --out .cache/simulation-report.json
 *
 * --exclude-boards 可选值: chinext(创业板 300/301) / star(科创板 688/689) / bse(北交所), 逗号分隔。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  getPortfolioSimulationJob,
  requestPortfolioSimulation,
} from '../server/portfolioSimulation.ts';
import type { IndexId } from '../src/types/scan.ts';
import type { PortfolioBenchmarkId, PortfolioSimulationInput } from '../src/types/portfolioSimulation.ts';
import type { ExcludableBoard } from '../src/utils/symbols.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function num(name: string): number | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function benchmarkArg(): PortfolioBenchmarkId | undefined {
  const v = arg('benchmark');
  return v === 'hs300_tr' || v === 'hs300' || v === 'equal_weight' ? v : undefined;
}

async function main() {
  const input: PortfolioSimulationInput = {
    strategyId: arg('strategy') || 'chanlun-weekly-daily-thermometer',
    indexes: (arg('indexes') || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is IndexId => s === 'hs300' || s === 'zz500'),
    custom: (arg('custom') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    excludeBoards: (arg('exclude-boards') || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is ExcludableBoard => s === 'chinext' || s === 'star' || s === 'bse'),
    limit: num('limit'),
    adjust: (arg('adjust') as PortfolioSimulationInput['adjust']) || 'forward',
    initialCash: num('cash'),
    maxPositions: num('max-positions'),
    positionPercent: num('position-percent'),
    stopLossPercent: num('stop-loss'),
    rotationEnabled: process.argv.includes('--rotate'),
    rotationMinScoreDelta: num('rotate-delta'),
    rotationMaxPerDay: num('rotate-max'),
    commissionRate: num('commission'),
    minCommission: num('min-commission'),
    benchmark: benchmarkArg(),
    rangeStart: arg('start'),
    rangeEnd: arg('end'),
    force: process.argv.includes('--force'),
    params: arg('params') ? JSON.parse(arg('params')!) : {},
  };

  console.log('[sim] 发起任务', JSON.stringify(input));
  const { job, attached } = await requestPortfolioSimulation(input);
  console.log(`[sim] job ${job.id}${attached ? ' (复用进行中的同参数任务)' : ''}`);

  let lastPhase = '';
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const view = job.view();
    const p = view.progress;
    if (p.phase !== lastPhase || p.phase === 'simulating') {
      const day = p.simulationTotalDays ? ` ${p.simulationDay}/${p.simulationTotalDays}` : '';
      console.log(`[sim] ${p.phase}${day} · ${p.message}`);
      lastPhase = p.phase;
    }
    if (view.state !== 'running') {
      if (view.state === 'error') {
        console.error('[sim] 失败:', view.error);
        process.exit(1);
      }
      break;
    }
  }

  const view = job.view();
  const result = view.result!;
  const signals = job.signalPage({ limit: 1000 }).rows;
  const out = arg('out');
  if (out) {
    const file = path.resolve(out);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ ...result, signals, progress: view.progress, engine: result.engine }, null, 2),
    );
    console.log(`[sim] 报告已写入 ${file}`);
  }

  const s = result.stats;
  console.log('\n=== 组合结果 ===');
  console.log(`引擎: ${result.engine.name} ${result.engine.version} (Python ${result.engine.python})`);
  console.log(`区间: ${result.dateRange.start} → ${result.dateRange.end} (${s.tradingDays} 个交易日)`);
  console.log(`初始资金: ${s.initialCash.toFixed(2)}  期末权益: ${s.finalEquity.toFixed(2)}`);
  console.log(
    `总收益: ${s.totalReturnPercent.toFixed(2)}%  年化: ${s.annualizedReturnPercent.toFixed(2)}%  ` +
      `基准(${result.benchmark.name}): ${s.benchmarkReturnPercent.toFixed(2)}%  超额: ${s.excessReturnPercent.toFixed(2)}%`,
  );
  console.log(
    `最大回撤: ${s.maxDrawdownPercent.toFixed(2)}%  夏普: ${s.sharpeRatio.toFixed(2)}  ` +
      `成交: ${s.fills} 笔  平仓: ${s.closedTrades} 笔  胜率: ${s.winRate.toFixed(1)}%`,
  );
  console.log(`费用: ${s.totalFees.toFixed(2)}  平均持仓: ${s.avgPositions.toFixed(2)}  仓位暴露: ${s.exposurePercent.toFixed(1)}%`);
  console.log(`信号: ${result.signalCount} 条 (买入/卖出), 失败标的: ${result.failures.length}`);
  if (result.excludedCount) {
    console.log(
      `股票池排除: ${(result.excludedBoards ?? []).join(', ') || '无'} → 全池剔除 ${result.excludedCount} 只, 本次参与 ${result.universeSize} 只`,
    );
  }
  console.log(
    `逐日信号缓存: 整段命中 ${result.signalCacheHits ?? 0} 只, 增量续算 ${result.signalCacheIncremental ?? 0} 只, ` +
      `新计算 ${result.signalCacheMisses ?? 0} 只`,
  );
  if (result.marketContext.length > 0) {
    console.log('\n市场环境 (默认基准数据, 不参与选股):');
    for (const m of result.marketContext) {
      console.log(`  ${m.name}: ${m.lastValue.toFixed(2)}${m.unit} @${m.lastDate} (来源 ${m.source})`);
    }
  }
  console.log('\n最近成交:');
  for (const t of result.trades.slice(-10)) {
    console.log(
      `  ${t.date} ${t.side} ${t.symbol} ${t.name ?? ''} ${t.shares}股 @${t.price.toFixed(2)} ` +
        `费用 ${t.fee.toFixed(2)}${t.pnl != null ? ` 盈亏 ${t.pnl.toFixed(2)}` : ''}`,
    );
  }
  console.log('\n当前持仓:');
  for (const p of result.openPositions.slice(0, 10)) {
    console.log(
      `  ${p.symbol} ${p.name ?? ''} ${p.shares}股 成本 ${p.avgCost.toFixed(2)} 现价 ${p.price.toFixed(2)} ` +
        `${p.pnlPercent.toFixed(2)}% 权重 ${p.weightPercent.toFixed(1)}%`,
    );
  }
}

main().catch((err) => {
  console.error('[sim] 异常:', err);
  process.exit(1);
});
