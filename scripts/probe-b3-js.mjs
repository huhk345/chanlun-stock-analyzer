#!/usr/bin/env node
/**
 * 用真实 K 线跑一遍 JS 策略（回测面板那一份），把买入/卖出日期打出来。
 *
 * 目的：`src/strategies/cl-trend-b3-pullback.js` 与 `engine-rs/src/strategies.rs`
 * 是同一套规则的两份实现，改了其中一份必须能验证另一份的行为是否跟着变。
 * 自检脚本用的是合成行情，只能验契约；这个脚本喂真实 K 线，用来和 Rust 引擎的
 * 决策日志对齐（同一标的、同一区间，看买入日期是否重合）。
 *
 * 用法:
 *   node scripts/probe-b3-js.mjs 000408.SZ 600377.SH
 *   node scripts/probe-b3-js.mjs 000408.SZ --params '{"maxEntryBar":0}'
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadChanlun() {
  const src = readFileSync(path.join(root, 'src/utils/chanlun.ts'), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), 'chanlun-'));
  const file = path.join(dir, 'chanlun.mjs');
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

function loadStrategy() {
  const code = readFileSync(path.join(root, 'src/strategies/cl-trend-b3-pullback.js'), 'utf8');
  const fn = new Function(`
    'use strict';
    ${code}
    return typeof exports !== 'undefined' ? exports :
           typeof module !== 'undefined' && module.exports ? module.exports :
           typeof strategy !== 'undefined' ? strategy : null;
  `);
  return fn();
}

const FEE = { commission: 0.00025, minCommission: 5, stamp: 0.0005, transfer: 0.00001 };
const buyFee = (v) => Math.max(v * FEE.commission, FEE.minCommission) + v * FEE.transfer;
const sellFee = (v) =>
  Math.max(v * FEE.commission, FEE.minCommission) + v * FEE.stamp + v * FEE.transfer;

function loadKlines(symbol) {
  const p = path.join(root, '.cache', 'klines', `${symbol}_1d_forward.json`);
  return JSON.parse(readFileSync(p, 'utf8')).klines;
}

function run(chanlunLib, strategy, klines, params, initialCash) {
  let cash = initialCash;
  let shares = 0;
  let avgCost = 0;
  const trades = [];
  const decisions = [];

  for (let i = 80; i < klines.length; i++) {
    const prefix = klines.slice(0, i + 1);
    const structures = chanlunLib.computeChanlunStructures(prefix);
    const bar = klines[i];
    const marketValue = shares * bar.close;

    const input = {
      klines: prefix,
      currentIndex: i,
      currentKline: bar,
      account: { cash, equity: cash + marketValue, initialCash, pnl: 0, pnlPercent: 0 },
      position: {
        shares,
        averageCost: avgCost,
        marketValue,
        unrealizedPnl: marketValue - avgCost * shares,
        unrealizedPnlPercent: 0,
      },
      trades,
      params,
      chanlun: {
        mergedKlines: structures.mergedKlines,
        fractions: structures.fractals,
        strokes: structures.strokes,
        segments: structures.segments,
        hubs: structures.hubs,
      },
    };

    let sig;
    try {
      sig = strategy.decide(input);
    } catch (err) {
      decisions.push({ date: bar.date, action: 'ERR', reason: String(err) });
      continue;
    }
    if (!sig || sig.action === 'HOLD') continue;

    const pct = sig.amount && sig.amount.unit === 'percent' ? sig.amount.value : 0;
    if (sig.action === 'BUY') {
      const budget = (cash * pct) / 100;
      let qty = Math.floor(budget / bar.close / 100) * 100;
      if (qty < 100) qty = 0;
      const value = qty * bar.close;
      if (qty > 0 && value + buyFee(value) <= cash) {
        cash -= value + buyFee(value);
        avgCost = (avgCost * shares + value) / (shares + qty);
        shares += qty;
        trades.push({ date: bar.date, action: 'BUY', price: bar.close, qty, reason: sig.reason });
        decisions.push({ date: bar.date, action: 'BUY', price: bar.close, reason: sig.reason });
      } else {
        decisions.push({ date: bar.date, action: 'BUY-REJECT', price: bar.close, reason: sig.reason });
      }
    } else if (sig.action === 'SELL') {
      let qty = Math.floor((shares * pct) / 100 / 100) * 100;
      if (qty < 100) qty = pct >= 99 ? shares : 0;
      if (qty > 0) {
        const value = qty * bar.close;
        cash += value - sellFee(value);
        shares -= qty;
        if (shares === 0) avgCost = 0;
        trades.push({ date: bar.date, action: 'SELL', price: bar.close, qty, reason: sig.reason });
        decisions.push({ date: bar.date, action: 'SELL', price: bar.close, reason: sig.reason });
      }
    }
  }

  const last = klines[klines.length - 1].close;
  return { decisions, trades, equity: cash + shares * last, finalShares: shares };
}

const args = process.argv.slice(2);
const symbols = args.filter((a) => !a.startsWith('--'));
let params = {};
const pi = args.indexOf('--params');
if (pi >= 0 && args[pi + 1]) params = JSON.parse(args[pi + 1]);
if (!symbols.length) symbols.push('000408.SZ', '600377.SH');

const chanlunLib = await loadChanlun();
const strategy = loadStrategy();
const merged = { ...strategy.params.reduce((acc, p) => (acc[p.key] = p.defaultValue, acc), {}), ...params };

console.log(`strategy ${strategy.id} · params ${Object.keys(params).length} override(s)`);
console.log(`maxEntryBar=${merged.maxEntryBar} stopAtr=${merged.stopAtr} enableB2=${merged.enableB2} tp1R=${merged.tp1R} trail=${merged.trailAtrMult}`);

for (const sym of symbols) {
  const klines = loadKlines(sym);
  const res = run(chanlunLib, strategy, klines, merged, 1_000_000);
  const buys = res.decisions.filter((d) => d.action === 'BUY');
  const sells = res.decisions.filter((d) => d.action === 'SELL');
  const ret = (res.equity / 1_000_000 - 1) * 100;
  console.log(`\n${sym}  ${klines[0].date} → ${klines[klines.length - 1].date}  bars ${klines.length}`);
  console.log(`  买 ${buys.length} 卖 ${sells.length}  期末权益 ${res.equity.toFixed(0)} (${ret.toFixed(1)}%)`);
  for (const b of buys) console.log(`  BUY  ${b.date} @ ${b.price.toFixed(2)}  ${b.reason.slice(0, 70)}`);
  for (const s of sells) console.log(`  SELL ${s.date} @ ${s.price.toFixed(2)}  ${s.reason.slice(0, 60)}`);
}
