/**
 * 缠论日报 CLI 脚本
 *
 * 用法:
 *   npx tsx scripts/chanlun-report.ts [--stocks 000001,600519] [--output dir] [--notify console|serverchan|email|issue]
 *
 * 功能:
 *   1. 获取指定股票的日K线数据 (TickFlow API)
 *   2. 计算缠论结构 (分型、笔、线段、中枢)
 *   3. 调用 LLM 生成缠论分析 + 仓位管理建议
 *   4. 通过 Exa 检索财联社(cls.cn)资讯并由 LLM 总结 (个股消息面)
 *   5. 全部个股分析后, 通过 Exa 检索财联社热点 & 板块并总结 (市场总览)
 *   6. 输出 Markdown 报告
 *   7. 支持多种通知方式 (Server酱/微信、邮件、GitHub Issue)
 */

import Exa from 'exa-js';
import * as fs from 'fs';
import * as path from 'path';

// 手动加载 .env 文件 (CLI 环境下不会自动加载)
function loadEnvFile(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (key && rest.length > 0) {
      const value = rest.join('=').trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  }
}
loadEnvFile();

// ---------------------------------------------------------------------------
// Types (from src/types/stock.ts — duplicated for standalone CLI usage)
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

interface MergedKline {
  high: number;
  low: number;
  direction: 'up' | 'down';
  originalIndices: number[];
  originalHigh: number;
  originalLow: number;
}

type FractionType = 'TOP' | 'BOTTOM';

interface Fraction {
  type: FractionType;
  price: number;
  index: number;
  originalIndex: number;
  date: string;
}

interface Stroke {
  id: string;
  start: Fraction;
  end: Fraction;
  direction: 'up' | 'down';
}

interface Segment {
  id: string;
  start: Fraction;
  end: Fraction;
  direction: 'up' | 'down';
}

interface Hub {
  id: string;
  zg: number;
  zd: number;
  gg: number;
  dd: number;
  startIndex: number;
  endIndex: number;
  strokesCount: number;
  level: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TICKFLOW_API_KEY = process.env.VITE_TICKFLOW_API_KEY || '';
const TICKFLOW_BASE_URL = TICKFLOW_API_KEY
  ? 'https://api.tickflow.org'
  : 'https://free-api.tickflow.org';
const OPENCODE_API_KEY = process.env.VITE_OPENCODE_API_KEY || '';
const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-v4-flash-free';

// Exa 搜索 API (用于抓取财联社新闻/热点) — https://exa.ai
let _exa: Exa | null = null;
function getExaClient(): Exa | null {
  const key = process.env.EXA_API_KEY;
  if (!key) return null;
  if (!_exa) _exa = new Exa(key);
  return _exa;
}


// 主要指数
const MAJOR_INDICES: { symbol: string; name: string }[] = [
  { symbol: '000001.SH', name: '上证指数' },
  { symbol: '399001.SZ', name: '深证成指' },
  { symbol: '399006.SZ', name: '创业板指' },
  { symbol: '000688.SH', name: '科创50' },
  { symbol: '000300.SH', name: '沪深300' },
];

interface IndexQuote {
  name: string;
  price: number;
  changePercent: string;
}

async function fetchIndexQuotes(): Promise<IndexQuote[]> {
  const results: IndexQuote[] = [];
  for (const idx of MAJOR_INDICES) {
    try {
      const url = `${TICKFLOW_BASE_URL}/v1/klines?symbol=${idx.symbol}&period=1d&count=2`;
      const headers: Record<string, string> = {};
      if (TICKFLOW_API_KEY) headers['x-api-key'] = TICKFLOW_API_KEY;
      const resp = await fetch(url, { headers });
      if (!resp.ok) continue;
      const json = await resp.json();
      const data = json?.data;
      const len = data?.close?.length || 0;
      if (len < 2) continue;
      const price = data.close[len - 1];
      const prevClose = data.close[len - 2];
      const pct = prevClose !== 0 ? ((price - prevClose) / prevClose * 100) : 0;
      const sign = pct >= 0 ? '+' : '';
      results.push({ name: idx.name, price, changePercent: `${sign}${pct.toFixed(2)}%` });
    } catch { /* skip */ }
  }
  return results;
}

// 默认分析的股票列表 (可通过 --stocks 参数覆盖)
const DEFAULT_STOCKS = [
  '000001', // 平安银行
  '600519', // 贵州茅台
  '000858', // 五粮液
  '601318', // 中国平安
  '300750', // 宁德时代
];

// ---------------------------------------------------------------------------
// ChanLun computation (from src/utils/chanlun.ts — standalone)
// ---------------------------------------------------------------------------

function mergeKlines(klines: Kline[]): MergedKline[] {
  if (klines.length === 0) return [];
  const merged: MergedKline[] = [];
  merged.push({
    high: klines[0].high, low: klines[0].low, direction: 'up',
    originalIndices: [0], originalHigh: klines[0].high, originalLow: klines[0].low,
  });
  for (let i = 1; i < klines.length; i++) {
    const k = klines[i];
    const last = merged[merged.length - 1];
    const lastContainsCurrent = last.high >= k.high && last.low <= k.low;
    const currentContainsLast = k.high >= last.high && k.low <= last.low;
    if (lastContainsCurrent || currentContainsLast) {
      let direction: 'up' | 'down' = 'up';
      if (merged.length > 1) {
        const prev = merged[merged.length - 2];
        direction = last.high > prev.high ? 'up' : last.high < prev.high ? 'down' : last.direction;
      }
      if (direction === 'up') {
        last.high = Math.max(last.high, k.high);
        last.low = Math.max(last.low, k.low);
      } else {
        last.high = Math.min(last.high, k.high);
        last.low = Math.min(last.low, k.low);
      }
      last.direction = direction;
      last.originalIndices.push(i);
      last.originalHigh = Math.max(last.originalHigh, k.high);
      last.originalLow = Math.min(last.originalLow, k.low);
    } else {
      merged.push({
        high: k.high, low: k.low,
        direction: k.high > last.high ? 'up' : 'down',
        originalIndices: [i], originalHigh: k.high, originalLow: k.low,
      });
    }
  }
  return merged;
}

function findFractions(merged: MergedKline[], original: Kline[]): Fraction[] {
  const fractions: Fraction[] = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const prev = merged[i - 1], curr = merged[i], next = merged[i + 1];
    const isTop = curr.high > prev.high && curr.high > next.high && curr.low > prev.low && curr.low > next.low;
    const isBottom = curr.low < prev.low && curr.low < next.low && curr.high < prev.high && curr.high < next.high;
    if (isTop) {
      const idx = curr.originalIndices.reduce((best, j) => original[j].high > original[best].high ? j : best, curr.originalIndices[0]);
      fractions.push({ type: 'TOP', price: original[idx].high, index: i, originalIndex: idx, date: original[idx].date });
    } else if (isBottom) {
      const idx = curr.originalIndices.reduce((best, j) => original[j].low < original[best].low ? j : best, curr.originalIndices[0]);
      fractions.push({ type: 'BOTTOM', price: original[idx].low, index: i, originalIndex: idx, date: original[idx].date });
    }
  }
  return fractions;
}

