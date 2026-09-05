// ---------------------------------------------------------------------------
// 市场总览数据层
// 数据来源:
//   - 腾讯行情 (web.sqt.gtimg.cn): 指数实时/收盘行情, 支持 CORS, GBK 编码
//   - 东方财富 (push2delay / push2his): 涨跌家数、大盘资金流向、板块/个股资金排行、全球指数
//   - Binance (data-api.binance.vision): 主流加密货币行情, 支持 CORS
// ---------------------------------------------------------------------------

export interface IndexQuote {
  symbol: string;      // e.g. sh000001
  code: string;        // e.g. 000001
  name: string;        // 上证指数
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number;        // 涨跌额
  changePercent: number; // 涨跌幅 %
  volume: number;        // 成交量 (手)
  amount: number;        // 成交额 (元)
  time: string;          // 数据时间 YYYYMMDDHHmmss
}

export interface MarketBreadth {
  up: number;
  down: number;
  flat: number;
}

export interface MarketFlowToday {
  main: number;       // 主力净流入 (元) = 超大单 + 大单
  superLarge: number; // 超大单净流入 (元)
  large: number;      // 大单净流入 (元)
  medium: number;     // 中单净流入 (元)
  small: number;      // 小单净流入 (元)
}

export interface DailyFlowPoint {
  date: string; // YYYY-MM-DD
  main: number; // 主力净流入 (元)
}

export interface FlowItem {
  code: string;
  name: string;
  price: number;
  changePercent: number;
  mainInflow: number;  // 主力净流入 (元)
  mainPercent: number; // 主力净流入占比 %
}

export interface LadderStock {
  code: string;
  name: string;
  lbc: number;     // 连板数
  fund: number;    // 封单金额 (元)
  industry: string;
}

export interface MarketSentiment {
  date: string;       // YYYY-MM-DD
  limitUp: number;    // 涨停家数
  limitDown: number;  // 跌停家数
  broken: number;     // 炸板家数
  maxBoards: number;  // 最高连板数
  ladder: LadderStock[];
}

const TENCENT_QUOTE_URL = 'https://web.sqt.gtimg.cn/q=';
const EM_DELAY_BASE = 'https://push2delay.eastmoney.com';
const EM_HIS_BASE = 'https://push2his.eastmoney.com';
const EM_EX_BASE = 'https://push2ex.eastmoney.com';
const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';

const INDEX_SYMBOLS = 'sh000001,sz399001,sz399006,sh000688,sh000300,sh000905';

// 获取主要指数行情 (上证指数 / 深证成指 / 创业板指 / 科创50 / 沪深300 / 中证500)
export async function fetchIndexQuotes(): Promise<IndexQuote[]> {
  const resp = await fetch(`${TENCENT_QUOTE_URL}${INDEX_SYMBOLS}`);
  if (!resp.ok) throw new Error(`腾讯行情接口错误 (${resp.status})`);

  const buffer = await resp.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buffer);

  const quotes: IndexQuote[] = [];
  const re = /v_(s[hz]\d{6})="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const d = m[2].split('~');
    // 字段布局: [1]名称 [2]代码 [3]现价 [4]昨收 [5]今开 [30]时间
    //          [31]涨跌额 [32]涨跌% [33]最高 [34]最低 [36]成交量(手) [37]成交额(万)
    if (d.length < 38) continue;
    quotes.push({
      symbol: m[1],
      code: d[2],
      name: d[1],
      price: parseFloat(d[3]) || 0,
      prevClose: parseFloat(d[4]) || 0,
      open: parseFloat(d[5]) || 0,
      high: parseFloat(d[33]) || 0,
      low: parseFloat(d[34]) || 0,
      change: parseFloat(d[31]) || 0,
      changePercent: parseFloat(d[32]) || 0,
      volume: parseFloat(d[36]) || 0,
      amount: (parseFloat(d[37]) || 0) * 10000,
      time: d[30] || '',
    });
  }
  if (quotes.length === 0) throw new Error('未获取到指数行情数据');
  return quotes;
}

export interface StockQuote {
  symbol: string;      // e.g. sh600519
  code: string;        // e.g. 600519
  name: string;
  price: number;
  changePercent: number;
}

// ---------------------------------------------------------------------------
// 环球市场: 全球主要指数 + 主流加密货币
// ---------------------------------------------------------------------------

export interface GlobalIndexQuote {
  code: string;          // e.g. DJIA
  secid: string;         // 东财 secid, e.g. '100.DJIA' (用于跳转分析页拉取K线)
  name: string;          // 道琼斯
  price: number;
  prevClose: number;
  change: number;        // 涨跌额
  changePercent: number; // 涨跌幅 %
}

// 全球主要指数 (34): 亚太 / 北美 / 拉美 / 欧洲 (东财 push2delay ulist 实测可用)
const GLOBAL_INDEX_SECIDS = '100.HSI,100.HSCEI,100.N225,100.TWII,100.KS11,100.SENSEX,100.STI,100.KLSE,100.JKSE,100.SET,100.PSI,100.VNINDEX,100.AORD,100.DJIA,100.SPX,100.NDX,251.HXC,100.TSX,100.MXX,100.BVSP,100.FTSE,100.GDAXI,100.FCHI,100.SX5E,100.SSMI,100.AEX,100.MIB,100.IBEX,100.HEX,100.ATX,100.RTS,100.OMXC20,100.ISEQ,100.PSI20';
// 科技与美股 ETF (12): 恒生科技 / 半导体 / 宽基 / 科技 / 创新 / 长债 (实测可用: 105=纳斯达克上市, 107=NYSE Arca/AMEX上市)
const TECH_INDEX_SECIDS = '124.HSTECH,105.SOXX,105.SMH,105.QQQ,107.SPY,107.DIA,107.IWM,107.XLK,107.VGT,107.ARKK,107.KWEB,105.TLT';
// 大宗商品与汇率 (17): 贵金属 / 能源 / 农产品 / 美元指数 / 离岸人民币 (实测可用)
const COMMODITY_SECIDS = '101.GC00Y,101.SI00Y,101.HG00Y,102.CL00Y,112.B00Y,102.NG00Y,102.HO00Y,102.RB00Y,103.ZS00Y,103.ZC00Y,103.ZW00Y,103.ZL00Y,103.ZM00Y,108.CT00Y,108.SB00Y,100.UDI,133.USDCNH';
// 美股个股 (32): 科技七巨头 / 芯片 / 软件消费 / 金融医药 / 中概ADR (105=纳斯达克, 106=纽交所, 实测可用)
const US_STOCK_SECIDS = '105.AAPL,105.MSFT,105.NVDA,105.AMZN,105.META,105.GOOGL,105.TSLA,105.AVGO,105.AMD,105.QCOM,105.ARM,105.NFLX,105.ADBE,105.COST,105.PLTR,105.COIN,105.MSTR,105.MU,105.PDD,105.JD,106.V,106.MA,106.JPM,106.LLY,106.UNH,106.XOM,106.DIS,106.CRM,106.ORCL,106.BABA,106.TSM,106.NIO';

