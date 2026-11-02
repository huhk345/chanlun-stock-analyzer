/**
 * 新旧缠论实现对比校验脚本。
 *
 * 旧实现：git HEAD 中的 src/utils/chanlun.ts（自研分型/笔/线段/中枢/买卖点）。
 * 新实现：工作区 src/utils/chanlun.ts（czsc-core / czsc-signals 的 TS 等价移植）。
 *
 * 校验内容：
 *   1. 用 .cache/klines 真实日线，对比合并 K 线/分型/笔/线段/中枢/买卖点数量；
 *   2. 对比笔、中枢、买卖点的端点签名重合度，量化行为差异；
 *   3. 用 czsc-core Rust 单测中的 002515.SZ 38 根 K 线夹具，
 *      断言新实现输出与 Rust 期望的 4 笔逐字段一致。
 *
 * 运行：node scripts/compare-czsc-chanlun.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadModule(source, tag) {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const dir = mkdtempSync(path.join(tmpdir(), `chanlun-${tag}-`));
  const file = path.join(dir, `chanlun-${tag}.mjs`);
  writeFileSync(file, js);
  return import(pathToFileURL(file).href);
}

function summarize(lib, klines) {
  const s = lib.computeChanlunStructures(klines);
  const bsPoints = lib.calculateBSPoints(klines, s.strokes);
  const byType = {};
  for (const p of bsPoints) byType[p.type] = (byType[p.type] || 0) + 1;
  return { ...s, bsPoints, byType };
}

const strokeSig = (s) =>
  `${s.start.date}>${s.end.date}:${s.direction}:${s.start.price}-${s.end.price}`;
const hubSig = (h) => `${h.startIndex}-${h.endIndex}:${h.zg}-${h.zd}`;
const bsSig = (p) => `${p.type}@${p.date}:${p.price}`;

function overlap(a, b, keyFn) {
  const setB = new Set(b.map(keyFn));
  const matched = a.filter((x) => setB.has(keyFn(x))).length;
  return { matched, total: a.length, other: b.length };
}

function fmtOverlap(o) {
  return `${o.matched}/${o.total}（另一侧 ${o.other}）`;
}

// ---------------------------------------------------------------------------
// 1) 真实缓存数据对比
// ---------------------------------------------------------------------------

const samples = [
  '000001.SZ',
  '000300.SH',
  '002515.SZ',
  '300750.SZ',
  '600519.SH',
  '601318.SH',
];

const newLib = await loadModule(readFileSync(path.join(root, 'src/utils/chanlun.ts'), 'utf8'), 'new');
const oldSrc = execFileSync('git', ['show', 'HEAD:src/utils/chanlun.ts'], {
  cwd: root,
  encoding: 'utf8',
});
const oldLib = await loadModule(oldSrc, 'old');

console.log('\n=== 真实日线对比（旧实现 vs 新实现）===\n');
console.log(
  '标的'.padEnd(11) +
    'K线'.padStart(5) +
    ' | 合并K线 旧/新'.padEnd(16) +
    ' 分型'.padEnd(9) +
    ' 笔'.padEnd(9) +
    ' 线段'.padEnd(9) +
    ' 中枢'.padEnd(10) +
    ' 买卖点'.padEnd(10) +
    ' 笔重合',
);
console.log('-'.repeat(110));

let anySample = false;
for (const symbol of samples) {
  const file = path.join(root, '.cache/klines', `${symbol}_1d_forward.json`);
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.log(`${symbol.padEnd(11)} 跳过（缓存文件不存在）`);
    continue;
  }
  anySample = true;
  const klines = payload.klines;
  const oldR = summarize(oldLib, klines);
  const newR = summarize(newLib, klines);

  const cell = (o, n) => `${o}/${n}`;
  console.log(
    symbol.padEnd(11) +
      String(klines.length).padStart(5) +
      ' | ' +
      cell(oldR.mergedKlines.length, newR.mergedKlines.length).padEnd(16) +
      ' ' +
      cell(oldR.fractions.length, newR.fractions.length).padEnd(8) +
      ' ' +
      cell(oldR.strokes.length, newR.strokes.length).padEnd(8) +
      ' ' +
      cell(oldR.segments.length, newR.segments.length).padEnd(8) +
      ' ' +
      cell(oldR.hubs.length, newR.hubs.length).padEnd(9) +
      ' ' +
      cell(oldR.bsPoints.length, newR.bsPoints.length).padEnd(9) +
      ' ' +
      fmtOverlap(overlap(oldR.strokes, newR.strokes, strokeSig)),
  );

  console.log(
    `            买卖点分布  旧: ${JSON.stringify(oldR.byType)}  新: ${JSON.stringify(newR.byType)}`,
  );
  console.log(
    `            中枢签名重合 ${fmtOverlap(overlap(oldR.hubs, newR.hubs, hubSig))}` +
      `；买卖点签名重合 ${fmtOverlap(overlap(oldR.bsPoints, newR.bsPoints, bsSig))}`,
  );
}

if (!anySample) {
  console.log('未找到任何 .cache/klines 数据，跳过真实数据对比。');
}

// ---------------------------------------------------------------------------
// 2) czsc-core Rust 单测夹具：002515.SZ
// ---------------------------------------------------------------------------

const modPath = path.join(root, 'czsc-master/crates/czsc-core/src/analyze/mod.rs');
const modSrc = readFileSync(modPath, 'utf8');
const m = modSrc.match(/const CSV_DATA: &str = r#"\n([\s\S]*?)\n"#;/);
if (!m) throw new Error('未能从 czsc-core 单测中提取 CSV 夹具');

const fixtureKlines = m[1]
  .trim()
  .split('\n')
  .slice(1) // 表头 dt,symbol,open,close,high,low,vol,amount
  .map((line) => {
    const [date, , open, close, high, low, volume, amount] = line.split(',');
    return {
      date,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      amount: Number(amount),
    };
  });

// czsc-core/src/analyze/mod.rs::test_czsc_bi_list 的期望值
const expectedBis = [
  ['2025-01-13', '2025-01-17', 'up', 51.74, 45.47],
  ['2025-01-17', '2025-02-06', 'down', 51.74, 48.16],
  ['2025-02-06', '2025-02-11', 'up', 50.73, 48.16],
  ['2025-02-11', '2025-02-19', 'down', 50.73, 47.37],
];

const fixtureOld = summarize(oldLib, fixtureKlines);
const fixtureNew = summarize(newLib, fixtureKlines);
const newStrokes = fixtureNew.strokes;

console.log('\n=== czsc-core 单测夹具 002515.SZ（38 根日线）===\n');
console.log(
  `笔数量  期望 ${expectedBis.length}  旧 ${fixtureOld.strokes.length}  新 ${newStrokes.length}`,
);

let fixturePass = newStrokes.length === expectedBis.length;
for (let i = 0; i < expectedBis.length; i++) {
  const exp = expectedBis[i];
  const s = newStrokes[i];
  if (!s) {
    console.log(`  #${i} 缺失`);
    fixturePass = false;
    continue;
  }
  const high = Math.max(s.start.price, s.end.price);
  const low = Math.min(s.start.price, s.end.price);
  const ok =
    s.start.date.slice(0, 10) === exp[0] &&
    s.end.date.slice(0, 10) === exp[1] &&
    s.direction === exp[2] &&
    Math.abs(high - exp[3]) < 1e-4 &&
    Math.abs(low - exp[4]) < 1e-4;
  fixturePass = fixturePass && ok;
  console.log(
    `  #${i} ${ok ? 'PASS' : 'FAIL'}  ${s.start.date.slice(0, 10)} -> ${s.end.date.slice(0, 10)}  ` +
      `${s.direction}  high=${high} low=${low}` +
      (ok ? '' : `  期望 ${exp.join(' / ')}`),
  );
}

console.log(`\n夹具结论: ${fixturePass ? 'PASS' : 'FAIL'}`);
process.exitCode = fixturePass ? 0 : 1;