function connectFenxingToStroke(fractions: Fraction[], minDistance: number): Fraction[] {
  if (fractions.length < 2) return [];
  let biPoints: Fraction[] = [];
  for (const fx of fractions) {
    if (biPoints.length === 0) { biPoints.push(fx); continue; }
    const last = biPoints[biPoints.length - 1];
    if (fx.type === last.type) {
      if ((last.type === 'TOP' && fx.price > last.price) || (last.type === 'BOTTOM' && fx.price < last.price)) {
        biPoints[biPoints.length - 1] = fx;
      }
    } else if (Math.abs(fx.index - last.index) >= minDistance) {
      biPoints.push(fx);
    }
  }
  const finalPoints: Fraction[] = [];
  for (const fx of biPoints) {
    if (finalPoints.length === 0) { finalPoints.push(fx); continue; }
    const last = finalPoints[finalPoints.length - 1];
    if (fx.type === last.type) {
      if ((fx.type === 'TOP' && fx.price > last.price) || (fx.type === 'BOTTOM' && fx.price < last.price)) {
        finalPoints[finalPoints.length - 1] = fx;
      }
    } else if (Math.abs(fx.index - last.index) >= minDistance) {
      finalPoints.push(fx);
    }
  }
  return finalPoints;
}

function calculateStrokes(fractions: Fraction[]): Stroke[] {
  const pts = connectFenxingToStroke(fractions, 4);
  if (pts.length < 2) return [];
  const strokes: Stroke[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const curr = pts[i], nxt = pts[i + 1];
    if (curr.type === 'TOP' && nxt.type === 'BOTTOM') {
      strokes.push({ id: `stroke-${curr.originalIndex}-${nxt.originalIndex}`, start: curr, end: nxt, direction: 'down' });
    } else if (curr.type === 'BOTTOM' && nxt.type === 'TOP') {
      strokes.push({ id: `stroke-${curr.originalIndex}-${nxt.originalIndex}`, start: curr, end: nxt, direction: 'up' });
    }
  }
  return strokes;
}

function calculateSegments(strokes: Stroke[]): Segment[] {
  if (strokes.length < 3) return [];
  const sfx: Fraction[] = [];
  for (let i = 1; i < strokes.length - 1; i++) {
    const pp = strokes[i - 1].end.price, cp = strokes[i].end.price, np = strokes[i + 1].end.price;
    if (cp > pp && cp > np) {
      sfx.push({ type: 'TOP', price: Math.max(strokes[i].start.price, strokes[i].end.price), index: i, originalIndex: strokes[i].end.originalIndex, date: strokes[i].end.date });
    } else if (cp < pp && cp < np) {
      sfx.push({ type: 'BOTTOM', price: Math.min(strokes[i].start.price, strokes[i].end.price), index: i, originalIndex: strokes[i].end.originalIndex, date: strokes[i].end.date });
    }
  }
  if (sfx.length < 2) return [];
  const segPts = connectFenxingToStroke(sfx, 3);
  if (segPts.length < 2) return [];
  const segments: Segment[] = [];
  for (let i = 0; i < segPts.length - 1; i++) {
    const curr = segPts[i], nxt = segPts[i + 1];
    const ss = strokes[curr.index], es = strokes[nxt.index];
    let direction: 'up' | 'down', startF: Fraction, endF: Fraction;
    if (curr.type === 'TOP' && nxt.type === 'BOTTOM') {
      direction = 'down';
      startF = ss.direction === 'down' ? ss.start : ss.end;
      endF = es.direction === 'up' ? es.start : es.end;
    } else if (curr.type === 'BOTTOM' && nxt.type === 'TOP') {
      direction = 'up';
      startF = ss.direction === 'up' ? ss.start : ss.end;
      endF = es.direction === 'down' ? es.start : es.end;
    } else continue;
    segments.push({ id: `segment-${startF.originalIndex}-${endF.originalIndex}`, start: startF, end: endF, direction });
  }
  return segments;
}

