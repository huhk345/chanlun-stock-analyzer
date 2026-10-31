// ---------------------------------------------------------------------------
// 指数/自选标的扫描的静态数据层
//
//   - 扫描本身 (K 线拉取 + 缠论计算) 完全在浏览器内完成, 见 src/utils/indexScan.ts。
//     本文件只保留代码解析 (指数/ETF/股票分类) 这些与数据源无关的工具函数。
// ---------------------------------------------------------------------------

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
