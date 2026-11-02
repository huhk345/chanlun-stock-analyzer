/**
 * 策略沙箱与逐日撮合的公共实现。
 *
 * 自检脚本（合成行情）与评估脚本（真实行情）共用同一份撮合逻辑，避免两边口径
 * 漂移 —— 一旦口径不一致，「自检通过」就失去了意义。
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 与 src/utils/userCodeLoader.ts 完全一致的禁用模式 */
const FORBIDDEN = [
  [/\bimport\b/, 'import'],
  [/\brequire\b/, 'require'],
  [/\bfetch\b/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\bdocument\./, 'document.'],
  [/\bwindow\./, 'window.'],
  [/\beval\s*\(/, 'eval('],
  [/\bFunction\s*\(/, 'Function('],
  [/\basync\s+function\b/, 'async function'],
  [/\bawait\b/, 'await'],
];

/** 编译 src/utils/chanlun.ts 成临时模块并载入（与前端同一份实现） */
export async function loadChanlun() {
  const src = readFileSync(path.join(root, 'src/utils/chanlun.ts'), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), 'chanlun-'));
  const file = path.join(dir, 'chanlun.mjs');
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

/**
 * 沙箱求值策略源码。
 * `patches` 是 [from, to] 数组，用于「消融实验」——把某一条件临时改成恒真，
 * 看关掉它之后信号变不变。这样策略源码里不用留一个只为审计存在的死旋钮。
 */
export function loadStrategy(file, patches = []) {
  let code = readFileSync(path.isAbsolute(file) ? file : path.join(root, file), 'utf8');
  for (const [from, to] of patches) {
    if (!code.includes(from)) throw new Error(`消融补丁没命中: ${from}`);
    code = code.split(from).join(to);
  }
  const hits = FORBIDDEN.filter(([re]) => re.test(code)).map(([, name]) => name);
  if (hits.length) throw new Error('命中沙箱禁用模式: ' + hits.join(', '));

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
// 撮合口径（A 股）：收盘价成交、100 股整手、T+1、佣金万 2.5（最低 5 元）
//                 + 卖出印花税千 0.5 + 过户费万 0.1
// ---------------------------------------------------------------------------

const FEE = { commission: 0.00025, minCommission: 5, stamp: 0.0005, transfer: 0.00001 };

export function buyFee(value) {
  return Math.max(value * FEE.commission, FEE.minCommission) + value * FEE.transfer;
}
export function sellFee(value) {
  return (
    Math.max(value * FEE.commission, FEE.minCommission) +
    value * FEE.stamp +
    value * FEE.transfer
  );
}

/**
 * 逐日跑一只标的。
 * @returns {{trades, errors, equity, cash, shares}}
 */
export function runOne(chanlunLib, strategy, klines, opts = {}) {
  const initialCash = opts.initialCash ?? 1_000_000;
  const warmup = opts.warmup ?? 60;
  const overrides = opts.overrides || {};

  let cash = initialCash;
  let shares = 0;
  let avgCost = 0;
  const trades = [];
  const errors = [];
  let lastBuyIdx = -99;

  // 消融/多参数扫描时，缠论结构与前缀切片与参数无关，可以预先算好复用
  const structures = opts.structures || null;
  const prefixes = opts.prefixes || null;

  for (let i = warmup; i < klines.length; i++) {
    const prefix = prefixes ? prefixes[i] : klines.slice(0, i + 1);
    const current = klines[i];
    const struct = structures ? structures[i] : chanlunLib.computeChanlunStructures(prefix);
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
        symbol: opts.symbol || 'TEST',
        timeframe: 'daily',
        klines: prefix,
        currentIndex: i,
        currentKline: current,
        account: { initialCash, cash, equity: cash + marketValue, currency: 'CNY' },
        position,
        trades: trades.slice(),
        params: overrides,
        chanlun: struct,
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
          idx: i,
          date: current.date,
          action: 'BUY',
          price: current.close,
          shares: qty,
          value,
          fee,
          reason: decision.reason,
          score: decision.score,
        });
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
          idx: i,
          date: current.date,
          action: 'SELL',
          price: current.close,
          shares: qty,
          value,
          fee,
          reason: decision.reason,
        });
      }
    }
  }

  const lastClose = klines[klines.length - 1].close;
  return {
    cash,
    shares,
    equity: cash + shares * lastClose,
    trades,
    errors,
    initialCash,
  };
}

/**
 * 把成交流水配对成「完整交易」，并补上持仓期内的最大浮盈（MFE）。
 * 只统计已平仓的交易 —— 未平仓的不参与期望值，避免把浮盈当已实现。
 */
export function pairTrades(trades, klines) {
  const out = [];
  let open = null;
  for (const t of trades) {
    if (t.action === 'BUY') {
      if (!open) open = { entryIdx: t.idx, entryDate: t.date, cost: 0, qty: 0, entryPrice: t.price };
      open.cost += t.value + (t.fee || 0);
      open.qty += t.shares;
    } else if (open) {
      const partCost = (open.cost * t.shares) / open.qty;
      const net = t.value - (t.fee || 0) - partCost;
      let mfe = 0;
      for (let k = open.entryIdx; k <= t.idx; k++) {
        const r = (klines[k].high / open.entryPrice - 1) * 100;
        if (r > mfe) mfe = r;
      }
      out.push({
        entryDate: open.entryDate,
        exitDate: t.date,
        entryIdx: open.entryIdx,
        exitIdx: t.idx,
        entryPrice: open.entryPrice,
        exitPrice: t.price,
        holdBars: t.idx - open.entryIdx,
        retPct: (net / partCost) * 100,
        mfePct: mfe,
        reason: (t.reason || '').split(/[：:（(]/)[0] || '未标注',
        reasonFull: t.reason || '',
      });
      open.cost -= partCost;
      open.qty -= t.shares;
      if (open.qty <= 0) open = null;
    }
  }
  return out;
}

export function stats(values) {
  if (!values.length) return { n: 0, mean: 0, median: 0, winRate: 0 };
  const s = values.slice().sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const winRate = (values.filter((v) => v > 0).length / values.length) * 100;
  return { n: values.length, mean, median, winRate };
}