function identifyHubsGeneric(lines: { start: Fraction; end: Fraction; direction: string }[], level: number): Hub[] {
  if (lines.length < 3) return [];
  const hubs: Hub[] = [];
  let i = 0;
  while (i <= lines.length - 3) {
    const l1 = lines[i], l2 = lines[i + 1], l3 = lines[i + 2];
    const l1H = Math.max(l1.start.price, l1.end.price), l1L = Math.min(l1.start.price, l1.end.price);
    const l2H = Math.max(l2.start.price, l2.end.price), l2L = Math.min(l2.start.price, l2.end.price);
    const l3H = Math.max(l3.start.price, l3.end.price), l3L = Math.min(l3.start.price, l3.end.price);
    const zg = Math.min(l1H, l2H, l3H), zd = Math.max(l1L, l2L, l3L);
    if (zg > zd) {
      let gg = Math.max(l1H, l2H, l3H), dd = Math.min(l1L, l2L, l3L);
      let hubEndIndex = l3.end.originalIndex, count = 3;
      let j = i + 3;
      while (j < lines.length) {
        const nl = lines[j];
        const nH = Math.max(nl.start.price, nl.end.price), nL = Math.min(nl.start.price, nl.end.price);
        if (nH > zd && nL < zg) { hubEndIndex = nl.end.originalIndex; gg = Math.max(gg, nH); dd = Math.min(dd, nL); count++; j++; } else break;
      }
      hubs.push({ id: `hub-${l1.start.originalIndex}-${hubEndIndex}`, zg: +zg.toFixed(2), zd: +zd.toFixed(2), gg: +gg.toFixed(2), dd: +dd.toFixed(2), startIndex: l1.start.originalIndex, endIndex: hubEndIndex, strokesCount: count, level });
      i = j;
    } else { i++; }
  }
  return hubs;
}

function calculateHubs(strokes: Stroke[]): Hub[] {
  return identifyHubsGeneric(strokes, 1);
}

function calculateSegmentHubs(segments: Segment[]): Hub[] {
  return identifyHubsGeneric(segments, 2);
}

// ---------------------------------------------------------------------------
// Trading Day Check (TickDB API)
// ---------------------------------------------------------------------------

/**
 * 检查指定日期是否为 A 股交易日
 * 使用 TickDB 交易日历 API: GET /v1/market/trade-days
 */
