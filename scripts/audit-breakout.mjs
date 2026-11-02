#!/usr/bin/env node
/**
 * 「拨一格」审计：每个参数/条件单独拨动一步，看输出变不变。
 *
 * 目的不是找最优值，而是找**死旋钮**。面板上的旋钮如果拨了没反应，只会让人
 * 产生「调了有效果」的错觉；反过来说，一个参数在两个股票池上最优值相反，
 * 说明它在押池子而不是在描述规律。
 *
 * 缠论结构与 K 线前缀跟参数无关，所以按标的一次性算好，再让所有配置复用 ——
 * 否则 15 个配置要重算 15 遍缠论。
 *
 * 用法: node scripts/audit-breakout.mjs [--file=...] [--limit=0] [--only=名字子串]
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadChanlun, loadStrategy, runOne, pairTrades, stats, root } from './lib/strategy-sandbox.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const STRATEGY_FILE = arg('file', 'src/strategies/cl-breakout-state.js');
const LIMIT = Number(arg('limit', '0')) || 0;
const ONLY = arg('only', '');
const WARMUP = 60;

// ---------------------------------------------------------------------------
// 配置矩阵：base + 单格扰动 + 消融
// ---------------------------------------------------------------------------

const CONFIGS = [
  { name: 'base', params: {} },
  // —— 消融：把某道闸门整个关掉 ——
  {
    name: 'ablate:年线闸门',
    params: {},
    patches: [
      ['if (!(c > maNow)) return null;', ''],
      ['if (!(maNow > maPrev)) return null;', ''],
    ],
  },
  {
    name: 'ablate:年线上行',
    params: {},
    patches: [['if (!(maNow > maPrev)) return null;', '']],
  },
  { name: 'ablate:离开力度(depart=0)', params: { departRatio: 0 } },
  { name: 'ablate:放量(vol=0.8)', params: { volRatio: 0.8 } },
  // —— 浮盈保护 ——
  {
    name: 'protect 0%(进场即保护)',
    params: {},
    patches: [['if (peakPct >= cfg.protectAfterPct) {', 'if (peakPct >= -100) {']],
  },
  { name: 'protect 5%', params: { protectAfterPct: 5 } },
  { name: 'protect 15%', params: { protectAfterPct: 15 } },
  { name: 'protect 20%', params: { protectAfterPct: 20 } },
  {
    name: '回吐保留 0.35',
    params: {},
    patches: [['const GIVEBACK_KEEP = 0.5;', 'const GIVEBACK_KEEP = 0.35;']],
  },
  {
    name: '回吐保留 0.65',
    params: {},
    patches: [['const GIVEBACK_KEEP = 0.5;', 'const GIVEBACK_KEEP = 0.65;']],
  },
  // —— 单格扰动 ——
  { name: 'breakoutDays 20', params: { breakoutDays: 20 } },
  { name: 'breakoutDays 120', params: { breakoutDays: 120 } },
  { name: 'volRatio 2.0', params: { volRatio: 2.0 } },
  { name: 'departRatio 0.3', params: { departRatio: 0.3 } },
  { name: 'departRatio 1.0', params: { departRatio: 1.0 } },
];

const configs = ONLY ? CONFIGS.filter((c) => c.name.includes(ONLY) || c.name === 'base') : CONFIGS;

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

const chanlunLib = await loadChanlun();
const strategies = configs.map((c) => ({
  ...c,
  strat: loadStrategy(STRATEGY_FILE, c.patches || []),
}));

const results = configs.map(() => ({ trades: [], symbolsWithTrades: 0, errors: 0 }));

// ---------------------------------------------------------------------------
// 外层标的、内层配置：缠论只算一遍
// ---------------------------------------------------------------------------

const t0 = Date.now();
for (let s = 0; s < universe.length; s++) {
  const { symbol, klines } = universe[s];

  const prefixes = new Array(klines.length);
  const structures = new Array(klines.length);
  for (let i = WARMUP; i < klines.length; i++) {
    const p = klines.slice(0, i + 1);
    prefixes[i] = p;
    structures[i] = chanlunLib.computeChanlunStructures(p);
  }

  for (let c = 0; c < strategies.length; c++) {
    const { strat, params } = strategies[c];
    const r = runOne(chanlunLib, strat, klines, {
      initialCash: 1_000_000,
      warmup: WARMUP,
      overrides: params,
      symbol,
      prefixes,
      structures,
    });
    results[c].errors += r.errors.length;
    const pairs = pairTrades(r.trades, klines);
    if (pairs.length) results[c].symbolsWithTrades++;
    for (const p of pairs) {
      p.symbol = symbol;
      results[c].trades.push(p);
    }
  }

  if ((s + 1) % 100 === 0) {
    process.stderr.write(
      `  ${s + 1}/${universe.length} 标的 · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 2) => (v >= 0 ? '+' : '') + v.toFixed(n);
const sp = (s, n) => String(s).padStart(n);

console.log('');
console.log(`策略 ${strategies[0].strat.name}  ·  池 ${universe.length} 只  ·  配置 ${configs.length} 个`);
console.log(
  `耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s  ·  异常 ${results.reduce((a, b) => a + b.errors, 0)} 条`,
);
console.log('');
console.log(
  pad('配置', 24) +
    sp('笔数', 6) +
    sp('均值', 8) +
    sp('中位', 8) +
    sp('胜率', 6) +
    sp('持仓', 6) +
    sp('标准差', 8) +
    sp('最差', 8) +
    sp('前5占比', 9) +
    sp('拦掉均益', 10) +
    '  离场',
);
console.log('─'.repeat(136));

const baseMean = stats(results[0].trades.map((t) => t.retPct)).mean;
const baseN = results[0].trades.length;
const baseSum = results[0].trades.reduce((a, t) => a + t.retPct, 0);
for (let c = 0; c < configs.length; c++) {
  const rows = results[c].trades;
  const st = stats(rows.map((t) => t.retPct));
  const hold = rows.length ? rows.reduce((a, b) => a + b.holdBars, 0) / rows.length : 0;
  const rets = rows.map((t) => t.retPct);
  const mean = st.mean;
  const sd = rets.length
    ? Math.sqrt(rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rets.length)
    : 0;
  const worst = rets.length ? Math.min(...rets) : 0;
  const total = rets.reduce((a, b) => a + b, 0);
  const top5 = rets
    .slice()
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((a, b) => a + b, 0);
  const top5Share = Math.abs(total) > 1e-9 ? (top5 / total) * 100 : 0;

  const exits = new Map();
  for (const t of rows) exits.set(t.reason, (exits.get(t.reason) || 0) + 1);
  const exitText = [...exits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}${v}`)
    .join(' ');

  // 1 个标准误，用来判断差异是不是落在噪声里
  const se = rets.length ? sd / Math.sqrt(rets.length) : 0;
  const diff = mean - baseMean;
  const mark = c === 0 ? '' : Math.abs(diff) < se ? '  ← 噪声内' : '';

  // 消融时：被这道闸门拦掉的那批交易，平均收益是多少？
  // 这个数比「均值差」好读 —— 拦掉的若是 0 期望的交易，闸门就是有用的；
  // 拦掉的若是 +4% 的交易，闸门就是在砍收益。
  // 只在「多出至少 20 笔」时才算：退出参数改动会让成交集合整体漂移，
  // 那时多出来的几笔不是「被拦掉的」，算出来没有意义。
  let blocked = sp('', 10);
  if (c > 0) {
    const extra = st.n - baseN;
    blocked = extra >= 20 ? sp(num((total - baseSum) / extra, 1), 10) : sp('—', 10);
  }

  console.log(
    pad(configs[c].name, 24) +
      sp(st.n, 6) +
      sp(num(mean), 8) +
      sp(num(st.median), 8) +
      sp(st.winRate.toFixed(0) + '%', 6) +
      sp(hold.toFixed(0), 6) +
      sp(sd.toFixed(1), 8) +
      sp(num(worst, 1), 8) +
      sp(top5Share.toFixed(0) + '%', 9) +
      blocked +
      '  ' +
      exitText +
      mark,
  );
}
console.log('');
console.log('「噪声内」= 与 base 的均值差小于 1 个标准误（sd/√n），这类差异不能当结论用。');
console.log('「拦掉均益」= 消融后多出来的那批交易的平均收益；≈0 说明这道闸门拦的是零期望交易。');
