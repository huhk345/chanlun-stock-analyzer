/**
 * 选股池多策略横向对比 CLI。
 *
 * 直接复用服务端池回测引擎 (server/poolBacktest.ts), 不经过 HTTP:
 * 对每个 (策略, 股票池) 组合串行发起一次池回测, 轮询任务状态直到结束,
 * 打印紧凑对比表并写出完整汇总 JSON。
 *
 * 用法:
 *   pnpm exec tsx scripts/pool-compare-strategies.ts [--indexes hs300,zz500]
 *        [--strategies id1,id2] [--count 420] [--out reports/pool-compare.json]
 */

// Mock Vite's import.meta.env / localStorage, 与 scripts/backtest.ts 口径一致
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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { requestPoolBacktest } from '../server/poolBacktest.ts';
import type { IndexId } from '../src/types/scan.ts';
import type { PoolBacktestSummary } from '../src/types/poolBacktest.ts';

/**
 * 默认横向对比的策略全集, 与 server/strategies 保持一致。
 * 两个 *-rotation 策略的买卖信号与其基线完全相同, 只有组合层开启轮动才会换仓;
 * 池回测 (单标的逐只回测) 不带轮动, 所以它们的池回测结果等于各自基线。
 */
const CANDIDATE_IDS = [
  'weekly-trend-daily-pullback',
  'chanlun-higher-low-recovery',
  'chanlun-hub-breakout',
  'chanlun-weekly-trend-third-buy',
  'long-term-breakout-trend',
  'long-term-breakout-rotation',
  'breakout-20d-volume',
  'volatility-squeeze-breakout',
  'volume-accumulation-obv',
  'volume-accumulation-obv-rotation',
  'oversold-rebound-uptrend',
  'sharp-pullback-recovery',
  'vol-adjusted-momentum',
];

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
    }
  }
  return options;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const options = parseArgs();
  const indexes = (options.indexes ?? 'hs300,zz500')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is IndexId => s === 'hs300' || s === 'zz500');
  const strategyIds = (options.strategies ?? CANDIDATE_IDS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const count = options.count ? parseInt(options.count, 10) : 420;
  const outPath = path.resolve(options.out ?? 'reports/pool-compare.json');

  const results: Array<{
    strategyId: string;
    index: IndexId;
    summary: PoolBacktestSummary;
    elapsedSec: number;
  }> = [];

  console.log(`策略数: ${strategyIds.length} | 股票池: ${indexes.join(', ')} | 拉取根数: ${count}`);
  console.log('');

  for (const strategyId of strategyIds) {
    for (const index of indexes) {
      const t0 = Date.now();
      const { job } = await requestPoolBacktest({ strategyId, indexes: [index], count });
      let lastDone = -1;
      process.stdout.write(`[${strategyId} / ${index}] total=${job.progress.total} ...`);
      while (job.state === 'running') {
        if (job.progress.done !== lastDone) {
          lastDone = job.progress.done;
          process.stdout.write(` ${lastDone}/${job.progress.total}`);
        }
        await sleep(1000);
      }
      const elapsedSec = (Date.now() - t0) / 1000;
      const view = job.view();
      if (view.state !== 'done' || !view.result) {
        console.log(`\n  失败: state=${view.state} error=${view.error ?? '(none)'}`);
        continue;
      }
      results.push({ strategyId, index, summary: view.result, elapsedSec });
      const s = view.result;
      console.log(
        `\n  收益率 ${s.totalReturnPercent.toFixed(2)}% | 买入持有 ${s.buyHoldReturnPercent.toFixed(2)}% | ` +
          `最大回撤 ${s.maxDrawdownPercent.toFixed(2)}% | 夏普 ${s.sharpeRatio.toFixed(2)} | ` +
          `交易 ${s.totalTrades} | 盈利标的占比 ${s.symbolWinRate.toFixed(1)}% | 测试 ${s.tested}/${s.universeSize} | ${elapsedSec.toFixed(1)}s`,
      );
    }
  }

  // 紧凑对比表 (stdout)
  console.log('\n===== 对比表 =====');
  console.log(
    [
      'strategy'.padEnd(28),
      'pool'.padEnd(7),
      'ret%'.padStart(8),
      'bh%'.padStart(8),
      'excess%'.padStart(9),
      'maxDD%'.padStart(8),
      'sharpe'.padStart(7),
      'trades'.padStart(7),
      'winSym%'.padStart(8),
      'beatBH%'.padStart(8),
      'median%'.padStart(9),
      'tested'.padStart(7),
    ].join(' '),
  );
  for (const r of results) {
    const s = r.summary;
    console.log(
      [
        r.strategyId.padEnd(28),
        r.index.padEnd(7),
        s.totalReturnPercent.toFixed(2).padStart(8),
        s.buyHoldReturnPercent.toFixed(2).padStart(8),
        (s.totalReturnPercent - s.buyHoldReturnPercent).toFixed(2).padStart(9),
        s.maxDrawdownPercent.toFixed(2).padStart(8),
        s.sharpeRatio.toFixed(2).padStart(7),
        String(s.totalTrades).padStart(7),
        s.symbolWinRate.toFixed(1).padStart(8),
        s.beatBuyHoldRate.toFixed(1).padStart(8),
        s.medianReturnPercent.toFixed(2).padStart(9),
        `${s.tested}/${s.universeSize}`.padStart(7),
      ].join(' '),
    );
  }

  // 完整结果 (含逐标的排行榜) 落盘
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        count,
        results: results.map((r) => ({
          strategyId: r.strategyId,
          index: r.index,
          elapsedSec: r.elapsedSec,
          summary: r.summary,
        })),
      },
      null,
      2,
    ),
    'utf-8',
  );
  console.log(`\n[明细] 已写入: ${outPath}`);
}

main().catch((err) => {
  console.error('池回测对比失败:', err);
  process.exit(1);
});
