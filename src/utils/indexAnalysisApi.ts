// ---------------------------------------------------------------------------
// 指数/自选标的扫描的静态数据层 (仅前端仍需要的部分)
//
//   - 成分股列表: public/index-members.{hs300,zz500}.json
//     (由 scripts/download-index-stocks.ts 生成于 data/, 用 `pnpm run sync-index` 同步)
//   - 股票名称: public/merged_stock_data.json (code -> stock_name)
//
// 缠论买卖点扫描本身 (K 线拉取 + 缠论计算 + 资金流) 已全部移到后端,
// 由 WebSocket /ws 驱动, 见 src/utils/scanSocket.ts 与 server/scan.ts。
// ---------------------------------------------------------------------------

import { INDEX_META, type IndexId, type ScanTimeframe } from '../types/scan';

export { INDEX_META };
export type { IndexId, ScanTimeframe };

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

const membersCache: Partial<Record<IndexId, string[]>> = {};

export async function fetchIndexMembers(id: IndexId): Promise<string[]> {
  const cached = membersCache[id];
  if (cached) return cached;

  const resp = await fetch(`/${INDEX_META[id].file}`);
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
