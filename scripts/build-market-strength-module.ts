/**
 * 把 quant-research 的 market_strength_daily.csv 转成浏览器 / Node 均可直接 import
 * 的 TypeScript 数据模块。
 *
 * 用法:
 *   pnpm exec tsx scripts/build-market-strength-module.ts
 *   pnpm exec tsx scripts/build-market-strength-module.ts <input.csv> <output.ts>
 *
 * 只保留策略真正需要的四列: 日期 / 大盘强弱评分 / 买点温度 / 沪深300收盘。
 * 日期统一为 YYYY-MM-DD; 任一字段非有限数的行会被丢弃。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_INPUT = 'data/external/market_strength_daily.csv';
const DEFAULT_OUTPUT = 'server/strategies/data/market-strength.ts';

const inputPath = path.resolve(process.argv[2] ?? DEFAULT_INPUT);
const outputPath = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT);

if (!fs.existsSync(inputPath)) {
  console.error(`输入文件不存在: ${inputPath}`);
  process.exit(1);
}

const raw = fs.readFileSync(inputPath, 'utf-8').replace(/^\uFEFF/, '');
const lines = raw.trim().split(/\r?\n/);
if (lines.length < 2) {
  console.error('CSV 没有数据行');
  process.exit(1);
}

const header = lines[0].split(',').map((cell) => cell.trim());
const indexOf = (name: string): number => {
  const index = header.indexOf(name);
  if (index < 0) {
    console.error(`CSV 缺少列: ${name}`);
    process.exit(1);
  }
  return index;
};

const dateCol = indexOf('date');
const scoreCol = indexOf('score');
const tempCol = indexOf('temp');
const hs300Col = indexOf('hs300_000300');

const byDate = new Map<string, [string, number, number, number]>();

for (let i = 1; i < lines.length; i++) {
  const cells = lines[i].split(',');
  if (cells.length <= Math.max(dateCol, scoreCol, tempCol, hs300Col)) continue;

  const rawDate = cells[dateCol].trim();
  if (!/^\d{8}$/.test(rawDate)) continue;

  const score = Number(cells[scoreCol]);
  const temp = Number(cells[tempCol]);
  const hs300 = Number(cells[hs300Col]);
  if (!Number.isFinite(score) || !Number.isFinite(temp) || !Number.isFinite(hs300)) continue;

  const isoDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
  byDate.set(isoDate, [isoDate, round2(score), round2(temp), round2(hs300)]);
}

const rows = [...byDate.values()].sort((a, b) => a[0].localeCompare(b[0]));
if (rows.length === 0) {
  console.error('没有解析出有效数据行');
  process.exit(1);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

const body = rows
  .map(([date, score, temp, hs300]) => `  ['${date}', ${score}, ${temp}, ${hs300}],`)
  .join('\n');

const content = `/**
 * 大盘强弱 + 买点温度日度数据 (沪深300, 2007-12-04 起)。
 *
 * 由 scripts/build-market-strength-module.ts 从
 * data/external/market_strength_daily.csv 生成, 请勿手工编辑。
 *
 * 字段: [日期, 大盘强弱评分 0-100, 买点温度 0-100, 沪深300收盘]
 * 温度越低越冷/越便宜: <=25 冰点, 25-40 低估, 40-55 中性, 55-70 偏热, >70 过热。
 * 评分越高越强: 0-30 弱势, 30-45 偏弱, 45-60 中性, 60-75 偏强, 75-100 强势。
 */

export type MarketStrengthRow = readonly [
  date: string,
  score: number,
  temperature: number,
  hs300Close: number,
];

export const MARKET_STRENGTH_ROWS: readonly MarketStrengthRow[] = [
${body}
];
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, content, 'utf-8');

const first = rows[0];
const last = rows[rows.length - 1];
console.log(`[market-strength] 写入 ${rows.length} 行 → ${outputPath}`);
console.log(`[market-strength] 区间 ${first[0]} ~ ${last[0]}`);