async function isTradingDay(date: string): Promise<boolean> {
  const url = `${TICKFLOW_BASE_URL}/v1/market/trade-days?market=CN&start_date=${date}&end_date=${date}`;
  const headers: Record<string, string> = {};
  if (TICKFLOW_API_KEY) headers['x-api-key'] = TICKFLOW_API_KEY;

  try {
    console.log(`[交易日历] 检查 ${date} 是否为交易日...`);
    const resp = await fetch(url, { headers });
    
    if (!resp.ok) {
      console.warn(`[交易日历] API 调用失败 (${resp.status})，默认视为交易日继续执行`);
      return true;
    }

    const json = await resp.json();
    // TickDB 返回格式: { data: [{ date: "2026-06-16", trade_date: "2026-06-16" }] }
    // 如果是交易日，trade_date 字段会有值；如果不是交易日，trade_date 为空字符串或不存在
    if (json?.data && Array.isArray(json.data) && json.data.length > 0) {
      const tradeDate = json.data[0]?.trade_date;
      const isTrading = !!tradeDate && tradeDate !== '';
      console.log(`[交易日历] ${date} ${isTrading ? '是' : '不是'}交易日`);
      return isTrading;
    }

    // 如果 API 返回数据格式不符合预期，默认视为交易日继续执行
    console.warn('[交易日历] API 返回数据格式异常，默认视为交易日继续执行');
    return true;
  } catch (err: any) {
    console.warn(`[交易日历] 检查失败: ${err.message}，默认视为交易日继续执行`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Stock data fetching (TickFlow API — Node.js fetch)
// ---------------------------------------------------------------------------

function resolveSymbol(symbol: string): { resolved: string; displayName: string; isChinaStock: boolean } {
  const clean = symbol.trim().toUpperCase();
  if (/^\d{6}$/.test(clean)) {
    const isSS = /^(60|68|90|11|13|51|58|60)/.test(clean);
    return { resolved: `${clean}.${isSS ? 'SH' : 'SZ'}`, displayName: `${clean}.${isSS ? 'SH' : 'SZ'}`, isChinaStock: true };
  }
  if (clean.endsWith('.SS')) return { resolved: clean.replace('.SS', '.SH'), displayName: clean, isChinaStock: true };
  if (clean.endsWith('.SZ')) return { resolved: clean, displayName: clean, isChinaStock: true };
  return { resolved: clean, displayName: clean, isChinaStock: false };
}

async function fetchStockData(symbol: string): Promise<{ symbol: string; klines: Kline[] }> {
  const { resolved, displayName, isChinaStock } = resolveSymbol(symbol);
  if (!isChinaStock) throw new Error(`仅支持A股: ${symbol}`);

  const url = `${TICKFLOW_BASE_URL}/v1/klines?symbol=${resolved}&period=1d&count=${365 * 5}&adjust=forward`;
  const headers: Record<string, string> = {};
  if (TICKFLOW_API_KEY) headers['x-api-key'] = TICKFLOW_API_KEY;

  console.log(`[TickFlow] 获取 ${displayName} 数据...`);
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`TickFlow API 失败 (${resp.status}): ${displayName}`);

  const json = await resp.json();
  if (!json?.data) throw new Error(`无数据: ${displayName}`);

  const data = json.data;
  const len = data.timestamp?.length || 0;
  if (len === 0) throw new Error(`无K线: ${displayName}`);

  const klines: Kline[] = [];
  const CHINA_OFFSET = 8 * 60 * 60 * 1000;
  for (let i = 0; i < len; i++) {
    const d = new Date(data.timestamp[i] + CHINA_OFFSET);
    const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    klines.push({
      date: dateStr,
      open: +data.open[i].toFixed(2),
      high: +data.high[i].toFixed(2),
      low: +data.low[i].toFixed(2),
      close: +data.close[i].toFixed(2),
      volume: data.volume[i] || 0,
      amount: data.amount[i] || 0,
    });
  }
  console.log(`[TickFlow] ${displayName}: ${klines.length} 根K线`);
  return { symbol: displayName, klines };
}

// ---------------------------------------------------------------------------
// ChanLun context builder (from src/utils/api.ts — standalone)
// ---------------------------------------------------------------------------

function pct(v: number): string { return `${(v * 100).toFixed(2)}%`; }

function buildChanLunContext(symbol: string, klines: Kline[], strokes: Stroke[], segments: Segment[], hubs: Hub[], fractions: Fraction[]): string {
  const recent = klines.slice(-90);
  const first = klines[0], last = klines[klines.length - 1];
  const highest = Math.max(...klines.map(k => k.high));
  const lowest = Math.min(...klines.map(k => k.low));
  const totalReturn = first.close === 0 ? 0 : (last.close - first.close) / first.close;
  let peak = first.close, maxDD = 0;
  for (const k of klines) { if (k.close > peak) peak = k.close; const dd = (peak - k.close) / peak; if (dd > maxDD) maxDD = dd; }
  const avgVol = Math.round(klines.reduce((s, k) => s + k.volume, 0) / klines.length);

  const klineRows = recent.map(k => `${k.date} | O:${k.open.toFixed(2)} H:${k.high.toFixed(2)} L:${k.low.toFixed(2)} C:${k.close.toFixed(2)} V:${Math.round(k.volume)}`).join('\n');
  const fracRows = fractions.slice(-60).map(f => `${f.date} ${f.type === 'TOP' ? '顶' : '底'} ${f.price.toFixed(2)}`).join('\n');
  const strokeRows = strokes.slice(-80).map((s, i) => `#${i + 1} ${s.direction === 'up' ? '↑' : '↓'} ${s.start.date} ${s.start.price.toFixed(2)} → ${s.end.date} ${s.end.price.toFixed(2)}`).join('\n');
  const segRows = segments.slice(-60).map((s, i) => `#${i + 1} ${s.direction === 'up' ? '↑' : '↓'} ${s.start.date} ${s.start.price.toFixed(2)} → ${s.end.date} ${s.end.price.toFixed(2)}`).join('\n');
  const hubRows = hubs.map((h, i) => `#${i + 1} level:${h.level} ZG:${h.zg.toFixed(2)} ZD:${h.zd.toFixed(2)} GG:${h.gg.toFixed(2)} DD:${h.dd.toFixed(2)} | bars[${h.startIndex}..${h.endIndex}] strokes:${h.strokesCount}`).join('\n');

  return [
    `# ${symbol} 缠论多因子分析上下文`,
    '',
    '## 1. K线全期统计',
    `- 数据起点: ${first.date} 收 ${first.close.toFixed(2)}`,
    `- 数据终点: ${last.date} 收 ${last.close.toFixed(2)}`,
    `- 区间最高: ${highest.toFixed(2)} | 区间最低: ${lowest.toFixed(2)}`,
    `- 累计收益率: ${pct(totalReturn)} | 最大回撤: ${pct(maxDD)} | 均成交量: ${avgVol}`,
    '',
    `## 2. 最近 ${recent.length} 根日K线`,
    klineRows,
    '',
    `## 3. 分型列表 (${fractions.length} 个, 最近60个)`,
    fracRows,
    '',
    `## 4. 笔列表 (${strokes.length} 条, 最近80条)`,
    strokeRows,
    '',
    `## 5. 线段列表 (${segments.length} 条)`,
    segRows,
    '',
    `## 6. 中枢列表 (${hubs.length} 个)`,
    hubRows,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// LLM API calls (OpenRouter / Gemini — Node.js fetch)
// ---------------------------------------------------------------------------

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

const SYSTEM_PROMPT = [
  '你是一位资深 A 股缠论 (ChanLun) 量化分析师, 精通分型、笔、线段、中枢、买卖点、走势背驰等核心概念。',
  '你将收到一份结构化上下文, 包含 5 年日 K 线汇总 + 最近约 90 个交易日的完整 OHLCV, 以及识别出的分型、笔、线段、中枢。',
  '请基于这些数据给出专业、可执行的中文投资分析报告, 严格使用 Markdown 格式, 包含以下章节:',
  '1. # 总览 (Overall Bias): 多空判断、当前趋势方向、关键价位',
  '2. ## 缠论结构解读: 笔 / 线段 / 中枢的状态、最近中枢的 zg/zd/gg/dd 含义',
  '3. ## 买卖点与背驰分析: 是否存在一买 / 二买 / 三买 / 一卖 / 二卖 / 三卖, 是否存在顶 / 底背驰',
  '4. ## 关键支撑压力位: 结合中枢边界、分型高低点给出具体价格',
  '5. ## 交易策略与风控: 入场区间、止损位、仓位建议、目标位',
  '6. ## 风险提示: 数据局限、模型风险、宏观 / 消息面提醒',
  '语气专业、量化、有数据支撑; 必要时引用具体日期和价格。',
].join('\n');

async function callOpenCode(messages: ChatMessage[]): Promise<string> {
  if (!OPENCODE_API_KEY) throw new Error('VITE_OPENCODE_API_KEY 未设置');
  console.log(`[AI] OpenCode Zen -> ${AI_MODEL}`);
  
  const resp = await fetch(`${OPENCODE_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCODE_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages,
      temperature: 0.7,
    }),
  });
  
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenCode API 失败 (${resp.status}): ${err.slice(0, 300)}`);
  }
  
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callLLM(messages: ChatMessage[]): Promise<string> {
  if (!OPENCODE_API_KEY) throw new Error('使用 OpenCode 需设置 VITE_OPENCODE_API_KEY');
  return callOpenCode(messages);
}

// ---------------------------------------------------------------------------
// Exa 搜索 (财联社新闻) + LLM 总结
// ---------------------------------------------------------------------------

interface ExaResult {
  title: string;
  url: string;
  text: string;
  publishedDate?: string;
}

/**
 * 通过 Exa SDK 搜索, 仅检索给定域名内的内容。
 * 返回去重后的结果列表。
 */
async function exaSearch(
  query: string,
  opts: { domains?: string[]; maxResults?: number; startDate?: Date; endDate?: Date } = {},
): Promise<ExaResult[]> {
  const exa = getExaClient();
  if (!exa) throw new Error('EXA_API_KEY 未设置');

  const { domains, maxResults = 8, startDate, endDate } = opts;

  console.log(`[Exa] 搜索: "${query.slice(0, 60)}..."`);

  const searchOpts: Record<string, unknown> = {
    numResults: maxResults,
    type: 'deep',
  };
  if (domains?.length) searchOpts.includeDomains = domains;
  if (startDate) searchOpts.startPublishedDate = startDate.toISOString();
  if (endDate) searchOpts.endPublishedDate = endDate.toISOString();
  if (!startDate && !endDate) {
    // 默认最近 30 天
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    start.setHours(0, 0, 0, 0);
    searchOpts.endPublishedDate = end.toISOString();
    searchOpts.startPublishedDate = start.toISOString();
  }

  const data = await exa.search(query, searchOpts);

  const raw = data.results || [];

  const seen = new Set<string>();
  const out: ExaResult[] = [];
  for (const r of raw) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ title: r.title, url: r.url, text: r.text || '', publishedDate: r.publishedDate });
  }
  return out;
}

/** 把 Exa 结果渲染成供 LLM 消化的纯文本 */
function formatExaResults(results: ExaResult[]): string {
  if (results.length === 0) return '(无结果)';
  return results.map((r, i) => {
    const date = r.publishedDate ? ` [${r.publishedDate.slice(0, 10)}]` : '';
    return `【${i + 1}】${r.title}${date}\n来源: ${r.url}\n摘要: ${(r.text || '').slice(0, 400).trim()}`;
  }).join('\n\n');
}

/** 获取最近 14 天的日期范围 */
function last14Days(): { start: Date; end: Date } {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

/** 获取最近 1 天的日期范围 */
function last1Day(): { start: Date; end: Date } {
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

/**
 * 获取并总结某只股票在财联社 (cls.cn) 上的最新资讯。
 * 流程: Exa (财联社域名) 检索 -> LLM 总结。
 */
async function searchIndustryNews(symbol: string): Promise<string> {
  const today = new Date().toISOString().split('T')[0];

  let results: ExaResult[] = [];
  const exa = getExaClient();
  if (exa) {
    console.log(`[Exa] 检索财联社: ${symbol} ...`);
    const { start, end } = last14Days();
    try {
      results = await exaSearch(
        `${symbol} 股票 最新消息 利好 利空 公告 业绩`,
        { maxResults: 8, startDate: start, endDate: end },
      );
      console.log(`[Exa] ${symbol}: 命中 ${results.length} 条财联社资讯`);
    } catch (err: any) {
      console.error(`[Exa] ${symbol} 检索失败:`, err.message);
    }
  } else {
    console.warn('[Exa] 未配置 EXA_API_KEY, 跳过财联社资讯检索');
  }

  const rawNews = formatExaResults(results);
  const newsPrompt: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是一位专业的A股行业研究员。下面会给你若干来自财联社(cls.cn)的该股票最新资讯(可能为空)。',
        '请基于这些资讯给出该股票的消息面总结, 严格使用中文 Markdown 格式, 包含:',
        '1. ## 行业定位: 该股票所属行业与主营业务 (一句话)',
        '2. ## 财联社最新资讯: 把资讯归纳为若干条要点, 每条标注日期与来源链接; 若资讯与该股票无关请明确说明',
        '3. ## 政策面/消息面动态: 相关政策、行业事件',
        '4. ## 对该股的影响分析: 利好/利空判断',
        '若财联社资讯为空, 请如实说明"财联社近期未检索到该股票的直接资讯", 并基于常识简要给出行业定位, 不要编造新闻或链接。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `股票: ${symbol} | 今天: ${today}`,
        '',
        '--- 财联社(cls.cn)检索结果 ---',
        rawNews,
      ].join('\n'),
    },
  ];

  try {
    return await callLLM(newsPrompt);
  } catch (err: any) {
    console.error(`[新闻] ${symbol} 总结失败:`, err.message);
    return `## ${symbol} 财联社资讯\n\n总结失败: ${err.message}`;
  }
}