// ---------------------------------------------------------------------------
// 用户自选面板: 环球市场 / 大宗商品与加密货币的可选标的目录 (选择存 localStorage)
// ---------------------------------------------------------------------------

export type MarketQuoteGroup = 'global' | 'tech' | 'us' | 'commodity';

export interface MarketPickItem {
  code: string;   // e.g. 'HSI' (卡片 key 与跳转用)
  secid: string;  // e.g. '100.HSI' (行情接口用)
  label: string;  // 选择器展示名
  group: MarketQuoteGroup;
}

const GLOBAL_PICK_ITEMS: [string, string][] = [
  // 大中华
  ['HSI', '恒生指数'], ['HSCEI', '恒生国企'], ['TWII', '台湾加权'],
  // 东北亚
  ['N225', '日经225'], ['KS11', '韩国KOSPI'],
  // 南亚/东南亚/大洋洲
  ['SENSEX', '印度SENSEX'], ['STI', '新加坡海峡'], ['KLSE', '马来西亚KLCI'],
  ['JKSE', '印尼雅加达'], ['SET', '泰国SET'], ['PSI', '菲律宾马尼拉'],
  ['VNINDEX', '越南胡志明'], ['AORD', '澳大利亚普通股'],
  // 北美
  ['DJIA', '道琼斯'], ['SPX', '标普500'], ['NDX', '纳斯达克'],
  ['HXC', '中国金龙'], ['TSX', '加拿大TSX'],
  // 拉美
  ['MXX', '墨西哥BOLSA'], ['BVSP', '巴西BOVESPA'],
  // 欧洲
  ['FTSE', '富时100'], ['GDAXI', '德国DAX'], ['FCHI', '法国CAC40'],
  ['SX5E', '欧洲斯托克50'], ['SSMI', '瑞士SMI'], ['AEX', '荷兰AEX'],
  ['MIB', '意大利MIB'], ['IBEX', '西班牙IBEX35'], ['HEX', '芬兰赫尔辛基'],
  ['ATX', '奥地利ATX'], ['RTS', '俄罗斯RTS'], ['OMXC20', '丹麦OMX20'],
  ['ISEQ', '爱尔兰综合'], ['PSI20', '葡萄牙PSI20'],
];
const TECH_PICK_ITEMS: [string, string][] = [
  ['HSTECH', '恒生科技'], ['SOXX', '费城半导体'], ['SMH', '半导体VanEck'],
  ['QQQ', '纳指100ETF'], ['SPY', '标普500ETF'], ['DIA', '道指ETF'],
  ['IWM', '罗素2000ETF'], ['XLK', '科技精选ETF'], ['VGT', '信息科技ETF'],
  ['ARKK', '创新ETF'], ['KWEB', '中概互联网ETF'], ['TLT', '美债20年+ETF'],
];
const COMMODITY_PICK_ITEMS: [string, string][] = [
  // 贵金属/工业金属
  ['GC00Y', 'COMEX黄金'], ['SI00Y', 'COMEX白银'], ['HG00Y', 'COMEX铜'],
  // 能源
  ['CL00Y', 'WTI原油'], ['B00Y', '布伦特原油'], ['NG00Y', '天然气'],
  ['HO00Y', '燃油'], ['RB00Y', '汽油'],
  // 农产品 (CBOT/ICE)
  ['ZS00Y', '大豆'], ['ZC00Y', '玉米'], ['ZW00Y', '小麦'],
  ['ZL00Y', '豆油'], ['ZM00Y', '豆粕'], ['CT00Y', '棉花'], ['SB00Y', '白糖'],
  // 汇率
  ['UDI', '美元指数'], ['USDCNH', '美元兑离岸人民币'],
];
const US_PICK_ITEMS: [string, string][] = [
  // 科技七巨头
  ['AAPL', '苹果'], ['MSFT', '微软'], ['NVDA', '英伟达'], ['AMZN', '亚马逊'],
  ['META', 'Meta'], ['GOOGL', '谷歌'], ['TSLA', '特斯拉'],
  // 芯片
  ['AVGO', '博通'], ['AMD', '超威半导体'], ['QCOM', '高通'], ['ARM', 'Arm'],
  ['MU', '美光科技'],
  // 软件/消费/加密概念
  ['NFLX', '奈飞'], ['ADBE', '奥多比'], ['COST', '开市客'], ['PLTR', 'Palantir'],
  ['COIN', 'Coinbase'], ['MSTR', 'Strategy'], ['PDD', '拼多多'], ['JD', '京东'],
  // 金融/医药/消费 (纽交所)
  ['V', '维萨'], ['MA', '万事达'], ['JPM', '摩根大通'], ['LLY', '礼来'],
  ['UNH', '联合健康'], ['XOM', '埃克森美孚'], ['DIS', '迪士尼'],
  ['CRM', '赛富时'], ['ORCL', '甲骨文'],
  // 中概/亚太 ADR
  ['BABA', '阿里巴巴'], ['TSM', '台积电'], ['NIO', '蔚来'],
];

