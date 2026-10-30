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

// ---------------------------------------------------------------------------
// A 股板块划分 (组合模拟的「排除板块」选项前后端共用)
// ---------------------------------------------------------------------------

/** 主板 / 创业板 / 科创板 / 北交所 */
export type AShareBoard = 'main' | 'chinext' | 'star' | 'bse';

/** 可按板块排除的集合 (主板不可排除) */
export type ExcludableBoard = Exclude<AShareBoard, 'main'>;

/** 排除板块的可选项 (前端渲染 chips / CLI 参数校验共用) */
export const EXCLUDABLE_BOARDS: readonly {
  id: ExcludableBoard;
  label: string;
  hint: string;
  /** 代码前缀, 用于展示 */
  prefixes: string;
}[] = [
  { id: 'chinext', label: '创业板', hint: '300 / 301', prefixes: '300/301' },
  { id: 'star', label: '科创板', hint: '688 / 689', prefixes: '688/689' },
  { id: 'bse', label: '北交所', hint: '43 / 83 / 87 / 88 / 92', prefixes: '43/83/87/88/92' },
];

/** 6 位代码 (可带后缀) -> 板块 */
export function aShareBoard(codeOrSymbol: string): AShareBoard {
  const code = String(codeOrSymbol ?? '')
    .trim()
    .replace(/\.(SH|SS|SZ|BJ)$/i, '');
  if (/^(300|301)/.test(code)) return 'chinext';
  if (/^(688|689)/.test(code)) return 'star';
  if (/^(43|83|87|88|92)/.test(code)) return 'bse';
  return 'main';
}

/** 该标的所属板块是否在排除名单内 */
export function isBoardExcluded(
  symbol: string,
  exclude: readonly ExcludableBoard[] | undefined,
): boolean {
  if (!exclude || exclude.length === 0) return false;
  const board = aShareBoard(symbol);
  return board !== 'main' && (exclude as readonly AShareBoard[]).includes(board);
}

/** 排除名单标签 (进度/诊断文案用), 空数组返回 '' */
export function describeExcludedBoards(exclude: readonly ExcludableBoard[] | undefined): string {
  if (!exclude || exclude.length === 0) return '';
  return exclude
    .map((id) => {
      const found = EXCLUDABLE_BOARDS.find((b) => b.id === id);
      return found ? `${found.label}(${found.prefixes})` : id;
    })
    .join(' + ');
}

/**
 * 交易所前缀 (腾讯代码 sh/sz/bj): **显式后缀优先**, 只有无后缀时才按代码段推断。
 *
 * 这一步不能只看代码段: 000001.SH 是上证指数 (3599 点), 000001.SZ 才是平安银行 (11 元);
 * 同理 000300.SH (沪深300)、000016.SH (上证50)、000905.SH (中证500)、000688.SH (科创50)
 * 都以 000 开头, 按代码段推断会全部错落到深市, 拉到完全不相干的个股K线。
 */
function exchangePrefix(code: string, suffix: string): 'sh' | 'sz' | 'bj' {
  if (suffix === 'SH' || suffix === 'SS') return 'sh';
  if (suffix === 'BJ') return 'bj';
  // 北交所代码段 (43/83/87/88/92) 无歧义, 裸代码推断出的 .SZ 也归 bj
  if (/^(43|83|87|88|92)/.test(code)) return 'bj';
  if (suffix === 'SZ') return 'sz';
  return /^(60|68|90|11|13|51|58)/.test(code) ? 'sh' : 'sz';
}

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
    const [code, suffix = ''] = resolved.split('.');
    const prefix = exchangePrefix(code, suffix);
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
  if (clean.endsWith('.SH') || clean.endsWith('.SZ') || clean.endsWith('.BJ')) {
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
  if (market === 'SH' || market === 'SS' || market === 'SZ' || market === 'BJ') {
    return `${exchangePrefix(code, market)}${code}`;
  }
  return symbol;
}