/**
 * 获取并总结财联社的当日热点新闻与板块/题材信息。
 * 在所有个股分析完成后调用, 输出市场总览。流程: Exa 检索 -> LLM 总结。
 */
async function summarizeMarketHotspots(): Promise<string> {
  const today = new Date().toISOString().split('T')[0];

  let hotResults: ExaResult[] = [];
  let sectorResults: ExaResult[] = [];
  const exa = getExaClient();
  if (exa) {
    console.log('[Exa] 检索财联社热点 & 板块 ...');
    const { start, end } = last1Day();
    try {
      [hotResults, sectorResults] = await Promise.all([
        exaSearch('A股 今日 热点 涨停 龙头 利好', { maxResults: 10, startDate: start, endDate: end })
          .catch((e: any) => { console.error('[Exa] 热点检索失败:', e.message); return []; }),
        exaSearch('A股 板块 题材 概念 资金 流入 涨停潮', { maxResults: 10, startDate: start, endDate: end })
          .catch((e: any) => { console.error('[Exa] 板块检索失败:', e.message); return []; }),
      ]);
      console.log(`[Exa] 热点:${hotResults.length} 条 | 板块:${sectorResults.length} 条`);
    } catch (err: any) {
      console.error('[Exa] 市场总览检索失败:', err.message);
    }
  } else {
    console.warn('[Exa] 未配置 EXA_API_KEY, 跳过市场热点检索');
  }

  const rawHot = formatExaResults(hotResults);
  const rawSector = formatExaResults(sectorResults);

  const prompt: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是A股市场分析师。下面给你来自财联社(cls.cn)的当日热点新闻与板块/题材资讯(可能为空)。',
        '请总结出当日市场总览, 严格使用中文 Markdown 格式, 包含:',
        '1. ## 今日市场热点: 归纳最重要的热点事件/涨停方向/资金动向, 每条标注来源链接',
        '2. ## 活跃板块与题材: 列出当日强势/活跃的板块题材, 说明驱动因素, 标注来源链接',
        '3. ## 后市关注: 值得跟踪的方向与风险点',
        '若资讯为空, 请如实说明"财联社近期未检索到市场热点资讯", 不要编造新闻或链接。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `今天: ${today}`,
        '',
        '--- 财联社 热点新闻 ---',
        rawHot,
        '',
        '--- 财联社 板块/题材 ---',
        rawSector,
      ].join('\n'),
    },
  ];

  try {
    return await callLLM(prompt);
  } catch (err: any) {
    console.error('[市场总览] 总结失败:', err.message);
    return `## 市场热点与板块\n\n总结失败: ${err.message}`;
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

async function analyzeStock(symbol: string): Promise<string> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`分析 ${symbol} ...`);
  console.log('='.repeat(60));

  // 1. 获取K线
  const { klines } = await fetchStockData(symbol);

  // 2. 计算缠论结构
  const merged = mergeKlines(klines);
  const fractions = findFractions(merged, klines);
  const strokes = calculateStrokes(fractions);
  const segments = calculateSegments(strokes);
  const hubs = calculateHubs(strokes);
  const segHubs = calculateSegmentHubs(segments);
  const allHubs = [...hubs, ...segHubs];

  console.log(`[缠论] 分型:${fractions.length} 笔:${strokes.length} 线段:${segments.length} 中枢:${allHubs.length}`);

  // 3. 构建上下文
  const context = buildChanLunContext(symbol, klines, strokes, segments, allHubs, fractions);

  // 4. 调用 LLM 分析
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `请分析以下股票的缠论结构和交易建议:\n\n${context}` },
  ];

  let analysis: string;
  try {
    analysis = await callLLM(messages);
  } catch (err: any) {
    console.error(`[AI] ${symbol} 分析失败:`, err.message);
    analysis = `## ${symbol} AI 分析失败\n\n${err.message}`;
  }

  // 5. 搜索行业新闻
  const news = await searchIndustryNews(symbol);

  // 6. 组装报告
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const lastKline = klines[klines.length - 1];
  const prevKline = klines[klines.length - 2];
  const changePercent = prevKline?.close ? ((lastKline.close - prevKline.close) / prevKline.close * 100).toFixed(2) : '0.00';

  const report = [
    `# ${symbol} 缠论日报`,
    '',
    `> 生成时间: ${dateStr} | 最新收盘: ${lastKline.close.toFixed(2)} | 涨跌幅: ${changePercent}%`,
    '',
    '---',
    '',
    analysis,
    '',
    '---',
    '',
    news,
    '',
    '---',
    '',
    `*本报告由缠论量化分析系统自动生成，仅供参考，不构成投资建议。*`,
    '',
  ].join('\n');

  return report;
}

