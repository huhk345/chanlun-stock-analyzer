/**
 * 批量下载沪深300和中证500成分股近10年日K线数据
 *
 * 用法:
 *   npx tsx scripts/download-index-stocks.ts [--index hs300|zz500|all] [--output dir]
 *
 * 数据源:
 *   - 成分股列表: AKShare (Python) -> 中证指数公司
 *   - K线数据: TickFlow API (免费/付费)
 *
 * 输出:
 *   data/hs300.csv  (合并CSV, 含 symbol 列)
 *   data/zz500.csv
 *   data/hs300/_constituents.json
 *   data/zz500/_constituents.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { acquireTickFlowSlot } from '../src/utils/rateLimiter';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TICKFLOW_API_KEY = process.env.VITE_TICKFLOW_API_KEY || '';
const TICKFLOW_BASE_URL = TICKFLOW_API_KEY
  ? 'https://api.tickflow.org'
  : 'https://free-api.tickflow.org';

const DEFAULT_OUTPUT_DIR = path.resolve(import.meta.dirname, '..', 'data');

// 10年交易日 ≈ 3650天
const KLINE_COUNT = 3650;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Kline {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

// ---------------------------------------------------------------------------
// 解析命令行参数
// ---------------------------------------------------------------------------

function parseArgs(): { index: string; output: string } {
  const args = process.argv.slice(2);
  let index = 'all';
  let output = DEFAULT_OUTPUT_DIR;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--index' && args[i + 1]) {
      index = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[i + 1];
      i++;
    }
  }

  return { index, output };
}

// ---------------------------------------------------------------------------
// 获取指数成分股列表 (通过 AKShare Python 库)
// ---------------------------------------------------------------------------

const INDEX_CONFIG: Record<string, { name: string; code: string }> = {
  hs300: { name: '沪深300', code: '000300' },
  zz500: { name: '中证500', code: '000905' },
};

async function fetchConstituents(indexCode: string): Promise<string[]> {
  console.log(`[成分股] 通过 AKShare 获取指数 ${indexCode} 成分股列表...`);

  const pythonCode = [
    'import akshare as ak',
    'import json',
    'import sys',
    'try:',
    `    df = ak.index_stock_cons_csindex(symbol="${indexCode}")`,
    '    codes = df["成分券代码"].tolist()',
    '    symbols = []',
    '    for code in codes:',
    '        code = str(code).zfill(6)',
    '        if code.startswith(("60","68","90","11","13","51","58")):',
    '            symbols.append(f"{code}.SH")',
    '        else:',
    '            symbols.append(f"{code}.SZ")',
    '    print(json.dumps(symbols))',
    'except Exception as e:',
    '    print(json.dumps({"error": str(e)}), file=sys.stderr)',
    '    sys.exit(1)',
  ].join('\n');

  // Write to temp file to avoid shell escaping issues
  const tmpFile = `/tmp/_fetch_constituents_${indexCode}.py`;
  fs.writeFileSync(tmpFile, pythonCode, 'utf-8');

  try {
    const result = execSync(`python3 ${tmpFile}`, {
      encoding: 'utf-8',
      timeout: 60000,
    });

    const symbols: string[] = JSON.parse(result.trim());
    console.log(`[成分股] 获取到 ${symbols.length} 只成分股`);
    return symbols;
  } catch (err: any) {
    const stderr = err.stderr?.toString() || '';
    throw new Error(`AKShare 获取成分股失败: ${stderr || err.message}`);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 下载单只股票K线数据 (TickFlow API)
// ---------------------------------------------------------------------------

async function fetchKlines(symbol: string, maxRetries = 3): Promise<Kline[] | null> {
  const url = `${TICKFLOW_BASE_URL}/v1/klines?symbol=${symbol}&period=1d&count=${KLINE_COUNT}&adjust=forward`;
  const headers: Record<string, string> = {};
  if (TICKFLOW_API_KEY) headers['x-api-key'] = TICKFLOW_API_KEY;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Proactively throttle to 55/min, under the free tier's 60/min cap.
      await acquireTickFlowSlot();
      const resp = await fetch(url, { headers });
      if (resp.status === 429) {
        // 限流: 等待后重试
        const waitMs = attempt * 5000;
        if (attempt < maxRetries) {
          process.stdout.write(` [429重试${attempt}/${maxRetries}, 等${waitMs / 1000}s]`);
          await delay(waitMs);
          continue;
        }
        console.error(`  [失败] ${symbol}: HTTP 429 (重试${maxRetries}次后仍限流)`);
        return null;
      }
      if (!resp.ok) {
        console.error(`  [失败] ${symbol}: HTTP ${resp.status}`);
        return null;
      }

      const json = await resp.json();
      if (!json?.data) {
        console.error(`  [失败] ${symbol}: 无数据`);
        return null;
      }

      const data = json.data;
      const len = data.timestamp?.length || 0;
      if (len === 0) {
        console.error(`  [失败] ${symbol}: 无K线数据`);
        return null;
      }

      const klines: Kline[] = [];
      const CHINA_OFFSET = 8 * 60 * 60 * 1000;
      for (let i = 0; i < len; i++) {
        const d = new Date(data.timestamp[i] + CHINA_OFFSET);
        const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
        klines.push({
          date: dateStr,
          open: +Number(data.open[i]).toFixed(2),
          high: +Number(data.high[i]).toFixed(2),
          low: +Number(data.low[i]).toFixed(2),
          close: +Number(data.close[i]).toFixed(2),
          volume: data.volume[i] || 0,
          amount: data.amount[i] || 0,
        });
      }

      return klines;
    } catch (err: any) {
      if (attempt < maxRetries) {
        await delay(3000);
        continue;
      }
      console.error(`  [失败] ${symbol}: ${err.message}`);
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 延迟
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const { index, output } = parseArgs();

  console.log('========================================');
  console.log('  批量下载指数成分股K线数据');
  console.log(`  指数: ${index}`);
  console.log(`  数据量: 近10年日K线 (~${KLINE_COUNT}天)`);
  console.log(`  输出: ${output}`);
  console.log(`  API: ${TICKFLOW_API_KEY ? 'TickFlow 完整服务' : 'TickFlow 免费API'}`);
  console.log('========================================\n');

  // 确定要下载的指数
  const indices = index === 'all'
    ? Object.keys(INDEX_CONFIG)
    : [index];

  for (const idx of indices) {
    const config = INDEX_CONFIG[idx];
    if (!config) {
      console.error(`未知指数: ${idx}, 可选: hs300, zz500, all`);
      continue;
    }

    console.log(`\n--- ${config.name} (${config.code}) ---\n`);

    // 获取成分股列表
    let symbols: string[];
    try {
      symbols = await fetchConstituents(config.code);
    } catch (err: any) {
      console.error(`获取 ${config.name} 成分股失败: ${err.message}`);
      continue;
    }

    if (symbols.length === 0) {
      console.error(`未获取到 ${config.name} 成分股`);
      continue;
    }

    // 创建输出目录
    const indexDir = path.join(output, idx);
    fs.mkdirSync(indexDir, { recursive: true });

    // 保存成分股列表
    const listPath = path.join(indexDir, '_constituents.json');
    fs.writeFileSync(listPath, JSON.stringify(symbols, null, 2), 'utf-8');
    console.log(`[保存] 成分股列表 -> ${listPath}\n`);

    // 逐个下载K线数据
    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const filePath = path.join(indexDir, `${symbol}.csv`);

      // 跳过已存在的文件
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > 100) {
          skipped++;
          if (i % 50 === 0 || i === symbols.length - 1) {
            console.log(`  [${i + 1}/${symbols.length}] 跳过 ${symbol} (已存在)`);
          }
          continue;
        }
      }

      process.stdout.write(`  [${i + 1}/${symbols.length}] ${symbol} ...`);

      const klines = await fetchKlines(symbol);

      if (klines && klines.length > 0) {
        const csvLines = klines.map((k: any) =>
          `${k.date},${k.open},${k.high},${k.low},${k.close},${k.volume},${k.amount}`
        );
        fs.writeFileSync(filePath, 'date,open,high,low,close,volume,amount\n' + csvLines.join('\n') + '\n', 'utf-8');
        const first = klines[0].date;
        const last = klines[klines.length - 1].date;
        console.log(` OK (${klines.length}根, ${first} ~ ${last})`);
        success++;
      } else {
        console.log(` 失败`);
        failed++;
      }

      // Throttling to stay under 55/min is handled inside fetchKlines via
      // acquireTickFlowSlot(); no extra fixed delay needed here.
    }

    console.log(`\n--- ${config.name} 下载完成 ---`);
    console.log(`  成功: ${success} | 失败: ${failed} | 跳过: ${skipped} | 总计: ${symbols.length}`);

    // 合并为单文件 CSV 并删除临时文件
    console.log(`\n合并 ${idx} CSV 文件...`);
    const mergePath = path.join(output, `${idx}.csv`);
    const outStream = fs.createWriteStream(mergePath, 'utf-8');
    outStream.write('symbol,date,open,high,low,close,volume,amount\n');
    const csvFiles = fs.readdirSync(indexDir).filter((f) => f.endsWith('.csv'));
    for (const csvFile of csvFiles) {
      const sym = csvFile.replace('.csv', '');
      const csvRaw = fs.readFileSync(path.join(indexDir, csvFile), 'utf-8');
      const csvLines = csvRaw.trim().split('\n');
      for (let j = 1; j < csvLines.length; j++) {
        outStream.write(`${sym},${csvLines[j]}\n`);
      }
    }
    outStream.end();
    // 删除临时 CSV 文件
    for (const csvFile of csvFiles) {
      fs.unlinkSync(path.join(indexDir, csvFile));
    }
    console.log(`  → ${mergePath} (已删除 ${csvFiles.length} 个临时文件)`);
  }

  console.log('\n========================================');
  console.log('  全部完成!');
  console.log('========================================');
}

main().catch(err => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});