function buildPickItems(pairs: [string, string][], secids: string, group: MarketQuoteGroup): MarketPickItem[] {
  const secidByCode = new Map<string, string>();
  for (const s of secids.split(',')) {
    const dot = s.indexOf('.');
    if (dot > 0) secidByCode.set(s.slice(dot + 1), s);
  }
  return pairs.map(([code, label]) => ({ code, label, group, secid: secidByCode.get(code) || '' }))
    .filter((it) => it.secid !== '');
}

/** 全目录 (顺序即默认展示顺序, 与线上硬编码列表一致) */
export const MARKET_QUOTE_CATALOG: MarketPickItem[] = [
  ...buildPickItems(GLOBAL_PICK_ITEMS, GLOBAL_INDEX_SECIDS, 'global'),
  ...buildPickItems(TECH_PICK_ITEMS, TECH_INDEX_SECIDS, 'tech'),
  ...buildPickItems(US_PICK_ITEMS, US_STOCK_SECIDS, 'us'),
  ...buildPickItems(COMMODITY_PICK_ITEMS, COMMODITY_SECIDS, 'commodity'),
];

/** 默认选中: 环球市场面板 (精简头条, 避免首屏过载; 自选对话框可访问全目录) */
export const DEFAULT_WORLD_CODES: string[] = [
  'HSI', 'N225', 'DJIA', 'SPX', 'NDX', 'HXC', 'FTSE', 'GDAXI',
  'HSTECH', 'SOXX', 'TWII', 'KS11',
];

/** 默认选中: 大宗商品 (精简头条) */
export const DEFAULT_COMM_IDS: string[] = ['GC00Y', 'CL00Y', 'B00Y', 'UDI', 'USDCNH'];

/** 默认选中: 主流加密货币 (精简头条) */
export const DEFAULT_CRYPTO_SYMBOLS: string[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'BCHUSDT'];

/** 全目录代码: 环球市场面板 (全球指数 + 科技/ETF + 美股个股, 目录顺序) */
export const WORLD_CATALOG_CODES: string[] = MARKET_QUOTE_CATALOG
  .filter((it) => it.group !== 'commodity')
  .map((it) => it.code);

/** 自选 codes -> 东财 secids 请求串 (保持目录顺序) */
export function marketSecidsFor(codes: string[]): string {
  const wanted = new Set(codes);
  return MARKET_QUOTE_CATALOG.filter((it) => wanted.has(it.code)).map((it) => it.secid).join(',');
}

/** 按自选顺序排列报价结果 (未选中的丢弃) */
export function sortQuotesByCodes<T extends { code: string }>(quotes: T[], codes: string[]): T[] {
  const rank = new Map(codes.map((c, i) => [c, i]));
  return quotes
    .filter((q) => rank.has(q.code))
    .sort((a, b) => (rank.get(a.code) ?? 0) - (rank.get(b.code) ?? 0));
}

/** code -> 分组 (面板拆分全球指数 / 科技指数用) */
export function marketGroupOf(code: string): MarketQuoteGroup | undefined {
  return MARKET_QUOTE_CATALOG.find((it) => it.code === code)?.group;
}

