// ---------------------------------------------------------------------------
// 市场总览数据层
// 数据来源:
//   - 腾讯行情 (web.sqt.gtimg.cn): 指数实时/收盘行情, 支持 CORS, GBK 编码
//   - 东方财富 (push2delay / push2his): 涨跌家数、大盘资金流向、板块/个股资金排行
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