// ---------------------------------------------------------------------------
// Notification providers
// ---------------------------------------------------------------------------

type NotifyChannel = 'console' | 'serverchan' | 'email' | 'issue' | 'feishu';

const SERVERCHAN_KEY = process.env.SERVERCHAN_KEY || '';
const FEISHU_WEBHOOK = process.env.FEISHU_WEBHOOK || '';
const EMAIL_TO = process.env.NOTIFY_EMAIL_TO || '';
const EMAIL_FROM = process.env.NOTIFY_EMAIL_FROM || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || ''; // 自动设置 by Actions

/** Server酱 (微信推送) — https://sct.ftqq.com/ */
async function notifyServerChan(title: string, content: string): Promise<void> {
  if (!SERVERCHAN_KEY) { console.log('[通知] Server酱: 未配置 SERVERCHAN_KEY, 跳过'); return; }
  console.log('[通知] Server酱: 发送中...');
  const resp = await fetch(`https://sctapi.ftqq.com/${SERVERCHAN_KEY}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(content)}`,
  });
  if (!resp.ok) { console.error(`[通知] Server酱失败: ${resp.status}`); return; }
  const data = await resp.json() as any;
  if (data.code === 0) { console.log('[通知] Server酱: 发送成功'); }
  else { console.error(`[通知] Server酱失败: ${data.message || '未知错误'}`); }
}

