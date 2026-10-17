/**
 * 腾讯行情 K 线 (免费接口) 服务端数据层。
 *
 * 缠论买卖点扫描原先走 TickFlow 免费接口, 上游硬顶 60 次/分钟,
 * 沪深300 + 中证500 约 800 只标的要跑十几分钟。腾讯 fqkline 系列接口
 * 免 Key, 配合多域名轮换 + 限速, 整轮扫描几十秒即可完成。
 *
 * 接口选择 (实测):
 *   - newfqkline: 10 列, 第 9 列是真实成交额 (单位 万元), 首选;
 *   - fqkline   : 6 列, 无成交额, 退而用 收盘价×量×100 估算。
 * 两者行格式前 6 列一致 [日期, 开, 收, 高, 低, 量], 量单位是"手"(1 手=100 股),
 * 与 TickFlow 一致 (实测逐根相同)。
 *
 * 三个必须注意的点 (均为实测踩坑):
 *   1. 域名。`web.ifzq.gtimg.cn` 在服务端 (无浏览器 Referer/TLS 指纹) 直接被
 *      WAF 拦成 501; `ifzq.gtimg.cn` 与 `proxy.finance.qq.com` 可用。
 *   2. 腾讯有未公开的 WAF 限流, 只是额度远高于 60/分钟: 持续 ~25 次/秒
 *      打满几千次后会把单个域名封禁 (实测 501 持续超过 2 分钟)。
 *      故本模块内置域名轮换 + 全局令牌桶, 501 时把该域名放入冷却并换下一个。
 *   3. 停牌/退市的低价壳股 (如 000408 前复权价已跌到 0.01 元量级) 上,
 *      TickFlow 的 "成交额=收盘价×量×100" 估算会出现十万倍量级的错误,
 *      而腾讯给的是真实成交额 —— 这类标的上腾讯明显更准。
 *
 * 与 TickFlow 的整体一致性 (1487 只标的 × 400 根, 实测):
 *   - 缠论买卖点 (类型+日期) 全历史匹配率 99.5%
 *   - 成交量逐根一致; OHLC 在 90 天信号窗口内偏差 <1%
 *   - 差异集中在两家前复权锚点不同的早期 bar 上 (等比缩放, 不影响结构判定)
 * 因此本地缓存 (.cache/klines/) 可直接复用, 无需清空重建。
 */
import type { Kline } from '../src/types/stock.ts';
import { sleep } from '../src/utils/async.ts';
import { mergeKlinesByDate, sanitizeKlines, type KlinePeriod } from '../src/utils/klineUtils.ts';
import { toTencentSymbol } from '../src/utils/symbols.ts';

interface TencentHost {
  base: string;
  /** newfqkline 带真实成交额, fqkline 没有 */
  rich: boolean;
}

