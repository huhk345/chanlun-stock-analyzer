/**
 * 默认市场基准数据 (组合模拟的内置上下文)。
 *
 * 数据源 (均无需 Key):
 *   - 中证指数官网: 沪深300全收益 H00300 / 沪深300 000300 / 中证500 000905 /
 *     中证1000 000852 / 中证全债 H11001, 同时返回 PE (peg);
 *   - 东方财富国债收益率: 10Y / 2Y / 10Y-2Y 期限利差 (RPTA_WEB_TREASURYYIELD)。
 *
 * 派生指标:
 *   - 沪深300 PE (来自 000300 的 peg);
 *   - 股权风险溢价 ERP = 100 / PE - 10Y 国债收益率;
 *   - 10Y-2Y 利差 (东财直接返回, 缺失时用 10Y - 2Y 计算)。
 *
 * 落盘缓存: .cache/market/<seriesId>.json, TTL 2 小时; 拉取失败时回退到旧缓存,
 * 保证离线/接口抖动时组合模拟仍能跑完 (仅缺少基准数据)。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  PortfolioBenchmarkId,
  PortfolioMarketIndicator,
} from '../src/types/portfolioSimulation.ts';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = process.env.KLINE_CACHE_DIR
  ? path.resolve(process.env.KLINE_CACHE_DIR)
  : path.join(ROOT_DIR, '.cache');
const MARKET_DIR = path.join(CACHE_DIR, 'market');

const SERIES_TTL_MS = 2 * 60 * 60 * 1000;
const BUNDLE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

export interface MarketPoint {
  date: string;
  value: number;
}

export interface MarketSeriesInfo {
  id: string;
  name: string;
  unit: string;
  source: string;
  kind: 'index' | 'yield' | 'valuation' | 'derived';
  description?: string;
}

export interface MarketBaselineBundle {
  updatedAt: number;
  series: Record<string, MarketPoint[]>;
  infos: MarketSeriesInfo[];
  warnings: string[];
}

export type { PortfolioBenchmarkId };

export const BENCHMARKS: Record<PortfolioBenchmarkId, { id: PortfolioBenchmarkId; name: string; seriesId?: string }> = {
  hs300_tr: { id: 'hs300_tr', name: '沪深300全收益', seriesId: 'hs300_tr' },
  hs300: { id: 'hs300', name: '沪深300', seriesId: 'hs300' },
  equal_weight: { id: 'equal_weight', name: '池内等权买入持有' },
};

export const DEFAULT_BENCHMARK: PortfolioBenchmarkId = 'hs300_tr';

export function isPortfolioBenchmarkId(v: unknown): v is PortfolioBenchmarkId {
  return v === 'hs300_tr' || v === 'hs300' || v === 'equal_weight';
}

/** 中证指数代码 → 需要落盘的序列 (close 与 PE 分开存) */
const CSINDEX_SOURCES: { code: string; closeId?: string; peId?: string; name: string }[] = [
  { code: 'H00300', closeId: 'hs300_tr', name: '沪深300全收益' },
  { code: '000300', closeId: 'hs300', peId: 'hs300_pe', name: '沪深300' },
  { code: '000905', closeId: 'zz500', name: '中证500' },
  { code: '000852', closeId: 'zz1000', name: '中证1000' },
  { code: 'H11001', closeId: 'csi_allbond', name: '中证全债' },
];

const SERIES_INFO: Record<string, MarketSeriesInfo> = {
  hs300_tr: {
    id: 'hs300_tr',
    name: '沪深300全收益 (H00300)',
    unit: '点',
    source: '中证指数',
    kind: 'index',
    description: '含股息再投资的沪深300，默认基准',
  },
  hs300: { id: 'hs300', name: '沪深300 (000300)', unit: '点', source: '中证指数', kind: 'index' },
  hs300_pe: {
    id: 'hs300_pe',
    name: '沪深300 PE',
    unit: '倍',
    source: '中证指数',
    kind: 'valuation',
    description: '中证口径滚动市盈率',
  },
  csi_allbond: { id: 'csi_allbond', name: '中证全债 (H11001)', unit: '点', source: '中证指数', kind: 'index' },
  zz500: { id: 'zz500', name: '中证500 (000905)', unit: '点', source: '中证指数', kind: 'index' },
  zz1000: { id: 'zz1000', name: '中证1000 (000852)', unit: '点', source: '中证指数', kind: 'index' },
  cn10y: {
    id: 'cn10y',
    name: '10 年期国债收益率',
    unit: '%',
    source: '东方财富',
    kind: 'yield',
  },
  cn2y: { id: 'cn2y', name: '2 年期国债收益率', unit: '%', source: '东方财富', kind: 'yield' },
  cn10y2y: {
    id: 'cn10y2y',
    name: '10Y-2Y 期限利差',
    unit: '%',
    source: '东方财富',
    kind: 'derived',
    description: '长端减短端，倒挂时为负',
  },
  erp: {
    id: 'erp',
    name: '股权风险溢价 (ERP)',
    unit: '%',
    source: '派生',
    kind: 'derived',
    description: '沪深300盈利收益率 (100/PE) 减 10Y 国债收益率',
  },
};