/** 从报告中提取关键信息生成邮件摘要 */
function extractEmailSummary(content: string): string {
  const summary: string[] = [];
  
  const dateMatch = content.match(/缠论日报汇总 — (\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    summary.push(`缠论日报 — ${dateMatch[1]}`);
    summary.push('');
  }
  
  // 主要指数
  const idxMatch = content.match(/## 主要指数\n\n([\s\S]*?)(?=\n---|$)/);
  if (idxMatch) {
    summary.push('【主要指数】');
    const lines = idxMatch[1].trim().split('\n').filter(Boolean);
    for (const line of lines) {
      summary.push(`  ${line}`);
    }
    summary.push('');
  }
  
  // 个股
  const stockSections = content.split(/^---$/m).filter(s => s.includes('缠论日报'));
  
  for (const section of stockSections) {
    const codeMatch = section.match(/^# (\d{6}\.(?:SH|SZ)) 缠论日报/m);
    if (!codeMatch) continue;
    const code = codeMatch[1];
    
    const priceMatch = section.match(/最新收盘:\s*([\d.]+)/);
    const changeMatch = section.match(/涨跌幅:\s*([-\d.]+)%/);
    
    const price = priceMatch ? priceMatch[1] : 'N/A';
    let change = 'N/A';
    if (changeMatch) {
      const val = parseFloat(changeMatch[1]);
      change = val >= 0 ? `+${changeMatch[1]}%` : `${changeMatch[1]}%`;
    }
    
    summary.push(`${code}  ${price}  ${change}`);
  }
  
  summary.push('');
  summary.push('━━━━━━━━━━━━━━━━━━━━━━━━');
  summary.push('完整报告见附件');
  summary.push('');
  summary.push('*本报告由缠论量化分析系统自动生成，仅供参考，不构成投资建议。*');
  
  return summary.join('\n');
}

/** 邮件通知 (通过 Resend API — 免费额度100封/天) */
async function notifyEmail(title: string, content: string, attachmentPath?: string): Promise<void> {
  const RESEND_KEY = process.env.RESEND_API_KEY || '';
  if (!RESEND_KEY || !EMAIL_TO) { console.log('[通知] 邮件: 未配置 RESEND_API_KEY / NOTIFY_EMAIL_TO, 跳过'); return; }
  console.log('[通知] 邮件: 发送中...');
  
  // 生成邮件摘要
  const emailSummary = extractEmailSummary(content);
  
  const emailData: any = {
    from: EMAIL_FROM || 'ChanLun Report <onboarding@resend.dev>',
    to: EMAIL_TO.split(','),
    subject: title,
    text: emailSummary,
  };
  
  // 如果提供了附件路径，读取文件并添加为附件
  if (attachmentPath && fs.existsSync(attachmentPath)) {
    const fileContent = fs.readFileSync(attachmentPath);
    const fileName = path.basename(attachmentPath);
    emailData.attachments = [
      {
        filename: fileName,
        content: fileContent.toString('base64'),
        type: 'text/markdown',
      },
    ];
    console.log(`[通知] 邮件: 添加附件 ${fileName}`);
  }
  
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
    body: JSON.stringify(emailData),
  });
  if (!resp.ok) { 
    const errText = await resp.text();
    console.error(`[通知] 邮件失败: ${resp.status} - ${errText.slice(0, 200)}`); 
    return; 
  }
  console.log('[通知] 邮件: 发送成功');
}

/** GitHub Issue 通知 — 在仓库创建 Issue 保存报告 */
async function notifyGitHubIssue(title: string, content: string): Promise<void> {
  if (!GITHUB_TOKEN || !GITHUB_REPO) { console.log('[通知] GitHub Issue: 未配置 GITHUB_TOKEN / GITHUB_REPOSITORY, 跳过'); return; }
  console.log('[通知] GitHub Issue: 创建中...');
  const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'chanlun-report-bot',
    },
    body: JSON.stringify({ title, body: content.slice(0, 65000), labels: ['daily-report', 'chanlun'] }),
  });
  if (!resp.ok) { console.error(`[通知] GitHub Issue 失败: ${resp.status}`); return; }
  const data = await resp.json() as any;
  console.log(`[通知] GitHub Issue: 创建成功 #${data.number} — ${data.html_url}`);
}

/** 飞书机器人通知 — 使用自定义机器人 webhook */
async function notifyFeishu(title: string, content: string): Promise<void> {
  if (!FEISHU_WEBHOOK) { console.log('[通知] 飞书: 未配置 FEISHU_WEBHOOK, 跳过'); return; }
  console.log('[通知] 飞书: 发送中...');
  
  // 1. 发送摘要消息
  const summary: string[] = [];
  
  const dateMatch = content.match(/缠论日报汇总 — (\d{4}-\d{2}-\d{2})/);
  if (dateMatch) {
    summary.push(`**📅 ${dateMatch[1]} 缠论日报**`);
    summary.push('');
  }
  
  // 提取个股信息
  const stockSections = content.split(/^---$/m).filter(s => s.includes('缠论日报'));
  for (const section of stockSections) {
    const codeMatch = section.match(/^# (\d{6}\.(?:SH|SZ)) 缠论日报/m);
    if (!codeMatch) continue;
    const code = codeMatch[1];
    
    const priceMatch = section.match(/最新收盘:\s*([\d.]+)/);
    const changeMatch = section.match(/涨跌幅:\s*([-\d.]+)%/);
    
    const price = priceMatch ? priceMatch[1] : 'N/A';
    let change = 'N/A';
    if (changeMatch) {
      const val = parseFloat(changeMatch[1]);
      change = val >= 0 ? `+${changeMatch[1]}%` : `${changeMatch[1]}%`;
    }
    
    summary.push(`• ${code}: ${price} (${change})`);
  }
  
  summary.push('');
  summary.push('━━━━━━━━━━━━━━━━━━━━');
  summary.push('*本报告由缠论量化分析系统自动生成*');
  
  // 发送摘要消息
  const summaryMessage = {
    msg_type: 'post',
    content: {
      post: {
        zh_cn: {
          title: title,
          content: [
            [
              {
                tag: 'text',
                text: summary.join('\n'),
              },
            ],
          ],
        },
      },
    },
  };
  
  await sendFeishuMessage(summaryMessage);
  
  // 2. 发送完整报告内容（分段发送，避免单条消息过长）
  // 飞书单条消息限制约 30KB，这里按 20KB 分段
  const MAX_CHUNK_SIZE = 20000;
  const chunks: string[] = [];
  
  if (content.length > MAX_CHUNK_SIZE) {
    // 分段处理
    let remaining = content;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, MAX_CHUNK_SIZE));
      remaining = remaining.slice(MAX_CHUNK_SIZE);
    }
  } else {
    chunks.push(content);
  }
  
  // 发送分段消息
  for (let i = 0; i < chunks.length; i++) {
    const chunkTitle = chunks.length > 1 ? `${title} (第 ${i + 1}/${chunks.length} 部分)` : title;
    const chunkMessage = {
      msg_type: 'post',
      content: {
        post: {
          zh_cn: {
            title: chunkTitle,
            content: [
              [
                {
                  tag: 'text',
                  text: chunks[i],
                },
              ],
            ],
          },
        },
      },
    };
    
    await sendFeishuMessage(chunkMessage);
    
    // 避免发送过快（飞书限制每分钟最多 20 条消息）
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  
  console.log('[通知] 飞书: 发送成功 (摘要 + 完整报告)');
}