/** 同一份数据的多个接入域名, 任一被 WAF 封禁时轮换到下一个 */
const TX_HOSTS: TencentHost[] = [
  { base: 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get', rich: true },
  { base: 'https://ifzq.gtimg.cn/appstock/app/newfqkline/get', rich: true },
  { base: 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get', rich: false },
  { base: 'https://ifzq.gtimg.cn/appstock/app/fqkline/get', rich: false },
];

/** 单次请求最多返回的根数; 超出则按日期区间向前翻页 */
const TX_MAX_BARS = 800;
/** 单次请求超时 (ms) */
const REQUEST_TIMEOUT_MS = 15_000;
/** 单只标的最多重试次数 */
const MAX_RETRIES = 3;
/** 域名被 WAF 封禁后的冷却时长 (ms) */
const HOST_COOLDOWN_MS = 120_000;

/**
 * 全局限速 (次/秒)。腾讯无公开额度, 实测持续 ~25 次/秒以上会触发 WAF,
 * 这里保守取 15 次/秒: 800 只标的约 1 分钟, 仍是 TickFlow 的十几倍。
 * 可用 TENCENT_RPS 环境变量覆盖。
 */
const RPS = Math.max(1, parseFloat(process.env.TENCENT_RPS || '') || 15);

/** A 股成交量单位是"手", 1 手 = 100 股 */
const SHARES_PER_LOT = 100;
/** newfqkline 的成交额单位是"万元" */
const AMOUNT_UNIT = 10_000;

// ---------------------------------------------------------------------------
// 域名轮换 / 全局限速
// ---------------------------------------------------------------------------

const cooldownUntil = TX_HOSTS.map(() => 0);
/** 轮询游标, 保证失败均匀分摊到各域名 */
let hostCursor = 0;

/** 取下一个未在冷却期的域名; 全部在冷却则返回最早上恢复的那个 */
function pickHost(): { host: TencentHost; index: number } {
  const now = Date.now();
  for (let n = 0; n < TX_HOSTS.length; n++) {
    const i = (hostCursor + n) % TX_HOSTS.length;
    if (cooldownUntil[i] <= now) {
      hostCursor = (i + 1) % TX_HOSTS.length;
      return { host: TX_HOSTS[i], index: i };
    }
  }
  const i = cooldownUntil.indexOf(Math.min(...cooldownUntil));
  return { host: TX_HOSTS[i], index: i };
}

/** 令牌桶: 全局共享, 平滑限速到 RPS */
let tokens = RPS;
let lastRefill = Date.now();
async function acquireToken(): Promise<void> {
  while (true) {
    const now = Date.now();
    tokens = Math.min(RPS, tokens + ((now - lastRefill) / 1000) * RPS);
    lastRefill = now;
    if (tokens >= 1) {
      tokens -= 1;
      return;
    }
    await sleep(Math.ceil(((1 - tokens) / RPS) * 1000));
  }
}

// ---------------------------------------------------------------------------
// 参数转换
// ---------------------------------------------------------------------------

/** 复权口径 -> 腾讯 param 末位后缀 (forward/qfq = 前复权) */
function adjustSuffix(adjust: string): string {
  const a = (adjust || 'forward').toLowerCase();
  if (a === 'backward' || a === 'hfq') return 'hfq';
  if (a === 'none' || a === 'none-adjust' || a === '') return '';
  return 'qfq';
}

/** 周期 -> 腾讯粒度参数 */
function granularityOf(period: KlinePeriod): string {
  return period === '1w' ? 'week' : 'day';
}

/**
 * 解析 K 线行。
 * 通用前 6 列: [日期, 开, 收, 高, 低, 量(手)]
 * newfqkline 第 9 列为真实成交额 (万元), 优先采用; 缺失时用收盘价估算。
 */
function parseRows(rows: unknown): Kline[] {
  if (!Array.isArray(rows)) return [];
  const out: Kline[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const date = String(row[0]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const open = parseFloat(String(row[1])) || 0;
    const close = parseFloat(String(row[2])) || 0;
    const high = parseFloat(String(row[3])) || 0;
    const low = parseFloat(String(row[4])) || 0;
    const volume = parseFloat(String(row[5])) || 0;
    if (close <= 0) continue;
    const realAmount = parseFloat(String(row[8]));
    out.push({
      date,
      open,
      close,
      high,
      low,
      volume,
      amount: realAmount > 0 ? realAmount * AMOUNT_UNIT : close * volume * SHARES_PER_LOT,
    });
  }
  return sanitizeKlines(out);
}

/** 不可重试的错误: 请求本身有问题 (代码非法 / 上游确实无数据), 重试只是浪费时间 */
class FatalTencentError extends Error {}

/** 从响应体里取出该 symbol 的 K 线行 */
function extractRows(json: any, txSymbol: string, granularity: string): unknown[] {
  const node = json?.data?.[txSymbol];
  if (!node) return [];
  // 前复权/后复权时 key 为 qfqday / qfqweek; 不复权时为 day / week
  return node[`qfq${granularity}`] || node[`hfq${granularity}`] || node[granularity] || [];
}

/** 组装 URL */
function buildUrl(
  base: string,
  txSymbol: string,
  granularity: string,
  adjust: string,
  range: { count: number; start?: string; end?: string },
): string {
  const param = `${txSymbol},${granularity},${range.start ?? ''},${range.end ?? ''},${Math.min(range.count, TX_MAX_BARS)},${adjustSuffix(adjust)}`;
  return `${base}?param=${encodeURIComponent(param)}`;
}

/**
 * 发一次请求并解析。
 * 遇到 WAF (501) 时把该域名放入冷却, 换下一个域名重试。
 */
async function requestOnce(
  txSymbol: string,
  period: KlinePeriod,
  count: number,
  adjust: string,
  range?: { count: number; start: string; end: string },
): Promise<Kline[]> {
  const granularity = granularityOf(period);

  for (let hostTry = 0; hostTry < TX_HOSTS.length + 1; hostTry++) {
    const { host, index } = pickHost();
    await acquireToken();
    const url = buildUrl(host.base, txSymbol, granularity, adjust, range ?? { count });

    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      // 网络抖动 / 超时: 换域名再试 (换域名通常能绕开单点故障)
      if (hostTry < TX_HOSTS.length) continue;
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (resp.status === 501) {
      // WAF 拦截: 该域名进入冷却, 立即换下一个
      cooldownUntil[index] = Date.now() + HOST_COOLDOWN_MS;
      console.warn(`[tencent] 域名被 WAF 拦截, 冷却 ${HOST_COOLDOWN_MS / 1000}s: ${host.base}`);
      continue;
    }
    if (resp.status === 429) {
      if (hostTry < TX_HOSTS.length) continue;
      throw new Error('腾讯K线接口限流 (429)');
    }
    if (!resp.ok) {
      const fatal = resp.status >= 400 && resp.status < 500;
      const err = new FatalTencentError(`腾讯K线接口错误 (${resp.status})`);
      if (fatal) throw err;
      if (hostTry < TX_HOSTS.length) continue;
      throw err;
    }

    let json: any;
    try {
      json = await resp.json();
    } catch (err) {
      if (hostTry < TX_HOSTS.length) continue;
      throw err instanceof Error ? err : new Error(String(err));
    }

    const klines = parseRows(extractRows(json, txSymbol, granularity));
    if (klines.length === 0) throw new FatalTencentError(`腾讯未返回 ${txSymbol} 的${period}K线数据`);
    return klines;
  }
  throw new Error(`腾讯K线接口全部域名不可用 (${txSymbol})`);
}

/** 拉取 K 线, 网络/限流类错误按指数退避重试 */
async function requestKlines(txSymbol: string, period: KlinePeriod, count: number, adjust: string): Promise<Kline[]> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(500 * attempt);
    try {
      return await requestOnce(txSymbol, period, count, adjust);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError instanceof FatalTencentError) break;
    }
  }
  throw lastError ?? new Error(`获取 ${txSymbol} K线失败`);
}