// 通用: 按东财 secid 批量获取报价 (字段 f2价格 f3涨跌% f4涨跌额 f12代码 f14名称 f18昨收)
export async function fetchQuotesBySecids(secids: string, errMsg: string): Promise<GlobalIndexQuote[]> {
  const url = `${EM_DELAY_BASE}/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f3,f4,f12,f14,f18`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${errMsg} (${resp.status})`);

  const json = await resp.json();
  const diff = json?.data?.diff;
  if (!Array.isArray(diff) || diff.length === 0) throw new Error(`未获取到${errMsg}数据`);

  // 代码 -> 完整 secid 映射 (跳转分析页时需要)
  const secidByCode = new Map<string, string>();
  for (const s of secids.split(',')) {
    const [mkt, code] = s.split('.');
    if (code) secidByCode.set(code, s);
  }

  const num = (v: unknown) => (typeof v === 'number' ? v : parseFloat(String(v)) || 0);
  return diff.map((it: any) => ({
    code: String(it.f12 || ''),
    secid: secidByCode.get(String(it.f12 || '')) || '',
    name: String(it.f14 || ''),
    price: num(it.f2),
    prevClose: num(it.f18),
    change: num(it.f4),
    changePercent: num(it.f3),
  }));
}

export async function fetchGlobalIndexQuotes(): Promise<GlobalIndexQuote[]> {
  return fetchQuotesBySecids(GLOBAL_INDEX_SECIDS, '全球指数');
}

export async function fetchTechIndexQuotes(): Promise<GlobalIndexQuote[]> {
  return fetchQuotesBySecids(TECH_INDEX_SECIDS, '科技指数');
}

export async function fetchCommodityQuotes(): Promise<GlobalIndexQuote[]> {
  return fetchQuotesBySecids(COMMODITY_SECIDS, '商品汇率');
}

// ---------------------------------------------------------------------------
// 机构多空持仓: 股指期货(IF/IH/IC/IM)前20会员成交持仓排名 (中金所数据, 东方财富数据中心)
// ---------------------------------------------------------------------------

const EM_DATACENTER_BASE = 'https://datacenter-web.eastmoney.com';
const INDEX_FUTURES_PREFIXES = ['IF', 'IH', 'IC', 'IM'];

export interface InstitutionPosition {
  name: string;        // 会员简称 (机构席位)
  long: number;        // 今日多单
  short: number;       // 今日空单
  netLong: number;     // 净多单 (多 - 空)
  longChange: number;  // 今日多单增减
  shortChange: number; // 今日空单增减
  net7d: number;       // 近7个交易日累计净增 (多增 - 空增)
}

export interface InstitutionPositionSummary {
  date: string;                    // 数据日期
  totalLong: number;               // 市场多单合计 (前20会员)
  totalShort: number;              // 市场空单合计
  list: InstitutionPosition[];     // 按净多绝对值排序的机构列表
}

interface DailyPosRow {
  ORG_CODE: string;
  MEMBER_NAME_ABBR?: string;
  ORG_NAME_ABBR_NEW?: string;
  SECURITY_CODE?: string;
  LONG_POSITION?: number | null;
  SHORT_POSITION?: number | null;
  LP_CHANGE?: number | null;
  SP_CHANGE?: number | null;
}

async function fetchDailyPositionRows(day: string): Promise<DailyPosRow[]> {
  const url = `${EM_DATACENTER_BASE}/api/data/v1/get?reportName=RPT_FUTU_DAILYPOSITION&columns=ALL&pageSize=500&pageNumber=1&source=WEB&client=WEB&sortColumns=LONG_POSITION&sortTypes=-1`
    + `&filter=(TRADE_DATE='${day}')(TYPE="0")(TRADE_MARKET_CODE="069001009")`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`机构持仓接口错误 (${resp.status})`);
  const json = await resp.json();
  const data = json?.result?.data;
  return Array.isArray(data) ? data : [];
}

function mergeDay(rows: DailyPosRow[]): Map<string, InstitutionPosition> {
  const merged = new Map<string, InstitutionPosition>();
  for (const r of rows) {
    const code = String(r.SECURITY_CODE || '');
    if (!INDEX_FUTURES_PREFIXES.includes(code.slice(0, 2))) continue;
    const key = r.ORG_CODE ?? r.MEMBER_NAME_ABBR ?? '';
    if (!key) continue;
    const e = merged.get(String(key)) || { name: r.ORG_NAME_ABBR_NEW || r.MEMBER_NAME_ABBR || '', long: 0, short: 0, netLong: 0, longChange: 0, shortChange: 0, net7d: 0 };
    e.long += r.LONG_POSITION || 0;
    e.short += r.SHORT_POSITION || 0;
    e.longChange += r.LP_CHANGE || 0;
    e.shortChange += r.SP_CHANGE || 0;
    e.netLong = e.long - e.short;
    merged.set(String(key), e);
  }
  return merged;
}

// 最近 n 个交易日 (含 startDate; 跳过周末, 法定节假日由空结果自然跳过)
function recentTradeDays(startDate: string, n: number): string[] {
  const days: string[] = [];
  let d = new Date(`${startDate}T00:00:00Z`);
  while (days.length < n) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() - 86400000);
  }
  return days;
}

export async function fetchInstitutionPositions(days = 7): Promise<InstitutionPositionSummary> {
  // 最新交易日
  const latestUrl = `${EM_DATACENTER_BASE}/api/data/v1/get?reportName=RPT_FUTU_DAILYPOSITION&columns=TRADE_DATE&pageSize=1&pageNumber=1&sortColumns=TRADE_DATE&sortTypes=-1&filter=(TYPE="0")&source=WEB&client=WEB`;
  const latestResp = await fetch(latestUrl);
  if (!latestResp.ok) throw new Error(`机构持仓接口错误 (${latestResp.status})`);
  const latestJson = await latestResp.json();
  const latest = latestJson?.result?.data?.[0]?.TRADE_DATE;
  if (!latest) throw new Error('未获取到机构持仓数据');
  const date = String(latest).slice(0, 10);

  const tradeDays = recentTradeDays(date, days);
  const dayResults = await Promise.all(tradeDays.map((day) => fetchDailyPositionRows(day).catch(() => [] as DailyPosRow[])));

  const today = mergeDay(dayResults[0]);
  // 近7日累计净增
  const acc = new Map<string, { l: number; s: number }>();
  for (const rows of dayResults) {
    for (const [key, e] of mergeDay(rows)) {
      const a = acc.get(key) || { l: 0, s: 0 };
      a.l += e.longChange;
      a.s += e.shortChange;
      acc.set(key, a);
    }
  }

  const list: InstitutionPosition[] = [];
  let totalLong = 0;
  let totalShort = 0;
  for (const [key, e] of today) {
    totalLong += e.long;
    totalShort += e.short;
    const a = acc.get(key);
    list.push({ ...e, net7d: a ? a.l - a.s : 0 });
  }
  list.sort((x, y) => Math.abs(y.netLong) - Math.abs(x.netLong));

  return { date, totalLong, totalShort, list };
}

export interface CryptoQuote {
  symbol: string;        // e.g. BTCUSDT
  base: string;          // e.g. BTC
  name: string;          // 比特币
  price: number;         // USD
  changePercent: number; // 24h 涨跌幅 %
  high: number;          // 24h 最高
  low: number;           // 24h 最低
  quoteVolume: number;   // 24h 成交额 (USDT)
}

export const CRYPTO_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
  'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TRXUSDT', 'DOTUSDT', 'POLUSDT',
  'LTCUSDT', 'BCHUSDT', 'NEARUSDT', 'UNIUSDT', 'APTUSDT', 'ARBUSDT',
  'OPUSDT', 'INJUSDT', 'SUIUSDT', 'SEIUSDT', 'PEPEUSDT', 'SHIBUSDT',
  'ATOMUSDT', 'FILUSDT', 'ETCUSDT', 'XLMUSDT', 'HBARUSDT', 'VETUSDT',
  'ICPUSDT', 'FETUSDT', 'RENDERUSDT', 'TAOUSDT', 'WIFUSDT', 'BONKUSDT',
  'JUPUSDT', 'ONDOUSDT', 'AAVEUSDT',
];
const CRYPTO_NAMES: Record<string, string> = {
  BTCUSDT: '比特币 (BTC)',
  ETHUSDT: '以太坊 (ETH)',
  SOLUSDT: 'SOL',
  BNBUSDT: 'BNB',
  XRPUSDT: '瑞波币 (XRP)',
  DOGEUSDT: '狗狗币 (DOGE)',
  ADAUSDT: '艾达币 (ADA)',
  AVAXUSDT: '雪崩 (AVAX)',
  LINKUSDT: 'Chainlink (LINK)',
  TRXUSDT: '波场 (TRX)',
  DOTUSDT: '波卡 (DOT)',
  POLUSDT: 'Polygon (POL)',
  LTCUSDT: '莱特币 (LTC)',
  BCHUSDT: '比特币现金 (BCH)',
  NEARUSDT: 'NEAR',
  UNIUSDT: 'Uniswap (UNI)',
  APTUSDT: 'Aptos (APT)',
  ARBUSDT: 'Arbitrum (ARB)',
  OPUSDT: 'Optimism (OP)',
  INJUSDT: 'Injective (INJ)',
  SUIUSDT: 'Sui (SUI)',
  SEIUSDT: 'Sei (SEI)',
  PEPEUSDT: 'Pepe (PEPE)',
  SHIBUSDT: '柴犬币 (SHIB)',
  ATOMUSDT: 'Cosmos (ATOM)',
  FILUSDT: 'Filecoin (FIL)',
  ETCUSDT: '以太坊经典 (ETC)',
  XLMUSDT: '恒星币 (XLM)',
  HBARUSDT: 'Hedera (HBAR)',
  VETUSDT: '唯链 (VET)',
  ICPUSDT: 'ICP',
  FETUSDT: 'Fetch.ai (FET)',
  RENDERUSDT: 'Render (RENDER)',
  TAOUSDT: 'Bittensor (TAO)',
  WIFUSDT: 'dogwifhat (WIF)',
  BONKUSDT: 'Bonk (BONK)',
  JUPUSDT: 'Jupiter (JUP)',
  ONDOUSDT: 'Ondo (ONDO)',
  AAVEUSDT: 'Aave (AAVE)',
};

export interface CryptoPickItem {
  symbol: string; // e.g. 'BTCUSDT'
  label: string;  // e.g. '比特币 (BTC)'
}

/** 加密货币可选目录 (顺序即默认展示顺序) */
export const CRYPTO_CATALOG: CryptoPickItem[] = CRYPTO_SYMBOLS.map((s) => ({
  symbol: s,
  label: CRYPTO_NAMES[s] || s,
}));

/** 是否为已知加密货币标的 (自选 id 归属判断用) */
export function isCryptoSymbol(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CRYPTO_NAMES, id);
}

/** 全目录代码: 大宗商品与加密货币面板 (商品汇率 + 全部加密货币, 目录顺序) */
export const COMM_CATALOG_CODES: string[] = [
  ...MARKET_QUOTE_CATALOG.filter((it) => it.group === 'commodity').map((it) => it.code),
  ...CRYPTO_SYMBOLS,
];

/** 自选 symbols 过滤: 仅保留已知标的 (保持目录顺序); 不传则返回全部 */
function resolveCryptoList(symbols?: string[]): string[] {
  if (!symbols) return CRYPTO_SYMBOLS;
  const wanted = new Set(symbols.map((s) => s.trim().toUpperCase()));
  return CRYPTO_SYMBOLS.filter((s) => wanted.has(s));
}

// 主流加密货币行情 (Binance 公共行情接口, 24h ticker, USD 计价)
export async function fetchCryptoQuotes(symbols?: string[]): Promise<CryptoQuote[]> {
  const list = resolveCryptoList(symbols);
  if (list.length === 0) return [];
  const param = encodeURIComponent(JSON.stringify(list));
  const resp = await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${param}`);
  if (!resp.ok) throw new Error(`加密货币行情接口错误 (${resp.status})`);

  const arr = await resp.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('未获取到加密货币行情');

  const map = new Map<string, CryptoQuote>();
  for (const it of arr) {
    const symbol = String(it.symbol || '');
    map.set(symbol, {
      symbol,
      base: symbol.replace('USDT', ''),
      name: CRYPTO_NAMES[symbol] || symbol,
      price: parseFloat(it.lastPrice) || 0,
      changePercent: parseFloat(it.priceChangePercent) || 0,
      high: parseFloat(it.highPrice) || 0,
      low: parseFloat(it.lowPrice) || 0,
      quoteVolume: parseFloat(it.quoteVolume) || 0,
    });
  }
  // 按目录顺序输出 (自选子集保持相对顺序)
  return list.map((s) => map.get(s)).filter((q): q is CryptoQuote => !!q);
}

