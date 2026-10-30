#!/usr/bin/env node
/**
 * 策略自检：把 src/strategies/cl-trend-b3-pullback.js 放进和线上一致的沙箱契约里，
 * 用合成行情跑一遍逐日撮合，验证：
 *   1. 代码能被沙箱求值、字段齐全（id / name / decide）
 *   2. 每个交易日都不抛异常，返回值合法（action 与 amount 组合正确）
 *   3. 仓位分支正确（空仓不 SELL，持仓不 BUY）
 *   4. 能真的产生三买信号，且成交账本自洽（现金不为负、股数为 100 的整数倍）
 *
 * 缠论结构直接用 src/utils/chanlun.ts 编译出来的同一份实现，保证与前端/服务端一致。
 * 注意：这是结构自检，不是收益回测——合成数据不能代表真实市场表现。
 *
 * 用法: node scripts/validate-cl-trend-b3.mjs [seed...]
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 1. 编译 chanlun.ts -> 临时 mjs
// ---------------------------------------------------------------------------

async function loadChanlun() {
  const src = readFileSync(path.join(root, 'src/utils/chanlun.ts'), 'utf8');
  // 该文件只 import 类型，transpileModule 会把类型导入整条擦掉
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), 'chanlun-'));
  const file = path.join(dir, 'chanlun.mjs');
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

// ---------------------------------------------------------------------------
// 2. 沙箱求值（与 src/utils/userCodeLoader.ts 的 evalUserCodeModule 同构）
// ---------------------------------------------------------------------------

function loadStrategy() {
  const code = readFileSync(path.join(root, 'src/strategies/cl-trend-b3-pullback.js'), 'utf8');
  const fn = new Function(`
    'use strict';
    ${code}
    return typeof exports !== 'undefined' ? exports :
           typeof module !== 'undefined' && module.exports ? module.exports :
           typeof strategy !== 'undefined' ? strategy : null;
  `);
  const result = fn();
  if (!result || typeof result !== 'object') throw new Error('未导出 strategy 对象');
  if (typeof result.id !== 'string') throw new Error('缺少 id');
  if (typeof result.name !== 'string') throw new Error('缺少 name');
  if (typeof result.decide !== 'function') throw new Error('缺少 decide 函数');
  return result;
}

// ---------------------------------------------------------------------------
// 3. 合成行情：趋势段 / 震荡段交替，带成交量
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

function makeKlines(seed, bars = 1400) {
  const rand = mulberry32(seed);
  const out = [];
  let price = 20 + rand() * 40;
  let day = 0;
  const date = new Date(Date.UTC(2019, 0, 2));
  let regime = 'up';
  let regimeLeft = 0;
  let drift = 0;
  let vol = 0.016;

  for (let i = 0; i < bars; i++) {
    if (regimeLeft <= 0) {
      const r = rand();
      if (r < 0.42) {
        regime = 'up';
        drift = 0.0012 + rand() * 0.0022;
        vol = 0.014 + rand() * 0.01;
        regimeLeft = 60 + Math.floor(rand() * 120);
      } else if (r < 0.78) {
        regime = 'flat';
        drift = 0;
        vol = 0.011 + rand() * 0.008;
        regimeLeft = 40 + Math.floor(rand() * 90);
      } else {
        regime = 'down';
        drift = -0.001 - rand() * 0.002;
        vol = 0.016 + rand() * 0.012;
        regimeLeft = 40 + Math.floor(rand() * 80);
      }
    }
    regimeLeft--;

    const shock = gauss(rand) * vol;
    const ret = drift + shock;
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
    day++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. 逐日撮合（对齐仓库口径：收盘价成交、100 股整手、T+1、佣金+印花税+过户费）
// ---------------------------------------------------------------------------

const FEE = { commission: 0.00025, minCommission: 5, stamp: 0.0005, transfer: 0.00001 };

function buyFee(value) {
  return Math.max(value * FEE.commission, FEE.minCommission) + value * FEE.transfer;
}
function sellFee(value) {
  return (
    Math.max(value * FEE.commission, FEE.minCommission) +
    value * FEE.stamp +
    value * FEE.transfer
  );
}

function run(chanlunLib, strategy, klines, initialCash = 1_000_000, overrides = {}) {
  let cash = initialCash;
  let shares = 0;
  let avgCost = 0;
  const trades = [];
  const signals = [];
  const errors = [];
  let lastBuyIdx = -99;

  for (let i = 80; i < klines.length; i++) {
    const prefix = klines.slice(0, i + 1);
    const current = klines[i];
    const structures = chanlunLib.computeChanlunStructures(prefix);
    const marketValue = shares * current.close;
    const position = {
      shares,
      averageCost: avgCost,
      marketValue,
      unrealizedPnl: shares ? (current.close - avgCost) * shares : 0,
      unrealizedPnlPercent: shares && avgCost ? (current.close / avgCost - 1) * 100 : 0,
    };

    let decision;
    try {
      decision = strategy.decide({
        symbol: 'TEST',
        timeframe: 'daily',
        klines: prefix,
        currentIndex: i,
        currentKline: current,
        account: { initialCash, cash, equity: cash + marketValue, currency: 'CNY' },
        position,
        trades: trades.slice(),
        params: overrides,
        chanlun: structures,
        currency: 'CNY',
        initialCash,
      });
    } catch (e) {
      errors.push(`第 ${i} 根 (${current.date}) 抛异常: ${e && e.message}`);
      break;
    }

    const action = decision && decision.action;
    if (action !== 'BUY' && action !== 'SELL' && action !== 'HOLD') {
      errors.push(`第 ${i} 根 action 非法: ${action}`);
      break;
    }
    if (action !== 'HOLD' && !decision.amount) {
      errors.push(`第 ${i} 根 ${action} 缺少 amount`);
      break;
    }
    if (action === 'BUY' && shares > 0) {
      errors.push(`第 ${i} 根 持仓时给了 BUY`);
      break;
    }
    if (action === 'SELL' && shares === 0) {
      errors.push(`第 ${i} 根 空仓时给了 SELL`);
      break;
    }
    if (action === 'BUY' && i === lastBuyIdx) {
      errors.push(`第 ${i} 根 同一根重复 BUY`);
      break;
    }

    if (action === 'BUY') {
      const unit = decision.amount.unit;
      let budget = cash;
      if (unit === 'percent') budget = (cash * decision.amount.value) / 100;
      else if (unit === 'cash') budget = Math.min(cash, decision.amount.value);
      const lots = Math.floor(budget / (current.close * 100));
      const qty = lots * 100;
      if (qty > 0) {
        const value = qty * current.close;
        const fee = buyFee(value);
        if (value + fee > cash + 1e-6) {
          errors.push(`第 ${i} 根 买入超出可用现金`);
          break;
        }
        cash -= value + fee;
        avgCost = (avgCost * shares + value + fee) / (shares + qty);
        shares += qty;
        lastBuyIdx = i;
        trades.push({
          id: `t${trades.length}`,
          date: current.date,
          action: 'BUY',
          price: current.close,
          shares: qty,
          value,
          fee,
          reason: decision.reason,
        });
        signals.push({ date: current.date, action: 'BUY', reason: decision.reason });
      }
    } else if (action === 'SELL') {
      const unit = decision.amount.unit;
      let qty = shares;
      if (unit === 'percent') qty = Math.floor((shares * decision.amount.value) / 100 / 100) * 100;
      else if (unit === 'shares') qty = Math.floor(decision.amount.value / 100) * 100;
      qty = Math.min(qty, shares);
      if (qty > 0) {
        const value = qty * current.close;
        const fee = sellFee(value);
        cash += value - fee;
        shares -= qty;
        if (shares === 0) avgCost = 0;
        trades.push({
          id: `t${trades.length}`,
          date: current.date,
          action: 'SELL',
          price: current.close,
          shares: qty,
          value,
          fee,
          reason: decision.reason,
        });
        signals.push({ date: current.date, action: 'SELL', reason: decision.reason });
      }
    }
  }

  const lastClose = klines[klines.length - 1].close;
  const equity = cash + shares * lastClose;
  return { cash, shares, equity, trades, signals, errors };
}

// ---------------------------------------------------------------------------
// 5. 统计
// ---------------------------------------------------------------------------

function summarize(klines, result, initialCash) {
  const buys = result.trades.filter((t) => t.action === 'BUY');
  const sells = result.trades.filter((t) => t.action === 'SELL');
  const reasons = new Map();
  for (const t of sells) {
    const key = (t.reason || '').split(/[：:（(]/)[0].slice(0, 12) || '未标注';
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }
  // 逐笔盈亏（按 FIFO 简化：以建仓均价配对）
  const pnl = [];
  let open = null;
  for (const t of result.trades) {
    if (t.action === 'BUY') {
      if (!open) open = { cost: 0, qty: 0, date: t.date };
      open.cost += t.value + (t.fee || 0);
      open.qty += t.shares;
    } else if (open) {
      const partCost = (open.cost * t.shares) / open.qty;
      pnl.push(t.value - (t.fee || 0) - partCost);
      open.cost -= partCost;
      open.qty -= t.shares;
      if (open.qty <= 0) open = null;
    }
  }
  const wins = pnl.filter((p) => p > 0).length;
  const bars = klines.length - 80;
  return {
    bars,
    buys: buys.length,
    sells: sells.length,
    exits: reasons,
    realized: pnl.reduce((a, b) => a + b, 0),
    winRate: pnl.length ? (wins / pnl.length) * 100 : 0,
    returnPct: ((result.equity - initialCash) / initialCash) * 100,
    buyHoldPct: ((klines[klines.length - 1].close / klines[80].close - 1) * 100),
  };
}

// ---------------------------------------------------------------------------

const seeds = process.argv.slice(2).map(Number).filter((v) => Number.isFinite(v));
const list = seeds.length ? seeds : [7, 21, 42, 99, 2024];
// 可选参数覆盖，便于快速做敏感度对比: PARAMS='{"stopBufferPct":1.5}' node scripts/...
const overrides = process.env.PARAMS ? JSON.parse(process.env.PARAMS) : {};

const chanlunLib = await loadChanlun();
const strategy = loadStrategy();

console.log(`策略: ${strategy.name} (${strategy.id})`);
console.log(`参数: ${strategy.params.length} 项 · requiresChanLun=${strategy.requiresChanLun}`);
console.log('');

let totalErrors = 0;
let totalBuys = 0;
let sumReturn = 0;
let sumWin = 0;
let sumStop = 0;
let sumTrades = 0;

for (const seed of list) {
  const klines = makeKlines(seed);
  const result = run(chanlunLib, strategy, klines, 1_000_000, overrides);
  const s = summarize(klines, result, 1_000_000);
  totalErrors += result.errors.length;
  totalBuys += s.buys;
  sumReturn += s.returnPct;
  sumWin += s.winRate;
  sumTrades += s.buys;
  sumStop += s.exits.get('结构止损') || 0;

  const exitText = [...s.exits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}×${v}`)
    .join(' ');
  console.log(
    `seed=${String(seed).padEnd(5)} 买${String(s.buys).padStart(3)} 卖${String(s.sells).padStart(3)} ` +
      `胜率${s.winRate.toFixed(0).padStart(3)}% 收益${s.returnPct.toFixed(1).padStart(6)}% ` +
      `(买入持有 ${s.buyHoldPct.toFixed(1)}%) | ${exitText}`,
  );
  for (const e of result.errors) console.log(`  ✗ ${e}`);
}

console.log('');
console.log(`合计买入 ${totalBuys} 次，异常 ${totalErrors} 条`);
console.log(
  `均值: 收益 ${(sumReturn / list.length).toFixed(1)}% · 胜率 ${(sumWin / list.length).toFixed(0)}% ` +
    `· 结构止损占比 ${totalBuys ? ((sumStop / totalBuys) * 100).toFixed(0) : 0}%`,
);

// 结构断言：至少要有信号，且账本没有异常
if (totalErrors > 0) {
  console.error('自检失败：存在契约/账本异常');
  process.exit(1);
}
if (totalBuys === 0) {
  console.error('自检失败：5 组合成行情里一次买点都没触发，检查过滤条件是否过严');
  process.exit(1);
}
console.log('自检通过');
