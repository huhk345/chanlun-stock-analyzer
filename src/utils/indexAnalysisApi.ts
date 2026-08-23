// ---------------------------------------------------------------------------
// 指数缠论买卖点扫描数据层
//   - 成分股列表: public/index-members.{hs300,zz500}.json
//     (由 scripts/download-index-stocks.ts 生成于 data/, 用 `npm run sync-index` 同步)
//   - 股票名称: public/merged_stock_data.json (code -> stock_name)
//   - K 线: TickFlow API, 近 1 年日线 (count=400 自然日 ≈ 270 个交易日)
// ---------------------------------------------------------------------------

import { Kline } from '../types/stock';
import { acquireTickFlowSlot } from './rateLimiter';

export type ScanKind = 'index' | 'etf' | 'stock';

export interface ParsedSymbol {
  code: string;             // 6 位数字代码, e.g. '000001'
  exchange: 'SH' | 'SZ';
  kind: ScanKind;
}

/** 常用指数 (纯 6 位代码优先按指数解析) */
const KNOWN_INDEXES: Record<string, { exchange: 'SH' | 'SZ'; name: string }> = {
  '000001': { exchange: 'SH', name: '上证指数' },
  '000016': { exchange: 'SH', name: '上证50' },
  '000300': { exchange: 'SH', name: '沪深300' },
  '000905': { exchange: 'SH', name: '中证500' },
  '000852': { exchange: 'SH', name: '中证1000' },
  '000688': { exchange: 'SH', name: '科创50' },
  '399001': { exchange: 'SZ', name: '深证成指' },
  '399006': { exchange: 'SZ', name: '创业板指' },
};

export function kindLabel(kind: ScanKind): string {
  return kind === 'index' ? '指数' : kind === 'etf' ? 'ETF' : '股票';
}

function classify(code: string): ParsedSymbol {
  const known = KNOWN_INDEXES[code];
  if (known) return { code, exchange: known.exchange, kind: 'index' };
  if (/^5/.test(code)) return { code, exchange: 'SH', kind: 'etf' };
  if (/^(15|16|18)/.test(code)) return { code, exchange: 'SZ', kind: 'etf' };
  if (/^(60|68|11|13)/.test(code)) return { code, exchange: 'SH', kind: 'stock' };
  return { code, exchange: 'SZ', kind: 'stock' };
}

/**
 * 解析用户输入为标准代码。
 * 支持: '600519' / '600519.SH' / 'sh600519' / '510300'
 */
export function parseSymbol(input: string): ParsedSymbol | null {
  const s = input.trim().toUpperCase();
  if (!s) return null;

  const prefixed = /^(SH|SZ)(\d{6})$/.exec(s);
  if (prefixed) {
    return { ...classify(prefixed[2]), exchange: prefixed[1] as 'SH' | 'SZ' };
  }

  const suffixed = /^(\d{6})\.(SS|SH|SZ)$/.exec(s);
  if (suffixed) {
    const exchange = suffixed[2] === 'SS' ? 'SH' : (suffixed[2] as 'SH' | 'SZ');
    return { ...classify(suffixed[1]), exchange };
  }

  if (/^\d{6}$/.test(s)) return classify(s);

  return null;
}

/** ParsedSymbol -> '000001.SZ' 标准键 */
export function symbolKey(p: ParsedSymbol): string {
  return `${p.code}.${p.exchange}`;
}

// ---------------------------------------------------------------------------
// 成分股列表 / 名称映射
// ---------------------------------------------------------------------------

export type IndexId = 'hs300' | 'zz500';

export const INDEX_META: Record<IndexId, { label: string; file: string }> = {
  hs300: { label: '沪深300', file: '/index-members.hs300.json' },
  zz500: { label: '中证500', file: '/index-members.zz500.json' },
};

const membersCache: Partial<Record<IndexId, string[]>> = {};

export async function fetchIndexMembers(id: IndexId): Promise<string[]> {
  const cached = membersCache[id];
  if (cached) return cached;

  const resp = await fetch(INDEX_META[id].file);
  if (!resp.ok) throw new Error(`获取 ${INDEX_META[id].label} 成分股失败 (${resp.status})`);
  const list = await resp.json();
  if (!Array.isArray(list) || list.length === 0) throw new Error(`${INDEX_META[id].label} 成分股列表为空`);

  membersCache[id] = list;
  return list;
}

let nameMapPromise: Promise<Record<string, string>> | null = null;

/** code(6位) -> 中文名称, 来自 merged_stock_data.json */
export function loadNameMap(): Promise<Record<string, string>> {
  return loadStockMeta().then(m => m.names);
}

export interface StockMeta {
  names: Record<string, string>;        // code -> 名称
  industries: Record<string, string>;   // code -> 板块完整路径 '金融 > 商业银行 > ... > 银行'
}

let stockMetaPromise: Promise<StockMeta> | null = null;