// 加密货币实时行情: Binance WebSocket @ticker 流 (每秒推送 24h 滚动统计)
// 返回取消订阅函数; 断线自动重连; onStatus 用于上报连接状态 (live=true 表示实时推送中)
// symbols 为自选子集 (不传则订阅全部); 推送恒为完整快照, 不会收缩
export function subscribeCryptoQuotes(
  onUpdate: (quotes: CryptoQuote[]) => void,
  onStatus?: (live: boolean) => void,
  symbols?: string[],
): () => void {
  const list = resolveCryptoList(symbols);
  if (list.length === 0) return () => {};
  const wanted = new Set(list);
  const streams = list.map((s) => `${s.toLowerCase()}@ticker`).join('/');
  const latest = new Map<string, CryptoQuote>();
  let ws: WebSocket | null = null;
  let closed = false;
  let live = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setLive = (v: boolean) => {
    if (live === v) return;
    live = v;
    onStatus?.(v);
  };

  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(`wss://data-stream.binance.vision/stream?streams=${streams}`);
    } catch {
      retryTimer = setTimeout(connect, 5000);
      return;
    }
    ws.onopen = () => setLive(true);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const d = msg?.data;
        if (!d || d.e !== '24hrTicker') return;
        setLive(true);
        const symbol = String(d.s || '').toUpperCase();
        if (!wanted.has(symbol) || !CRYPTO_NAMES[symbol]) return;
        latest.set(symbol, {
          symbol,
          base: symbol.replace('USDT', ''),
          name: CRYPTO_NAMES[symbol] || symbol,
          price: parseFloat(d.c) || 0,
          changePercent: parseFloat(d.P) || 0,
          high: parseFloat(d.h) || 0,
          low: parseFloat(d.l) || 0,
          quoteVolume: parseFloat(d.q) || 0,
        });
        // 仅推送完整快照: 每条 WS 消息只带一只币种, 未集齐就推送会导致
        // 消费方卡片先消失后逐个出现 (连接建立 / 重连时必现闪烁)。
        // latest 在重连间保持, 因此重连后每次推送仍是完整集合。
        if (latest.size < list.length) return;
        // 按目录顺序输出
        onUpdate(list.map((s) => latest.get(s)).filter((q): q is CryptoQuote => !!q));
      } catch { /* 忽略单条消息解析错误 */ }
    };
    ws.onclose = () => {
      setLive(false);
      if (!closed) retryTimer = setTimeout(connect, 5000);
    };
    ws.onerror = () => ws?.close();
  };

  connect();
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (ws) { ws.onclose = null; ws.close(); }
  };
}

