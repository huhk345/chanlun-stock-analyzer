#!/usr/bin/env node
/**
 * 通用策略自检：把 src/strategies/*.js 放进与线上一致的沙箱契约里，用合成行情
 * 跑一遍逐日撮合，验证：
 *   1. 代码能被沙箱求值、字段齐全（id / name / decide）、不含禁用模式
 *   2. 每个交易日都不抛异常，返回值合法（action 与 amount 组合正确）
 *   3. 仓位分支正确（空仓不 SELL，持仓不 BUY）
 *   4. 能真的产生买入信号，且成交账本自洽（现金不为负、股数为 100 的整数倍）
 *
 * 缠论结构用 src/utils/chanlun.ts 编译出来的同一份实现，撮合口径与评估脚本共用
 * scripts/lib/strategy-sandbox.mjs，保证两边一致。
 * 注意：这是结构自检，不是收益回测 —— 合成数据不能代表真实市场表现。
 *
 * 用法: node scripts/validate-strategy.mjs <策略文件> [seed...]
 */
import { loadChanlun, loadStrategy, runOne, pairTrades } from './lib/strategy-sandbox.mjs';

// ---------------------------------------------------------------------------
// 合成行情：趋势段 / 震荡段交替，带成交量
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeKlines(seed, bars = 1600) {
  const rand = mulberry32(seed);
  const out = [];
  let price = 20 + rand() * 40;
  const date = new Date(Date.UTC(2017, 0, 3));
  let regime = 'up';
  let regimeLeft = 0;
  let drift = 0;
  let vol = 0.016;

  for (let i = 0; i < bars; i++) {
    if (regimeLeft <= 0) {
      const r = rand();
      if (r < 0.45) {
        regime = 'up';
        drift = 0.0014 + rand() * 0.0024;
        vol = 0.014 + rand() * 0.01;
        regimeLeft = 60 + Math.floor(rand() * 140);
      } else if (r < 0.78) {
        regime = 'flat';
        drift = 0;
        vol = 0.011 + rand() * 0.008;
        regimeLeft = 40 + Math.floor(rand() * 90);
      } else {
        regime = 'down';
        drift = -0.0012 - rand() * 0.0022;
        vol = 0.016 + rand() * 0.012;
        regimeLeft = 40 + Math.floor(rand() * 80);
      }
    }
    regimeLeft--;

    const ret = drift + gauss(rand) * vol;
    const prev = price;
    price = Math.max(2, price * (1 + ret));

    const open = prev * (1 + gauss(rand) * vol * 0.25);
    const hi = Math.max(open, price) * (1 + Math.abs(gauss(rand)) * vol * 0.4);
    const lo = Math.min(open, price) * (1 - Math.abs(gauss(rand)) * vol * 0.4);
    const volume = Math.round((5e6 + rand() * 4e6) * (1 + Math.abs(ret) * 18));

    out.push({
      date: date.toISOString().slice(0, 10),
      open: +open.toFixed(2),
      high: +hi.toFixed(2),
      low: +lo.toFixed(2),
      close: +price.toFixed(2),
      volume,
      amount: Math.round(volume * price),
    });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const file = args.find((a) => a.endsWith('.js')) || 'src/strategies/cl-trend-b3-pullback.js';
const seeds = args
  .filter((a) => a !== file)
  .map(Number)
  .filter((v) => Number.isFinite(v));
const list = seeds.length ? seeds : [7, 21, 42, 99, 2024];
const overrides = process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {};

const chanlunLib = await loadChanlun();
const strategy = loadStrategy(file);

console.log(`策略: ${strategy.name} (${strategy.id})`);
console.log(`文件: ${file}`);
console.log(`参数: ${(strategy.params || []).length} 项 · requiresChanLun=${strategy.requiresChanLun}`);
console.log('');

let totalErrors = 0;
let totalBuys = 0;
let sumReturn = 0;
let sumWin = 0;
let sumStop = 0;

for (const seed of list) {
  const klines = makeKlines(seed);
  const result = runOne(chanlunLib, strategy, klines, { initialCash: 1_000_000, warmup: 60, overrides });
  const pairs = pairTrades(result.trades, klines);
  const buys = result.trades.filter((t) => t.action === 'BUY').length;

  const exits = new Map();
  for (const p of pairs) exits.set(p.reason, (exits.get(p.reason) || 0) + 1);

  const returnPct = ((result.equity - result.initialCash) / result.initialCash) * 100;
  const winRate = pairs.length ? (pairs.filter((p) => p.retPct > 0).length / pairs.length) * 100 : 0;

  totalErrors += result.errors.length;
  totalBuys += buys;
  sumReturn += returnPct;
  sumWin += winRate;
  sumStop += pairs.filter((p) => p.reason.indexOf('止损') >= 0).length;

  const exitText = [...exits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(' ');

  console.log(
    `seed=${String(seed).padEnd(5)} 买${String(buys).padStart(3)} 平${String(pairs.length).padStart(3)} ` +
      `胜率${winRate.toFixed(0).padStart(3)}% 收益${returnPct.toFixed(1).padStart(7)}% ` +
      `(买入持有 ${((klines[klines.length - 1].close / klines[60].close - 1) * 100).toFixed(1)}%) | ${exitText}`,
  );
  for (const e of result.errors) console.log(`  ✗ ${e}`);
}

console.log('');
console.log(`合计买入 ${totalBuys} 次，异常 ${totalErrors} 条`);
console.log(
  `均值: 收益 ${(sumReturn / list.length).toFixed(1)}% · 胜率 ${(sumWin / list.length).toFixed(0)}% ` +
    `· 止损离场占比 ${totalBuys ? ((sumStop / totalBuys) * 100).toFixed(0) : 0}%`,
);

if (totalErrors > 0) {
  console.error('自检失败：存在契约/账本异常');
  process.exit(1);
}
if (totalBuys === 0) {
  console.error('自检失败：合成行情里一次买点都没触发，检查过滤条件是否过严');
  process.exit(1);
}
console.log('自检通过');
