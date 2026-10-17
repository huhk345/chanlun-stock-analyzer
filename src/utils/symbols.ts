/**
 * 股票代码解析与转换 (浏览器 / Node 服务 / CLI 脚本共用)。
 *
 * 支持的代码格式 (大小写不敏感):
 *   - A股: 6位代码 ('600519'), '600519.SH' / '.SS' / '.SZ'
 *   - 美股: 裸 ticker ('AAPL', 'BRK.B'), 'AAPL.US' / '.OQ' (NASDAQ) / '.N' (NYSE) / '.AM' (AMEX)
 *   - 港股: '00700.HK', 'HK00700', 裸 4-5 位代码 ('00700')
 */

/** A 股标准键: 6 位数字 + .SH/.SZ 后缀 */
const ASHARE_SYMBOL_RE = /^\d{6}\.(SH|SZ)$/;

export function isAshareSymbol(v: unknown): v is string {
  return typeof v === 'string' && ASHARE_SYMBOL_RE.test(v);
}

/** Supported markets for the analyzer. */
export type StockMarket = 'cn' | 'us' | 'hk';

/**
 * Resolve user input into a canonical symbol + market.
 * (见文件头注释中的格式列表)
 */
export function resolveSymbol(symbol: string): {
  resolved: string;
  displayName: string;
  isChinaStock: boolean;
  market: StockMarket | 'other';
  /** Tencent ifzq code for us/hk markets (e.g. 'usAAPL', 'hk00700'); '' otherwise. */
  txSymbol: string;
} {
  const clean = symbol.trim().toUpperCase();
  const cn = (resolved: string, displayName: string) => {
    const code = resolved.split('.')[0];
    const isSS = /^(60|68|90|11|13|51|58)/.test(code);
    const isBJ = /^(43|83|87|88|92)/.test(code);
    const prefix = isSS ? 'sh' : isBJ ? 'bj' : 'sz';
    return {
      resolved,
      displayName,
      isChinaStock: true as const,
      market: 'cn' as const,
      txSymbol: `${prefix}${code}`,
    };
  };
  if (/^\d{6}$/.test(clean)) {
    // 6-digit pure numbers represent Chinese stocks
    const isSS = /^(60|68|90|11|13|51|58|60)/.test(clean);
    const suffix = isSS ? 'SH' : 'SZ';
    return cn(`${clean}.${suffix}`, `${clean}.${suffix}`);
  }
  // Handle symbols with .SS / .SH / .SZ suffix
  if (clean.endsWith('.SS')) {
    return cn(clean.replace('.SS', '.SH'), clean);
  }
  if (clean.endsWith('.SH') || clean.endsWith('.SZ')) {
    return cn(clean, clean);
  }
  // HK: '00700.HK' / '0700.HK'
  const hkSuffixed = /^(\d{4,5})\.HK$/.exec(clean);
  if (hkSuffixed) {
    const code = hkSuffixed[1].padStart(5, '0');
    return {
      resolved: `${code}.HK`,
      displayName: `${code}.HK`,
      isChinaStock: false,
      market: 'hk',
      txSymbol: `hk${code}`,
    };
  }
  // HK: 'HK00700' / 'hk0700'
  const hkPrefixed = /^HK(\d{4,5})$/.exec(clean);
  if (hkPrefixed) {
    const code = hkPrefixed[1].padStart(5, '0');
    return {
      resolved: `${code}.HK`,
      displayName: `${code}.HK`,
      isChinaStock: false,
      market: 'hk',
      txSymbol: `hk${code}`,
    };
  }
  // HK: bare 4-5 digit code ('00700')
  if (/^\d{4,5}$/.test(clean)) {
    const code = clean.padStart(5, '0');
    return {
      resolved: `${code}.HK`,
      displayName: `${code}.HK`,
      isChinaStock: false,
      market: 'hk',
      txSymbol: `hk${code}`,
    };
  }
  // US: 'AAPL.US' / 'NVDA.OQ' / 'TSLA.N' / 'SPY.AM'
  const usSuffixed = /^([A-Z]{1,5}(?:\.[A-Z])?)\.(US|OQ|N|AM)$/.exec(clean);
  if (usSuffixed) {
    const ticker = usSuffixed[1];
    return {
      resolved: `${ticker}.US`,
      displayName: `${ticker}.US`,
      isChinaStock: false,
      market: 'us',
      txSymbol: `us${ticker}`,
    };
  }
  // US: bare ticker ('AAPL', 'NVDA', 'BRK.B')
  if (/^[A-Z]{1,5}(?:\.[A-Z])?$/.test(clean)) {
    return {
      resolved: `${clean}.US`,
      displayName: `${clean}.US`,
      isChinaStock: false,
      market: 'us',
      txSymbol: `us${clean}`,
    };
  }
  return {
    resolved: clean,
    displayName: clean,
    isChinaStock: false,
    market: 'other',
    txSymbol: '',
  };
}

/**
 * symbolKey -> 腾讯代码: '000001.SZ' -> 'sz000001', '600519.SH' -> 'sh600519'。
 * 非 A 股代码 (hk00700 / usAAPL.OQ 等) 原样返回, 由腾讯自行识别。
 * 注意必须按后缀判定交易所: 000001.SZ 是平安银行, 000001.SH 才是上证指数。
 */
export function toTencentSymbol(symbol: string): string {
  const dot = symbol.lastIndexOf('.');
  if (dot < 0) return symbol;
  const code = symbol.slice(0, dot);
  const market = symbol.slice(dot + 1).toUpperCase();
  if (market === 'SH') return `sh${code}`;
  if (market === 'SZ') return `sz${code}`;
  if (market === 'BJ') return `bj${code}`;
  return symbol;
}