/** code(6位) -> 名称 + 所属板块路径, 来自 merged_stock_data.json */
export function loadStockMeta(): Promise<StockMeta> {
  if (stockMetaPromise) return stockMetaPromise;
  stockMetaPromise = fetch('/merged_stock_data.json')
    .then(resp => {
      if (!resp.ok) throw new Error(String(resp.status));
      return resp.json();
    })
    .then((data: Record<string, { stock_name?: string; industry?: string }>) => {
      const meta: StockMeta = { names: {}, industries: {} };
      for (const [code, info] of Object.entries(data || {})) {
        if (info?.stock_name) meta.names[code] = info.stock_name;
        if (info?.industry) meta.industries[code] = info.industry;
      }
      return meta;
    })
    .catch(() => ({ names: {}, industries: {} }));
  return stockMetaPromise;
}

// ---------------------------------------------------------------------------
// 个股当日主力资金流向 (东方财富, 支持批量)
// ---------------------------------------------------------------------------

const EM_DELAY_BASE = 'https://push2delay.eastmoney.com';

export interface StockFlow {
  mainInflow: number;  // 今日主力净流入 (元) = 超大单 + 大单
  mainPercent: number; // 主力净占比 %
}

/** symbolKey('600000.SH') -> 东方财富 secid ('1.600000') */
function secidOf(key: string): string {
  const dot = key.indexOf('.');
  const code = key.slice(0, dot);
  const ex = key.slice(dot + 1);
  return `${ex === 'SH' ? '1' : '0'}.${code}`;
}

/**
 * 批量获取个股当日主力资金流向。
 * 返回 symbolKey -> StockFlow, 单只失败/无数据的标的不会出现在结果中。
 */
export async function fetchStockFlowBatch(symbolKeys: string[]): Promise<Record<string, StockFlow>> {
  const out: Record<string, StockFlow> = {};
  const num = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v)) || NaN);

  for (let i = 0; i < symbolKeys.length; i += 60) {
    const chunk = symbolKeys.slice(i, i + 60);
    const url =
      `${EM_DELAY_BASE}/api/qt/ulist.np/get?fltt=2&invt=2` +
      `&secids=${chunk.map(secidOf).join(',')}&fields=f12,f62,f184`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const json = await resp.json();
      const diff = json?.data?.diff;
      if (!Array.isArray(diff)) continue;

      // 返回项仅含 6 位代码, 需映射回带后缀的 symbolKey
      const byCode = new Map<string, string[]>();
      for (const k of chunk) {
        const code = k.split('.')[0];
        const list = byCode.get(code);
        if (list) list.push(k); else byCode.set(code, [k]);
      }
      for (const it of diff) {
        const keys = byCode.get(String(it.f12 || ''));
        const key = keys?.shift();
        if (!key) continue;
        const main = num(it.f62);
        if (isNaN(main)) continue; // ETF/指数等无资金流数据
        out[key] = { mainInflow: main, mainPercent: num(it.f184) || 0 };
      }
    } catch { /* 单批失败不阻塞其余批次 */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TickFlow K 线 (近 1 年日线)
// ---------------------------------------------------------------------------

function getApiKey(): string {
  try {
    const savedKeys = localStorage.getItem('api_keys');
    if (savedKeys) {
      const keys = JSON.parse(savedKeys);
      if (keys.tickflow) return keys.tickflow;
    }
  } catch {
    // ignore
  }
  return import.meta.env.VITE_TICKFLOW_API_KEY || '';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 拉取单只标的近 1 年日 K 线 (前复权), 带 429/网络重试。
 * signal 用于扫描取消时中断等待。
 */
export async function fetchYearKlines(
  symbol: string,
  maxRetries = 3,
  signal?: AbortSignal,
): Promise<Kline[]> {
  const apiKey = getApiKey();
  const baseUrl = apiKey ? 'https://api.tickflow.org' : 'https://free-api.tickflow.org';
  // count 为自然日口径: 400 天 ≈ 270+ 个交易日 > 1 年
  const url = `${baseUrl}/v1/klines?symbol=${symbol}&period=1d&count=400&adjust=forward`;

  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;

  let lastError = '';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Proactively throttle to 55/min, under the free tier's 60/min cap.
      // Shared with api.ts via the module-level limiter.
      await acquireTickFlowSlot();
      const resp = await fetch(url, { headers, signal });
      if (resp.status === 429) {
        lastError = 'HTTP 429 (限流)';
        await sleep(attempt * 2000);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const responseData = await resp.json();
      const data = responseData?.data;
      const length = data?.timestamp?.length || 0;
      if (!data || length === 0) throw new Error('无K线数据');

      const klines: Kline[] = [];
      const CHINA_OFFSET = 8 * 60 * 60 * 1000;
      for (let i = 0; i < length; i++) {
        const date = new Date(data.timestamp[i] + CHINA_OFFSET);
        const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
        klines.push({
          date: dateStr,
          open: parseFloat(data.open[i].toFixed(2)),
          high: parseFloat(data.high[i].toFixed(2)),
          low: parseFloat(data.low[i].toFixed(2)),
          close: parseFloat(data.close[i].toFixed(2)),
          volume: data.volume[i] || 0,
          amount: data.amount[i] || 0,
        });
      }
      return klines;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      lastError = err?.message || String(err);
      if (attempt < maxRetries) await sleep(1200);
    }
  }
  throw new Error(lastError || '请求失败');
}
