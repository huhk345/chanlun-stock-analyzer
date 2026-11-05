#!/usr/bin/env node
/**
 * 未来函数审计：把行情数据物理截断到 D 日，重跑 Rust 池子引擎，
 * 与全量数据的结果逐日逐标的对比。
 *
 * 判定标准：对任意 date <= D，全量与截断的决策 action 必须完全一致。
 * 同时记录 max_positions / slot_cash：引擎这两项由「全样本中位收盘价」推出，
 * 截断后若变化，说明仓位预算层依赖了未来数据。
 *
 * 用法: node scripts/audit-lookahead.mjs [--limit=120] [--cuts=2022-06-30,2024-05-31]
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join('/tmp', 'lookahead-audit');
const ENGINE = path.join(root, 'engine-rs/target/release/chanlun-engine-rs');

const args = process.argv.slice(2);
const arg = (k, d) => {
  const hit = args.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const LIMIT = Number(arg('limit', '100'));
const CUTS = arg('cuts', '2022-06-30,2024-05-31').split(',').filter(Boolean);
const STRATEGIES = arg('strategies', 'cl-trend-b3-pullback,cl-breakout-state').split(',');
const PORT = Number(arg('port', '8902'));
const START = arg('start', '2020-01-01');
const FULL_END = arg('end', '2026-10-28');
const SOURCE_DIR = arg('dir', '.cache/research/klines');
const MIN_POSITION_VALUE = arg('minPositionValue', null);

// ---------------------------------------------------------------------------
// 输入：hs300 成员前 N 个（引擎无 ST 名单可过滤，过滤/截断顺序与这里一致）
// ---------------------------------------------------------------------------

const members = JSON.parse(readFileSync(path.join(root, 'public/index-members.hs300.json'), 'utf8'));
const symbols = members.slice(0, LIMIT).map((s) => s.trim().toUpperCase());
const sourceDir = path.isAbsolute(SOURCE_DIR) ? SOURCE_DIR : path.join(root, SOURCE_DIR);

const raw = new Map();
for (const s of symbols) {
  const f = path.join(sourceDir, `${s}_1d_forward.json`);
  if (existsSync(f)) raw.set(s, JSON.parse(readFileSync(f, 'utf8')));
}
if (raw.size === 0) throw new Error('没有可用的 K 线缓存: ' + sourceDir);

/** 每个变体一份独立的 root：public 成员表 + 截断后的 .cache/klines */
function prepareRoot(tag, endDate) {
  const dir = path.join(TMP, tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'public'), { recursive: true });
  mkdirSync(path.join(dir, '.cache/klines'), { recursive: true });
  writeFileSync(path.join(dir, 'public/index-members.hs300.json'), JSON.stringify(symbols));
  for (const [s, d] of raw) {
    const bars = endDate === null ? d.klines : d.klines.filter((b) => b.date <= endDate);
    writeFileSync(
      path.join(dir, '.cache/klines', `${s}_1d_forward.json`),
      JSON.stringify({ ...d, klines: bars }),
    );
  }
  return dir;
}