/**
 * 拉取 K 线 (腾讯)。
 *
 * count <= 800 一次请求搞定 (扫描用的 400 根日线/周线即在此范围);
 * 超出则按日期区间向前翻页, 直到凑够 count 根。
 */
export async function fetchTencentKlines(
  symbol: string,
  period: KlinePeriod,
  count: number,
  adjust: string,
): Promise<Kline[]> {
  const txSymbol = toTencentSymbol(symbol);
  let collected = await requestKlines(txSymbol, period, count, adjust);
  if (collected.length >= count) return collected.slice(-count);

  // 长历史 (如 /api/klines?count=5000): 以最早那根为终点继续向前翻页
  while (collected.length < count) {
    const oldest = collected[0].date;
    const need = count - collected.length;
    const end = new Date(Date.parse(oldest) - 86400000).toISOString().slice(0, 10);
    const spanDays = period === '1w' ? need * 8 : Math.ceil(need * 1.6) + 10;
    const start = new Date(Date.parse(end) - spanDays * 86400000).toISOString().slice(0, 10);

    let next: Kline[];
    try {
      next = await requestOnce(txSymbol, period, need, adjust, { count: need, start, end });
    } catch (err) {
      if (err instanceof FatalTencentError) break; // 上游没有更早的数据了
      throw err;
    }
    const merged = mergeKlinesByDate(collected, next);
    if (merged.length === collected.length) break; // 没有新数据, 避免死循环
    collected = merged;
  }
  return collected.slice(-count);
}