// 加密货币价格展示: 大币种保留2位小数, 小币种保留更多精度
export function formatCryptoPrice(value: number): string {
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(4);
  return value.toFixed(6);
}

// ---------------------------------------------------------------------------
// 交易时段判断 (按交易所所在时区, 自动处理夏令时, 忽略节假日)
// ---------------------------------------------------------------------------

type Session = [number, number]; // 当地时间 [开始分钟, 结束分钟]

export type MarketId = 'cn' | 'hk' | 'jp' | 'tw' | 'kr' | 'us' | 'uk' | 'de';

export interface MarketSessionInfo {
  id: MarketId;
  label: string;      // 市场中文名
  open: boolean;      // 当前是否处于交易时段
  localTime: string;  // 交易所当地时间 HH:MM
}

interface MarketDef {
  id: MarketId;
  label: string;
  tz: string;         // IANA 时区
  sessions: Session[];
}

// 各市场交易时段定义 (当地时间, 分钟)
const MARKET_DEFS: MarketDef[] = [
  { id: 'cn', label: 'A股',  tz: 'Asia/Shanghai',    sessions: [[555, 690], [780, 905]] }, // 09:15–11:30 / 13:00–15:05 含集合竞价与尾差
  { id: 'hk', label: '港股',  tz: 'Asia/Hong_Kong',   sessions: [[570, 720], [780, 960]] }, // 09:30–12:00 / 13:00–16:00
  { id: 'jp', label: '日经',  tz: 'Asia/Tokyo',       sessions: [[540, 690], [750, 900]] }, // 09:00–11:30 / 12:30–15:00
  { id: 'tw', label: '台股',  tz: 'Asia/Taipei',      sessions: [[540, 810]] },             // 09:00–13:30
  { id: 'kr', label: '韩股',  tz: 'Asia/Seoul',       sessions: [[540, 930]] },             // 09:00–15:30
  { id: 'us', label: '美股',  tz: 'America/New_York', sessions: [[570, 960]] },             // 09:30–16:00
  { id: 'uk', label: '富时',  tz: 'Europe/London',    sessions: [[480, 990]] },             // 08:00–16:30
  { id: 'de', label: 'DAX',  tz: 'Europe/Berlin',    sessions: [[540, 1050]] },            // 09:00–17:30
];

// 读取某时区当前星期/分钟/时间串
function readLocal(tz: string): { weekday: number; minutes: number; hhmm: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = wdMap[get('weekday')] ?? -1;
    const h = parseInt(get('hour'), 10) % 24;
    const m = parseInt(get('minute'), 10);
    if (weekday < 0 || Number.isNaN(h) || Number.isNaN(m)) return null;
    return { weekday, minutes: h * 60 + m, hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
  } catch {
    return null;
  }
}

function inSessions(t: { weekday: number; minutes: number } | null, sessions: Session[]): boolean {
  if (!t) return false;
  if (t.weekday <= 0 || t.weekday >= 6) return false; // 周末休市
  return sessions.some(([s, e]) => t.minutes >= s && t.minutes <= e);
}

// A 股是否交易中 (含集合竞价与收盘尾差)
export function isCnMarketOpen(): boolean {
  const t = readLocal('Asia/Shanghai');
  return inSessions(t, [[555, 690], [780, 905]]);
}

// 全球主要市场 (港/日/美/英/德) 是否任一在交易
export function anyGlobalMarketOpen(): boolean {
  return (
    (inSessions(readLocal('Asia/Hong_Kong'), [[570, 720], [780, 960]])) ||
    (inSessions(readLocal('Asia/Tokyo'), [[540, 690], [750, 900]])) ||
    (inSessions(readLocal('America/New_York'), [[570, 960]])) ||
    (inSessions(readLocal('Europe/London'), [[480, 990]])) ||
    (inSessions(readLocal('Europe/Berlin'), [[540, 1050]]))
  );
}

/** 各市场当前交易状态快照 (供行情面板展示 交易中/休市 徽标) */
export function getMarketSessions(): Record<MarketId, MarketSessionInfo> {
  const out = {} as Record<MarketId, MarketSessionInfo>;
  for (const m of MARKET_DEFS) {
    const t = readLocal(m.tz);
    out[m.id] = {
      id: m.id,
      label: m.label,
      open: inSessions(t, m.sessions),
      localTime: t?.hhmm || '--:--',
    };
  }
  return out;
}