async function waitHealth() {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/rust/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 用给定 root 起一次引擎、跑一次 sim、退出 */
async function runOne(rootDir, strategyId, endDate) {
  const child = spawn(ENGINE, ['--root', rootDir, '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => (log += c.toString()));
  child.stderr.on('data', (c) => (log += c.toString()));
  try {
    if (!(await waitHealth())) throw new Error(`引擎启动失败: ${log.slice(-800)}`);
    const res = await fetch(`http://127.0.0.1:${PORT}/api/rust/sim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        strategyId,
        pools: ['hs300'],
        limit: LIMIT,
        start: START,
        end: endDate,
        initialCash: 1_000_000,
        minPositionValue: MIN_POSITION_VALUE === null ? undefined : Number(MIN_POSITION_VALUE),
        autoRefresh: false,
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`sim 失败 (${res.status}): ${text.slice(0, 400)}`);
    return JSON.parse(text);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 400));
  }
}

function decisionsByDate(out) {
  const map = new Map();
  for (const day of out.days || []) {
    for (const d of day.decisions || []) map.set(`${day.date}|${d.symbol}`, { ...d, date: day.date });
  }
  return map;
}

function tradeKey(t) {
  return [
    t.date,
    t.symbol,
    t.action,
    t.shares.toFixed(4),
    t.price.toFixed(4),
    t.fee.toFixed(4),
    (t.pnl ?? 0).toFixed(4),
  ].join('|');
}

function compare(full, truncated, cut) {
  const a = decisionsByDate(full);
  const b = decisionsByDate(truncated);
  let checked = 0;
  let fullBuys = 0;
  let actionMismatch = 0;
  let reasonMismatch = 0;
  let missingInTruncated = 0;
  const examples = [];
  const sampleBuys = [];

  for (const [key, fa] of a) {
    if (fa.date > cut) continue;
    checked++;
    if (fa.action === 'BUY') {
      fullBuys++;
      const tb0 = b.get(key);
      if (sampleBuys.length < 5 && tb0 && tb0.action === 'BUY') {
        sampleBuys.push({
          date: fa.date,
          symbol: fa.symbol,
          full: fa.action,
          truncated: tb0.action,
          reason: (fa.reason || '').slice(0, 90),
        });
      }
    }
    const tb = b.get(key);
    if (!tb) {
      missingInTruncated++;
      continue;
    }
    if (fa.action !== tb.action) {
      actionMismatch++;
      if (examples.length < 8) {
        examples.push({
          date: fa.date,
          symbol: fa.symbol,
          full: fa.action,
          truncated: tb.action,
          fullReason: (fa.reason || '').slice(0, 80),
          truncReason: (tb.reason || '').slice(0, 80),
        });
      }
    } else if ((fa.reason || '') !== (tb.reason || '')) {
      reasonMismatch++;
    }
  }

  // 成交账本与逐日权益：比决策更严格，能发现影响仓位数量的差异
  const fullTrades = new Set(
    (full.trades || []).filter((t) => t.date <= cut).map(tradeKey),
  );
  const truncTrades = new Set(
    (truncated.trades || []).filter((t) => t.date <= cut).map(tradeKey),
  );
  let tradeMismatch = 0;
  for (const k of fullTrades) if (!truncTrades.has(k)) tradeMismatch++;
  for (const k of truncTrades) if (!fullTrades.has(k)) tradeMismatch++;

  let equityMismatch = 0;
  const fullDays = new Map((full.days || []).map((d) => [d.date, d]));
  for (const d of truncated.days || []) {
    const fd = fullDays.get(d.date);
    if (!fd) continue;
    if (Math.abs(fd.equity - d.equity) > 1e-6 || Math.abs(fd.cash - d.cash) > 1e-6) {
      equityMismatch++;
    }
  }

  return {
    checked,
    fullBuys,
    truncatedDecisions: b.size,
    missingInTruncated,
    actionMismatch,
    reasonMismatch,
    tradeCountFull: fullTrades.size,
    tradeCountTruncated: truncTrades.size,
    tradeMismatch,
    equityMismatch,
    examples,
    sampleBuys,
  };
}

// ---------------------------------------------------------------------------

rmSync(TMP, { recursive: true, force: true });
const fullRoot = prepareRoot('root-full', null);

const results = [];
for (const strategyId of STRATEGIES) {
  const full = await runOne(fullRoot, strategyId, FULL_END);
  const fullMeta = {
    universe: full.tested,
    maxPositions: full.max_positions,
    slotCash: full.slot_cash,
    trades: (full.trades || []).length,
  };

  for (const cut of CUTS) {
    const cutRoot = prepareRoot(`root-cut-${cut}`, cut);
    const trunc = await runOne(cutRoot, strategyId, cut);
    const cmp = compare(full, trunc, cut);
    results.push({
      strategyId,
      cut,
      full: fullMeta,
      truncated: {
        universe: trunc.tested,
        maxPositions: trunc.max_positions,
        slotCash: trunc.slot_cash,
        trades: (trunc.trades || []).length,
      },
      ...cmp,
    });
    console.log(
      `${strategyId} @ ${cut}: 检查 ${cmp.checked} 条非 HOLD 决策 · 买入 ${cmp.fullBuys} · ` +
        `action 不一致 ${cmp.actionMismatch} · reason 不一致 ${cmp.reasonMismatch} · ` +
        `成交 ${cmp.tradeCountFull}/${cmp.tradeCountTruncated} 不一致 ${cmp.tradeMismatch} · ` +
        `权益日不一致 ${cmp.equityMismatch} | slot_cash ${fullMeta.slotCash.toFixed(0)} → ${trunc.slot_cash.toFixed(0)}`,
    );
    for (const e of cmp.sampleBuys.slice(0, 3)) {
      console.log(`  ✓ ${e.date} ${e.symbol} 买入信号：全量=${e.full} / 截断=${e.truncated}`);
    }
    for (const e of cmp.examples) {
      console.log(`  ✗ ${e.date} ${e.symbol}: ${e.full} → ${e.truncated} | ${e.fullReason}`);
    }
  }
}

const outPath = path.join(root, 'reports/lookahead-audit.json');
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      source: SOURCE_DIR,
      symbols: raw.size,
      start: START,
      fullEnd: FULL_END,
      cuts: CUTS,
      results,
    },
    null,
    2,
  ),
);
console.log('\n结果写入 reports/lookahead-audit.json');

const fatal = results.filter(
  (r) => r.actionMismatch > 0 || r.missingInTruncated > 0 || r.tradeMismatch > 0,
);
if (fatal.length) {
  console.error(`存在 ${fatal.length} 组截断后结果不一致 —— 疑似未来函数`);
  process.exit(1);
}
console.log('全部截断对比：截至截断日的决策、成交、权益均与全量一致');
