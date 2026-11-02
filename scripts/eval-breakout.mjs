#!/usr/bin/env node
/**
 * 真实行情评估：把策略放到 .cache/klines 的日线上逐日跑，分两层看。
 *
 *   信号层 —— 每个 BUY 决策都当成一次假设入场，看之后 20/60/120 个交易日的
 *             前瞻收益。这一层不受离场规则和仓位槽位影响，是「入场有没有优势」
 *             的主证据（组合层总收益会被少数大赢家决定，不能用来判断策略好坏）。
 *   交易层 —— 真实逐日撮合出来的完整交易，看期望、胜率、持仓天数、离场归因。
 *
 * 另外按信号日当天的「池内广度」（有多少标的站上自己的 MA200）分档，
 * 用来检验那份报告的核心结论：广度是状态分类器，极端档位才该出手。
 *
 * 用法:
 *   node scripts/eval-breakout.mjs [--file=src/strategies/xxx.js] [--limit=200]
 *                                  [--params='{"breakoutDays":40}'] [--out=path.json]
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadChanlun, loadStrategy, runOne, pairTrades, stats, root } from './lib/strategy-sandbox.mjs';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function arg(name, def) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const STRATEGY_FILE = arg('file', 'src/strategies/cl-breakout-state.js');
const LIMIT = Number(arg('limit', '0')) || 0;
const OVERRIDES = JSON.parse(arg('params', '{}'));
const OUT = arg('out', 'reports/cl-breakout-state/eval.json');
const OUT_ABS = path.isAbsolute(OUT) ? OUT : path.join(root, OUT);
const WARMUP = Number(arg('warmup', '60'));
const SIGNAL_SCAN = arg('signals', '1') === '1';

// ---------------------------------------------------------------------------
// 载入行情
// ---------------------------------------------------------------------------

const KDIR = path.join(root, arg('dir', '.cache/klines'));
const files = readdirSync(KDIR).filter((f) => f.endsWith('_1d_forward.json')).sort();

const universe = [];
for (const f of files) {
  if (LIMIT && universe.length >= LIMIT) break;
  const d = JSON.parse(readFileSync(path.join(KDIR, f), 'utf8'));
  if (!d.klines || d.klines.length < 300) continue;
  universe.push({ symbol: d.symbol || f.split('_')[0], klines: d.klines });
}

// ---------------------------------------------------------------------------
// 池内广度：每个交易日有多少比例的标的收盘价在自身 MA200 上方
// （报告里的「51 个行业里几个站上年线」，这里用池内标的代替行业）
// ---------------------------------------------------------------------------

const MA_YEAR = 200;

function buildBreadth(pool) {
  const byDate = new Map(); // date -> {above, total}
  for (const { klines } of pool) {
    let sum = 0;
    const closes = klines.map((k) => k.close);
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= MA_YEAR) sum -= closes[i - MA_YEAR];
      if (i < MA_YEAR - 1) continue;
      const ma = sum / MA_YEAR;
      const d = klines[i].date;
      const rec = byDate.get(d) || { above: 0, total: 0 };
      rec.total++;
      if (closes[i] > ma) rec.above++;
      byDate.set(d, rec);
    }
  }
  const out = new Map();
  for (const [d, v] of byDate) out.set(d, v.total >= 30 ? (v.above / v.total) * 100 : null);
  return out;
}

const breadth = buildBreadth(universe);

// ---------------------------------------------------------------------------
// 基准前瞻收益：同样区间内「随便哪一天买入」的前瞻收益。
// 信号层必须跟这个比 —— 如果池子本身 60 天平均就涨 4%，那 +5.8% 的优势只有 1.8pp。
// ---------------------------------------------------------------------------

function buildBaseline(pool, warmup) {
  const acc = { fwd20: [], fwd60: [], fwd120: [] };
  for (const { klines } of pool) {
    for (let i = warmup; i < klines.length; i++) {
      const c = klines[i].close;
      for (const h of [20, 60, 120]) {
        const key = `fwd${h}`;
        if (i + h < klines.length) acc[key].push((klines[i + h].close / c - 1) * 100);
      }
    }
  }
  return {
    fwd20: stats(acc.fwd20),
    fwd60: stats(acc.fwd60),
    fwd120: stats(acc.fwd120),
  };
}

const baseline = buildBaseline(universe, WARMUP);

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

const chanlunLib = await loadChanlun();
const strategy = loadStrategy(STRATEGY_FILE);

const allTrades = [];
const signalRows = [];
const perSymbol = [];
let errors = 0;

const t0 = Date.now();
for (let s = 0; s < universe.length; s++) {
  const { symbol, klines } = universe[s];

  // ---- 交易层：真实逐日撮合 ----
  const result = runOne(chanlunLib, strategy, klines, {
    initialCash: 1_000_000,
    warmup: WARMUP,
    overrides: OVERRIDES,
    symbol,
  });
  errors += result.errors.length;
  const pairs = pairTrades(result.trades, klines);
  for (const p of pairs) {
    p.symbol = symbol;
    p.breadth = breadth.get(p.entryDate) ?? null;
    allTrades.push(p);
  }

  perSymbol.push({
    symbol,
    trades: pairs.length,
    returnPct: ((result.equity - result.initialCash) / result.initialCash) * 100,
    buyHoldPct: (klines[klines.length - 1].close / klines[WARMUP].close - 1) * 100,
  });

  // ---- 信号层：强制空仓，收集每个 BUY 决策日 ----
  if (SIGNAL_SCAN) {
    let cash = 1_000_000;
    for (let i = WARMUP; i < klines.length; i++) {
      const prefix = klines.slice(0, i + 1);
      const structures = chanlunLib.computeChanlunStructures(prefix);
      const cur = klines[i];
      const decision = strategy.decide({
        symbol,
        timeframe: 'daily',
        klines: prefix,
        currentIndex: i,
        currentKline: cur,
        account: { initialCash: 1_000_000, cash, equity: cash, currency: 'CNY' },
        position: {
          shares: 0,
          averageCost: 0,
          marketValue: 0,
          unrealizedPnl: 0,
          unrealizedPnlPercent: 0,
        },
        trades: [],
        params: OVERRIDES,
        chanlun: structures,
        currency: 'CNY',
        initialCash: 1_000_000,
      });
      if (decision && decision.action === 'BUY') {
        const fwd = (h) => (i + h < klines.length ? (klines[i + h].close / cur.close - 1) * 100 : null);
        signalRows.push({
          symbol,
          date: cur.date,
          idx: i,
          fwd20: fwd(20),
          fwd60: fwd(60),
          fwd120: fwd(120),
          breadth: breadth.get(cur.date) ?? null,
          score: decision.score ?? null,
        });
      }
    }
  }

  if ((s + 1) % 100 === 0) {
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    process.stderr.write(`  ${s + 1}/${universe.length} 标的 · ${el}s · 交易 ${allTrades.length} 笔\n`);
  }
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

function pct(v, digits = 2) {
  return v === null || v === undefined || !isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function bucket(rows, keyFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null) continue;
    const arr = map.get(k) || [];
    arr.push(r);
    map.set(k, arr);
  }
  return map;
}

const tradeRets = allTrades.map((t) => t.retPct);
const sTrades = stats(tradeRets);
const sMfe = stats(allTrades.map((t) => t.mfePct));

// 收益集中度：趋势型规则靠少数大赢家，必须把「前 5 笔占多少」摆出来，
// 否则一个 +200% 的样本就能把均值撑成正数。
const sortedRets = tradeRets.slice().sort((a, b) => b - a);
const totalPnl = tradeRets.reduce((a, b) => a + b, 0);
const top5Pnl = sortedRets.slice(0, 5).reduce((a, b) => a + b, 0);
const top5Share = Math.abs(totalPnl) > 1e-9 ? (top5Pnl / totalPnl) * 100 : 0;
const retSd = tradeRets.length
  ? Math.sqrt(tradeRets.reduce((a, b) => a + (b - sTrades.mean) ** 2, 0) / tradeRets.length)
  : 0;
const retSe = tradeRets.length ? retSd / Math.sqrt(tradeRets.length) : 0;

const exitCount = new Map();
for (const t of allTrades) exitCount.set(t.reason, (exitCount.get(t.reason) || 0) + 1);

const holdBars = allTrades.map((t) => t.holdBars);
const avgHold = holdBars.length ? holdBars.reduce((a, b) => a + b, 0) / holdBars.length : 0;

// 信号层
function fwdStats(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => x !== null);
  return stats(v);
}
const sig20 = fwdStats(signalRows, 'fwd20');
const sig60 = fwdStats(signalRows, 'fwd60');
const sig120 = fwdStats(signalRows, 'fwd120');

// 广度分档（信号层，60 日前瞻）
const bBuckets = bucket(signalRows, (r) => {
  if (r.breadth === null) return null;
  const b = r.breadth;
  if (b < 20) return '00-20%';
  if (b < 40) return '20-40%';
  if (b < 60) return '40-60%';
  if (b < 80) return '60-80%';
  return '80-100%';
});
const breadthTable = ['00-20%', '20-40%', '40-60%', '60-80%', '80-100%'].map((k) => {
  const rows = bBuckets.get(k) || [];
  const st = fwdStats(rows, 'fwd60');
  return { bucket: k, n: st.n, mean60: st.mean, median60: st.median, winRate: st.winRate };
});

// 交易层按广度分档
const tBuckets = bucket(allTrades, (t) => {
  if (t.breadth === null) return null;
  const b = t.breadth;
  if (b < 20) return '00-20%';
  if (b < 40) return '20-40%';
  if (b < 60) return '40-60%';
  if (b < 80) return '60-80%';
  return '80-100%';
});
const tradeBreadthTable = ['00-20%', '20-40%', '40-60%', '60-80%', '80-100%'].map((k) => {
  const rows = tBuckets.get(k) || [];
  const st = stats(rows.map((t) => t.retPct));
  return { bucket: k, n: st.n, mean: st.mean, median: st.median, winRate: st.winRate };
});

// 按年
const byYear = bucket(allTrades, (t) => t.entryDate.slice(0, 4));
const yearTable = [...byYear.entries()]
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([y, rows]) => {
    const st = stats(rows.map((t) => t.retPct));
    return { year: y, n: st.n, mean: st.mean, median: st.median, winRate: st.winRate };
  });

// 基准：池内买入持有
const bh = perSymbol.map((p) => p.buyHoldPct);
const sBh = stats(bh);
const withTrades = perSymbol.filter((p) => p.trades > 0);
const avgSymReturn = withTrades.length
  ? withTrades.reduce((a, b) => a + b.returnPct, 0) / withTrades.length
  : 0;

// ---------------------------------------------------------------------------
// 组合层：把逐笔交易拼成一条日频等权净值曲线。
// 单标的策略拿不到跨截面广度，所以「广度闸门」只能在组合层做 —— 这里正是
// 检验那份报告核心结论的地方：广度低的时候整体空仓，回撤是不是真的更小。
// ---------------------------------------------------------------------------

const klineBySymbol = new Map(universe.map((u) => [u.symbol, u.klines]));

function portfolioCurve(trades) {
  const byDate = new Map(); // date -> {sum, n}
  for (const t of trades) {
    const kl = klineBySymbol.get(t.symbol);
    if (!kl) continue;
    for (let k = t.entryIdx + 1; k <= t.exitIdx; k++) {
      const r = kl[k].close / kl[k - 1].close - 1;
      const d = kl[k].date;
      const rec = byDate.get(d) || { sum: 0, n: 0 };
      rec.sum += r;
      rec.n++;
      byDate.set(d, rec);
    }
  }
  const dates = [...byDate.keys()].sort();
  if (dates.length < 30) return null;
  const rets = dates.map((d) => byDate.get(d).sum / byDate.get(d).n);
  // 平均同时持仓数：等权组合里同时在场的标的个数，比「在场天数占比」有意义
  const avgPositions = dates.reduce((a, d) => a + byDate.get(d).n, 0) / dates.length;

  let eq = 1;
  let peak = 1;
  let maxDD = 0;
  for (const r of rets) {
    eq *= 1 + r;
    if (eq > peak) peak = eq;
    const dd = eq / peak - 1;
    if (dd < maxDD) maxDD = dd;
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  const years = dates.length / 244;
  return {
    days: dates.length,
    totalReturn: (eq - 1) * 100,
    cagr: (Math.pow(eq, 1 / years) - 1) * 100,
    vol: sd * Math.sqrt(244) * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(244) : 0,
    maxDD: maxDD * 100,
    avgPositions,
  };
}

const curves = {
  all: portfolioCurve(allTrades),
  breadth40: portfolioCurve(allTrades.filter((t) => t.breadth !== null && t.breadth >= 40)),
  breadth60: portfolioCurve(allTrades.filter((t) => t.breadth !== null && t.breadth >= 60)),
};

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const summary = {
  meta: {
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    strategy: strategy.id,
    strategyName: strategy.name,
    strategyFile: STRATEGY_FILE,
    params: OVERRIDES,
    universeSize: universe.length,
    warmup: WARMUP,
    dataRange:
      universe.length && universe[0].klines.length
        ? `${universe[0].klines[0].date} → ${universe[0].klines[universe[0].klines.length - 1].date}`
        : '',
    errors,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
  },
  signalLayer: {
    n: signalRows.length,
    fwd20: sig20,
    fwd60: sig60,
    fwd120: sig120,
    baseline,
    excess60: sig60.mean - baseline.fwd60.mean,
    excess120: sig120.mean - baseline.fwd120.mean,
    byBreadth: breadthTable,
  },
  tradeLayer: {
    n: sTrades.n,
    mean: sTrades.mean,
    median: sTrades.median,
    winRate: sTrades.winRate,
    sd: retSd,
    se: retSe,
    top5Share,
    avgHoldBars: avgHold,
    mfeMean: sMfe.mean,
    exits: Object.fromEntries(exitCount),
    byBreadth: tradeBreadthTable,
    byYear: yearTable,
  },
  benchmark: {
    poolBuyHoldMean: sBh.mean,
    poolBuyHoldMedian: sBh.median,
    symbolsWithTrades: withTrades.length,
    avgSymbolReturn: avgSymReturn,
  },
  portfolio: curves,
  perSymbol: perSymbol.slice(0, 40),
};

mkdirSync(path.dirname(OUT_ABS), { recursive: true });
writeFileSync(OUT_ABS, JSON.stringify(summary, null, 2));

const line = (s) => console.log(s);
line('');
line(`策略 ${strategy.name} (${strategy.id})  ·  池 ${universe.length} 只  ·  ${summary.meta.dataRange}`);
line(`参数 ${JSON.stringify(OVERRIDES)}  ·  耗时 ${summary.meta.elapsedSec}s  ·  异常 ${errors}`);
line('');
line('── 信号层（每个 BUY 决策当成一次假设入场）─────────────────────────');
line(`信号 ${signalRows.length} 个  ·  基准 = 同区间任意一天买入（全部标的全部交易日）`);
line(
  `  前瞻 20 日  信号 ${pct(sig20.mean).padStart(8)} / 基准 ${pct(baseline.fwd20.mean).padStart(8)}  ` +
    `超额 ${pct(sig20.mean - baseline.fwd20.mean).padStart(8)}  胜率 ${sig20.winRate.toFixed(0)}%  n=${sig20.n}`,
);
line(
  `  前瞻 60 日  信号 ${pct(sig60.mean).padStart(8)} / 基准 ${pct(baseline.fwd60.mean).padStart(8)}  ` +
    `超额 ${pct(sig60.mean - baseline.fwd60.mean).padStart(8)}  胜率 ${sig60.winRate.toFixed(0)}%  n=${sig60.n}`,
);
line(
  `  前瞻 120 日 信号 ${pct(sig120.mean).padStart(8)} / 基准 ${pct(baseline.fwd120.mean).padStart(8)}  ` +
    `超额 ${pct(sig120.mean - baseline.fwd120.mean).padStart(8)}  胜率 ${sig120.winRate.toFixed(0)}%  n=${sig120.n}`,
);
line('');
line('── 交易层（真实逐日撮合，含费用）─────────────────────────────────');
line(
  `  ${sTrades.n} 笔 · 均值 ${pct(sTrades.mean)} · 中位 ${pct(sTrades.median)} · ` +
    `胜率 ${sTrades.winRate.toFixed(0)}% · 平均持仓 ${avgHold.toFixed(0)} 日 · 平均 MFE ${pct(sMfe.mean)}`,
);
line(
  `  标准差 ${retSd.toFixed(1)}pp · 标准误 ${retSe.toFixed(2)}pp · ` +
    `前 5 笔占总盈亏 ${top5Share.toFixed(0)}% · 最差 ${pct(sortedRets[sortedRets.length - 1], 1)}`,
);
line('  离场归因: ' + [...exitCount.entries()].map(([k, v]) => `${k}×${v}`).join('  '));
line('');
line('── 广度分档（信号日池内站上 MA200 的比例）──────────────────────');
line('  档位       信号数  前瞻60日均值  中位      胜率   |  交易笔数  单笔均值   中位      胜率');
for (let k = 0; k < breadthTable.length; k++) {
  const a = breadthTable[k];
  const b = tradeBreadthTable[k];
  line(
    `  ${a.bucket.padEnd(9)} ${String(a.n).padStart(5)}  ${pct(a.mean60).padStart(11)}  ` +
      `${pct(a.median60).padStart(9)}  ${a.winRate.toFixed(0).padStart(3)}%  |  ` +
      `${String(b.n).padStart(7)}  ${pct(b.mean).padStart(9)}  ${pct(b.median).padStart(9)}  ` +
      `${b.winRate.toFixed(0).padStart(3)}%`,
  );
}
line('');
line('── 分年（交易层）───────────────────────────────────────────────');
for (const y of yearTable) {
  line(
    `  ${y.year}  ${String(y.n).padStart(4)} 笔  均值 ${pct(y.mean).padStart(8)}  中位 ` +
      `${pct(y.median).padStart(8)}  胜率 ${y.winRate.toFixed(0).padStart(3)}%`,
  );
}
line('');
line('── 组合层（逐笔交易拼成日频等权净值，不加杠杆、不加槽位上限）──────────');
line('  变体              年化     波动    Sharpe   最大回撤   平均持仓数   交易日');
const curveNames = [
  ['all', '全部信号'],
  ['breadth40', '广度≥40% 才持仓'],
  ['breadth60', '广度≥60% 才持仓'],
];
for (const [key, label] of curveNames) {
  const cv = curves[key];
  if (!cv) {
    line(`  ${label.padEnd(16)} —`);
    continue;
  }
  line(
    `  ${label.padEnd(16)} ${pct(cv.cagr, 1).padStart(7)} ${pct(cv.vol, 1).padStart(8)}  ` +
      `${cv.sharpe.toFixed(2).padStart(6)}  ${pct(cv.maxDD, 1).padStart(8)}  ` +
      `${cv.avgPositions.toFixed(1).padStart(9)}  ${String(cv.days).padStart(6)}`,
  );
}
line('');
line('── 基准 ────────────────────────────────────────────────────────');
line(
  `  池内买入持有（中位）${pct(sBh.median)} · （均值）${pct(sBh.mean)} · ` +
    `有交易的标的 ${withTrades.length} 只，单标的平均收益 ${pct(avgSymReturn)}`,
);
line('');
line(`结果已写入 ${OUT}`);