/** 环球指数东财代码 -> 所属市场 (无对应市场的返回 null; ETF 代理归属美股时段) */
export function marketIdForIndexCode(code: string): MarketId | null {
  const map: Record<string, MarketId> = {
    HSI: 'hk', HSCEI: 'hk', HSTECH: 'hk',
    N225: 'jp',
    TWII: 'tw',
    KS11: 'kr',
    SENSEX: 'hk', STI: 'hk', KLSE: 'hk', JKSE: 'hk', SET: 'hk',
    PSI: 'hk', VNINDEX: 'hk', AORD: 'hk',
    DJIA: 'us', SPX: 'us', NDX: 'us', HXC: 'us',
    SOXX: 'us', SMH: 'us', QQQ: 'us', SPY: 'us', DIA: 'us', IWM: 'us',
    XLK: 'us', VGT: 'us', ARKK: 'us', KWEB: 'us', TLT: 'us',
    AAPL: 'us', MSFT: 'us', NVDA: 'us', AMZN: 'us', META: 'us', GOOGL: 'us', TSLA: 'us',
    AVGO: 'us', AMD: 'us', QCOM: 'us', ARM: 'us', MU: 'us',
    NFLX: 'us', ADBE: 'us', COST: 'us', PLTR: 'us', COIN: 'us', MSTR: 'us',
    PDD: 'us', JD: 'us', V: 'us', MA: 'us', JPM: 'us', LLY: 'us',
    UNH: 'us', XOM: 'us', DIS: 'us', CRM: 'us', ORCL: 'us',
    BABA: 'us', TSM: 'us', NIO: 'us',
    TSX: 'us', MXX: 'us', BVSP: 'us',
    FTSE: 'uk',
    GDAXI: 'de', FCHI: 'de', SX5E: 'de', SSMI: 'de', AEX: 'de',
    MIB: 'de', IBEX: 'de', HEX: 'de', ATX: 'de',
    RTS: 'de', OMXC20: 'de', ISEQ: 'uk', PSI20: 'de',
  };
  return map[code] ?? null;
}

// 批量获取个股/ETF/指数实时或收盘行情 (腾讯行情, symbols 形如 'sh600519' / 'sz000001')
export async function fetchStockQuotes(symbols: string[]): Promise<StockQuote[]> {
  if (symbols.length === 0) return [];
  const resp = await fetch(`${TENCENT_QUOTE_URL}${symbols.join(',')}`);
  if (!resp.ok) throw new Error(`腾讯行情接口错误 (${resp.status})`);

  const buffer = await resp.arrayBuffer();
  const text = new TextDecoder('gbk').decode(buffer);

  const quotes: StockQuote[] = [];
  const re = /v_(s[hz]\d{6})="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const d = m[2].split('~');
    // 字段布局与指数行情一致: [1]名称 [2]代码 [3]现价 [32]涨跌%
    if (d.length < 33) continue;
    quotes.push({
      symbol: m[1],
      code: d[2],
      name: d[1],
      price: parseFloat(d[3]) || 0,
      changePercent: parseFloat(d[32]) || 0,
    });
  }
  if (quotes.length === 0) throw new Error('未获取到个股行情数据');
  return quotes;
}

// 获取沪深两市涨跌家数 + 当日大盘资金流向 (主力/超大单/大单/中单/小单)
export async function fetchMarketBreadthAndFlow(): Promise<{
  breadth: MarketBreadth;
  flow: MarketFlowToday;
}> {
  const url = `${EM_DELAY_BASE}/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=f104,f105,f106,f62,f66,f72,f78,f84`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`资金流向接口错误 (${resp.status})`);

  const json = await resp.json();
  const diff = json?.data?.diff;
  if (!Array.isArray(diff) || diff.length < 2) throw new Error('未获取到市场资金数据');

  const [sh, sz] = diff;
  const num = (v: unknown) => (typeof v === 'number' ? v : parseFloat(String(v)) || 0);
  return {
    breadth: {
      up: num(sh.f104) + num(sz.f104),
      down: num(sh.f105) + num(sz.f105),
      flat: num(sh.f106) + num(sz.f106),
    },
    flow: {
      main: num(sh.f62) + num(sz.f62),
      superLarge: num(sh.f66) + num(sz.f66),
      large: num(sh.f72) + num(sz.f72),
      medium: num(sh.f78) + num(sz.f78),
      small: num(sh.f84) + num(sz.f84),
    },
  };
}

// 获取沪深两市每日主力净流入历史 (日线)
// push2his 返回完整历史; push2delay 通常仅返回最新一天, 作为降级备选
export async function fetchMarketFlowHistory(days = 30): Promise<DailyFlowPoint[]> {
  const path = '/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&secid=1.000001&secid2=0.399001&fields1=f1,f2,f3,f7&fields2=f51,f52';
  let lastError = '未获取到大盘资金流向历史';

  for (const base of [EM_HIS_BASE, EM_DELAY_BASE]) {
    try {
      const resp = await fetch(base + path);
      if (!resp.ok) {
        lastError = `资金历史接口错误 (${resp.status})`;
        continue;
      }
      const json = await resp.json();
      const klines: string[] = json?.data?.klines || [];
      const points: DailyFlowPoint[] = [];
      for (const line of klines) {
        const [date, main] = line.split(',');
        const v = parseFloat(main);
        if (date && !isNaN(v)) points.push({ date, main: v });
      }
      if (points.length > 0) return points.slice(-days);
    } catch (e: any) {
      lastError = e?.message || lastError;
    }
  }
  throw new Error(lastError);
}

// 板块/个股资金排行
// fs=m:90+t:2              行业板块
// fs=m:0+t:6,m:0+t:80,...  沪深A股 (深主板/创业板 + 沪主板/科创板)
const STOCK_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
const FLOW_LIST_FIELDS = 'f12,f14,f2,f3,f62,f184';