/** 市场环境面板的固定展示顺序 */
const CONTEXT_ORDER = [
  'hs300_tr',
  'hs300',
  'hs300_pe',
  'csi_allbond',
  'cn10y',
  'cn2y',
  'cn10y2y',
  'erp',
  'zz500',
  'zz1000',
];

interface SeriesCache {
  updatedAt: number;
  points: MarketPoint[];
}

function cachePath(id: string): string {
  return path.join(MARKET_DIR, `${id}.json`);
}

function readCache(id: string): SeriesCache | null {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(id), 'utf-8')) as SeriesCache;
    if (!raw || !Array.isArray(raw.points)) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(id: string, points: MarketPoint[]): void {
  if (points.length === 0) return;
  fs.mkdirSync(MARKET_DIR, { recursive: true });
  fs.writeFileSync(cachePath(id), JSON.stringify({ updatedAt: Date.now(), points }));
}

function isFresh(cache: SeriesCache | null): boolean {
  return !!cache && Date.now() - cache.updatedAt < SERIES_TTL_MS && cache.points.length > 0;
}

function compactDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function isoDate(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

async function fetchJson(url: string, referer: string): Promise<any> {
  const resp = await fetch(url, {
    headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

async function fetchCsindex(code: string): Promise<{ closes: MarketPoint[]; pe: MarketPoint[] }> {
  const url =
    'https://www.csindex.com.cn/csindex-home/perf/index-perf' +
    `?indexCode=${code}&startDate=20041231&endDate=${compactDate()}`;
  const data = await fetchJson(url, 'https://www.csindex.com.cn/');
  const rows: any[] = data?.data ?? [];

  const byDate = new Map<string, { close: number; pe: number | null }>();
  for (const r of rows) {
    const compact = String(r?.tradeDate ?? '');
    if (compact.length !== 8) continue;
    const close = Number(r?.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    const pe = Number(r?.peg);
    byDate.set(isoDate(compact), { close, pe: Number.isFinite(pe) && pe > 0 ? pe : null });
  }

  const dates = [...byDate.keys()].sort();
  const closes: MarketPoint[] = [];
  const pe: MarketPoint[] = [];
  for (const date of dates) {
    const row = byDate.get(date)!;
    closes.push({ date, value: row.close });
    if (row.pe !== null) pe.push({ date, value: row.pe });
  }
  return { closes, pe };
}

/** 东财国债收益率: 只取 2023 年以后的页面 (按日期倒序翻页) */
async function fetchYields(): Promise<{
  y10: MarketPoint[];
  y2: MarketPoint[];
  spread: MarketPoint[];
}> {
  const y10: MarketPoint[] = [];
  const y2: MarketPoint[] = [];
  const spread: MarketPoint[] = [];
  const stopBefore = '2022-12-31';

  for (let page = 1; page <= 12; page++) {
    const url =
      'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD' +
      `&columns=ALL&pageSize=500&pageNumber=${page}&sortColumns=SOLAR_DATE&sortTypes=-1`;
    const data = await fetchJson(url, 'https://data.eastmoney.com/');
    const rows: any[] = data?.result?.data ?? [];
    if (rows.length === 0) break;
    let oldest = '';
    for (const r of rows) {
      const raw = String(r?.SOLAR_DATE ?? '').slice(0, 10);
      if (!raw) continue;
      oldest = raw;
      const v10 = Number(r?.EMM00166466);
      const v2 = Number(r?.EMM00588704);
      const sp = Number(r?.EMM01276014);
      if (Number.isFinite(v10) && v10 > 0) y10.push({ date: raw, value: v10 });
      if (Number.isFinite(v2) && v2 > 0) y2.push({ date: raw, value: v2 });
      if (Number.isFinite(sp)) spread.push({ date: raw, value: sp });
      else if (Number.isFinite(v10) && Number.isFinite(v2) && v2 > 0)
        spread.push({ date: raw, value: v10 - v2 });
    }
    if (oldest && oldest < stopBefore) break;
    const pages = Number(data?.result?.pages ?? 1);
    if (page >= pages) break;
  }

  const asc = (arr: MarketPoint[]) => arr.sort((a, b) => a.date.localeCompare(b.date));
  return { y10: asc(y10), y2: asc(y2), spread: asc(spread) };
}

/** ERP = 100 / PE - 10Y; 10Y 按日期前向填充 (利率发布日与指数日不完全一致) */
function buildErp(pe: MarketPoint[], y10: MarketPoint[]): MarketPoint[] {
  if (pe.length === 0 || y10.length === 0) return [];
  const out: MarketPoint[] = [];
  let j = 0;
  let rate: number | null = null;
  for (const p of pe) {
    while (j < y10.length && y10[j].date <= p.date) {
      rate = y10[j].value;
      j++;
    }
    if (rate === null) continue;
    out.push({ date: p.date, value: 100 / p.value - rate });
  }
  return out;
}

async function refreshBundle(force: boolean): Promise<MarketBaselineBundle> {
  fs.mkdirSync(MARKET_DIR, { recursive: true });
  const warnings: string[] = [];

  const upsert = (id: string, points: MarketPoint[]) => {
    if (points.length > 0) writeCache(id, points);
  };

  for (const src of CSINDEX_SOURCES) {
    const closeCache = src.closeId ? readCache(src.closeId) : null;
    const peCache = src.peId ? readCache(src.peId) : null;
    const needClose = src.closeId && (force || !isFresh(closeCache));
    const needPe = src.peId && (force || !isFresh(peCache));
    if (!needClose && !needPe) continue;
    try {
      const { closes, pe } = await fetchCsindex(src.code);
      if (src.closeId) upsert(src.closeId, closes);
      if (src.peId) upsert(src.peId, pe);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`中证指数 ${src.code} (${src.name}) 拉取失败: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const y10Cache = readCache('cn10y');
  const y2Cache = readCache('cn2y');
  const spreadCache = readCache('cn10y2y');
  if (force || !isFresh(y10Cache) || !isFresh(y2Cache) || !isFresh(spreadCache)) {
    try {
      const { y10, y2, spread } = await fetchYields();
      upsert('cn10y', y10);
      upsert('cn2y', y2);
      upsert('cn10y2y', spread);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`东方财富国债收益率拉取失败: ${msg}`);
    }
  }

  const series: Record<string, MarketPoint[]> = {};
  for (const id of Object.keys(SERIES_INFO)) {
    const cache = readCache(id);
    if (!cache || cache.points.length === 0) continue;
    if (Date.now() - cache.updatedAt > SERIES_TTL_MS) {
      warnings.push(`${SERIES_INFO[id].name} 使用过期缓存 (${new Date(cache.updatedAt).toISOString().slice(0, 10)})`);
    }
    series[id] = cache.points;
  }

  const erp = buildErp(series.hs300_pe ?? [], series.cn10y ?? []);
  if (erp.length > 0) series.erp = erp;

  return {
    updatedAt: Date.now(),
    series,
    infos: CONTEXT_ORDER.filter((id) => series[id]?.length).map((id) => SERIES_INFO[id]),
    warnings,
  };
}

let bundleCache: MarketBaselineBundle | null = null;
let inflight: Promise<MarketBaselineBundle> | null = null;

/**
 * 读取默认市场基准数据 (带磁盘缓存)。多个任务同时触发时共用一个刷新请求。
 * 拉取失败但有旧缓存时仍返回旧缓存, 只附带 warning。
 */
export async function getMarketBaselines(force = false): Promise<MarketBaselineBundle> {
  if (!force && bundleCache && Date.now() - bundleCache.updatedAt < BUNDLE_TTL_MS) {
    return bundleCache;
  }
  if (inflight) return inflight;
  inflight = refreshBundle(force)
    .then((bundle) => {
      bundleCache = bundle;
      return bundle;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export type PortfolioMarketIndicatorView = PortfolioMarketIndicator;

/** 把序列压缩成前端市场环境面板需要的快照 */
export function buildMarketContext(bundle: MarketBaselineBundle): PortfolioMarketIndicator[] {
  const out: PortfolioMarketIndicator[] = [];
  for (const info of bundle.infos) {
    const points = bundle.series[info.id] ?? [];
    if (points.length === 0) continue;
    const last = points[points.length - 1];
    const prev = points.length > 1 ? points[points.length - 2] : null;
    const back20 = points.length > 20 ? points[points.length - 21] : null;
    // 指数看涨跌幅 (%); 利率/估值/派生指标看绝对变化 (百分点 / 倍数), 否则会被基数放大
    const isIndex = info.kind === 'index';
    const delta = (a: number, b: number | null) => {
      if (b === null) return null;
      if (!isIndex) return a - b;
      return b > 0 ? ((a - b) / b) * 100 : null;
    };
    out.push({
      id: info.id,
      name: info.name,
      unit: info.unit,
      source: info.source,
      kind: info.kind,
      lastDate: last.date,
      lastValue: last.value,
      change1d: delta(last.value, prev ? prev.value : null),
      change20d: delta(last.value, back20 ? back20.value : null),
      spark: points.slice(-120),
    });
  }
  return out;
}