/** 发送飞书消息的辅助函数 */
async function sendFeishuMessage(message: any): Promise<void> {
  const resp = await fetch(FEISHU_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  
  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[通知] 飞书失败: ${resp.status} - ${errText.slice(0, 200)}`);
    throw new Error(`飞书消息发送失败: ${resp.status}`);
  }
  
  const data = await resp.json() as any;
  if (data.code !== 0 && data.StatusCode !== 0) {
    console.error(`[通知] 飞书失败: ${data.msg || data.StatusMessage || '未知错误'}`);
    throw new Error(`飞书消息发送失败: ${data.msg || data.StatusMessage}`);
  }
}

async function sendNotifications(channels: NotifyChannel[], title: string, content: string, attachmentPath?: string): Promise<void> {
  for (const ch of channels) {
    try {
      switch (ch) {
        case 'console':
          if (content.length > 2000) console.log(`... (共 ${content.length} 字)`);
          break;
        case 'serverchan': await notifyServerChan(title, content); break;
        case 'email': await notifyEmail(title, content, attachmentPath); break;
        case 'issue': await notifyGitHubIssue(title, content); break;
        case 'feishu': await notifyFeishu(title, content); break;
      }
    } catch (err: any) {
      console.error(`[通知] ${ch} 失败:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(): { stocks: string[]; outputDir: string; notify: NotifyChannel[] } {
  const args = process.argv.slice(2);
  let stocks = DEFAULT_STOCKS;
  let outputDir = './reports';
  let notify: NotifyChannel[] = ['console'];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stocks' && args[i + 1]) {
      stocks = args[i + 1].split(',').map(s => s.trim()).filter(Boolean);
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    } else if (args[i] === '--notify' && args[i + 1]) {
      notify = args[i + 1].split(',').map(s => s.trim() as NotifyChannel).filter(Boolean);
      i++;
    }
  }

  return { stocks, outputDir, notify };
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  缠论日报 — 自动分析系统');
  console.log('═══════════════════════════════════════════════════════════');

  const { stocks, outputDir, notify } = parseArgs();

  // 检查 API Key
  if (!OPENCODE_API_KEY) {
    console.error('\n错误: 请设置 VITE_OPENCODE_API_KEY 环境变量');
    process.exit(1);
  }

  // 检查今天是否为交易日
  const today = new Date().toISOString().split('T')[0];
  const isTrading = await isTradingDay(today);
  
  if (!isTrading) {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`  今日 (${today}) 不是 A 股交易日`);
    console.log('  脚本已跳过分析，直接退出');
    console.log('═══════════════════════════════════════════════════════════');
    process.exit(0);
  }

  console.log(`\n分析股票: ${stocks.join(', ')}`);
  console.log(`输出目录: ${outputDir}`);
  console.log(`通知方式: ${notify.join(', ')}`);

  // 获取主要指数行情
  console.log('\n' + '═'.repeat(60));
  console.log('  获取主要指数行情');
  console.log('═'.repeat(60));
  const indices = await fetchIndexQuotes();
  const indexLines = indices.map(i => `${i.name} ${i.price.toFixed(2)} ${i.changePercent}`).join('\n');
  if (indices.length > 0) {
    console.log(`[指数] ${indices.length} 个指数获取成功`);
  }

  // 创建输出目录
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const allReports: string[] = [];

  for (const stock of stocks) {
    try {
      const report = await analyzeStock(stock);
      allReports.push(report);

      // 保存单只股票报告
      const filename = `${stock}-${dateStr}.md`;
      const filepath = path.join(outputDir, filename);
      fs.writeFileSync(filepath, report, 'utf-8');
      console.log(`[输出] ${filepath}`);
    } catch (err: any) {
      console.error(`[错误] ${stock} 分析失败:`, err.message);
      allReports.push(`# ${stock} 分析失败\n\n${err.message}`);
    }
  }

  // 所有个股分析完成后, 利用 Exa 检索财联社热点新闻 & 板块信息并总结
  console.log('\n' + '═'.repeat(60));
  console.log('  生成市场热点与板块总览 (财联社)');
  console.log('═'.repeat(60));
  let marketOverview = '';
  try {
    marketOverview = await summarizeMarketHotspots();
  } catch (err: any) {
    console.error('[市场总览] 生成失败:', err.message);
    marketOverview = `## 市场热点与板块\n\n生成失败: ${err.message}`;
  }

  // 生成汇总报告
  const summaryReport = [
    `# 缠论日报汇总 — ${dateStr}`,
    '',
    `> 本报告自动生成，涵盖 ${stocks.length} 只股票的缠论分析与行业热点`,
    '',
    '## 主要指数',
    '',
    indexLines || '暂无数据',
    '',
    '---',
    '',
    ...allReports.map(r => r + '\n\n---\n'),
    '',
    '# 市场热点与板块总览',
    '',
    `> 数据来源: 财联社(cls.cn) via Exa | ${dateStr}`,
    '',
    marketOverview,
    '',
    '---',
    '',
  ].join('\n');

  const summaryPath = path.join(outputDir, `daily-summary-${dateStr}.md`);
  fs.writeFileSync(summaryPath, summaryReport, 'utf-8');
  console.log(`\n[汇总] ${summaryPath}`);

  // 发送通知
  const notifyTitle = `缠论日报 ${dateStr}`;
  await sendNotifications(notify, notifyTitle, summaryReport, summaryPath);

  // 输出简要摘要到 stdout (用于 GitHub Actions 日志)
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  分析完成');
  console.log('═══════════════════════════════════════════════════════════');
  for (const stock of stocks) {
    const filepath = path.join(outputDir, `${stock}-${dateStr}.md`);
    if (fs.existsSync(filepath)) {
      const changeLine = fs.readFileSync(filepath, 'utf-8').match(/涨跌幅:\s*([-\d.]+)%/);
      const change = changeLine ? changeLine[1] + '%' : 'N/A';
      console.log(`  ${stock}: 涨跌幅 ${change} | ${filepath}`);
    }
  }
}

main().catch(err => {
  console.error('致命错误:', err);
  process.exit(1);
});