async function fetchFlowList(fs: string, po: 0 | 1, count: number): Promise<FlowItem[]> {
  const url = `${EM_DELAY_BASE}/api/qt/clist/get?fid=f62&po=${po}&pz=${count}&pn=1&np=1&fltt=2&invt=2&fs=${fs}&fields=${FLOW_LIST_FIELDS}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`资金排行接口错误 (${resp.status})`);

  const json = await resp.json();
  const diff = json?.data?.diff;
  if (!Array.isArray(diff)) throw new Error('未获取到资金排行数据');

  const num = (v: unknown) => (typeof v === 'number' ? v : parseFloat(String(v)) || 0);
  return diff.map((it: any) => ({
    code: String(it.f12 || ''),
    name: String(it.f14 || ''),
    price: num(it.f2),
    changePercent: num(it.f3),
    mainInflow: num(it.f62),
    mainPercent: num(it.f184),
  }));
}

// 行业板块资金排行: po=1 净流入靠前, po=0 净流出靠前
export function fetchSectorFlowTop(po: 0 | 1, count = 10): Promise<FlowItem[]> {
  return fetchFlowList('m:90+t:2', po, count);
}

// 个股主力净流入排行: po=1 净流入靠前, po=0 净流出靠前
export function fetchStockFlowTop(po: 0 | 1, count = 10): Promise<FlowItem[]> {
  return fetchFlowList(STOCK_FS, po, count);
}

export interface HotSector {
  code: string;                // 板块代码 e.g. BK1616
  name: string;                // 板块名称
  changePercent: number;       // 板块涨跌幅 %
  mainInflow: number;          // 主力净流入 (元)
  mainPercent: number;         // 主力净占比 %
  leaderCode: string;          // 领涨龙头代码
  leaderName: string;          // 领涨龙头名称
  leaderChangePercent: number; // 领涨龙头涨跌幅 %
}

// 热门行业板块排行 (按涨跌幅) + 各板块领涨龙头股
// f128 龙头名称 / f140 龙头代码 / f136 龙头涨跌幅
export async function fetchHotSectors(count = 10): Promise<HotSector[]> {
  const url = `${EM_DELAY_BASE}/api/qt/clist/get?fid=f3&po=1&pz=${count}&pn=1&np=1&fltt=2&invt=2&fs=m:90+t:2&fields=f12,f14,f3,f62,f184,f128,f136,f140`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`板块行情接口错误 (${resp.status})`);

  const json = await resp.json();
  const diff = json?.data?.diff;
  if (!Array.isArray(diff)) throw new Error('未获取到板块数据');

  const num = (v: unknown) => (typeof v === 'number' ? v : parseFloat(String(v)) || 0);
  return diff
    .map((it: any) => ({
      code: String(it.f12 || ''),
      name: String(it.f14 || ''),
      changePercent: num(it.f3),
      mainInflow: num(it.f62),
      mainPercent: num(it.f184),
      leaderCode: String(it.f140 || ''),
      leaderName: String(it.f128 || '').trim(),
      leaderChangePercent: num(it.f136),
    }))
    .filter((s: HotSector) => s.code && s.name && s.leaderCode && s.leaderName);
}

// 涨跌停/炸板统计 + 连板梯队
// 池子接口必须显式传 date, 因此从今天(北京时间)起逐日回溯, 最多 15 个自然日以覆盖节假日
export async function fetchMarketSentiment(): Promise<MarketSentiment> {
  let lastError = '未获取到涨跌停数据';

  const beijingDate = (backDays: number) => {
    const d = new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60000);
    d.setDate(d.getDate() - backDays);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  };

  const fetchPoolCount = async (path: string, date: string): Promise<number> => {
    const url = `${EM_EX_BASE}/${path}?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=${date}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${path} 接口错误 (${resp.status})`);
    const json = await resp.json();
    if (json?.rc !== 0 || !json?.data) throw new Error(`${path} 暂无数据`);
    return typeof json.data.tc === 'number' ? json.data.tc : 0;
  };

  for (let back = 0; back < 15; back++) {
    const ymd = beijingDate(back);
    try {
      const url = `${EM_EX_BASE}/getTopicZTPool?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=1000&sort=fbt%3Aasc&date=${ymd}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`涨停池接口错误 (${resp.status})`);
      const json = await resp.json();
      const pool = json?.data?.pool;
      if (json?.rc !== 0 || !Array.isArray(pool)) throw new Error('暂无涨停池数据');

      const [dtRes, zbRes] = await Promise.allSettled([
        fetchPoolCount('getTopicDTPool', ymd),
        fetchPoolCount('getTopicZBPool', ymd),
      ]);

      const ladder: LadderStock[] = pool
        .map((it: any) => ({
          code: String(it.c || ''),
          name: String(it.n || '').trim(),
          lbc: Number(it.lbc) || 1,
          fund: Number(it.fund) || 0,
          industry: String(it.hybk || ''),
        }))
        .filter((s) => s.code)
        .sort((a, b) => b.lbc - a.lbc || b.fund - a.fund);

      return {
        date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`,
        limitUp: typeof json.data.tc === 'number' ? json.data.tc : ladder.length,
        limitDown: dtRes.status === 'fulfilled' ? dtRes.value : 0,
        broken: zbRes.status === 'fulfilled' ? zbRes.value : 0,
        maxBoards: ladder.length > 0 ? ladder[0].lbc : 0,
        ladder: ladder.slice(0, 8),
      };
    } catch (e: any) {
      lastError = e?.message || lastError;
    }
  }
  throw new Error(lastError);
}

// ---------------------------------------------------------------------------
// 格式化工具
// ---------------------------------------------------------------------------

// 元 -> 亿 / 万亿 (e.g. 883423480099 -> "8834.23亿", 1879264405245 -> "1.88万亿")
export function formatYi(value: number, digits = 2): string {
  const yi = value / 1e8;
  if (Math.abs(yi) >= 10000) return `${(yi / 10000).toFixed(digits)}万亿`;
  return `${yi.toFixed(digits)}亿`;
}

export function formatSignedYi(value: number, digits = 2): string {
  return `${value > 0 ? '+' : ''}${formatYi(value, digits)}`;
}

// 手 -> 万手 / 亿手
export function formatVolume(value: number): string {
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(2)}亿手`;
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(0)}万手`;
  return `${value.toFixed(0)}手`;
}
