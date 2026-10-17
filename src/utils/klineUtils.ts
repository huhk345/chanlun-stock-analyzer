/**
 * K 线通用工具 (浏览器 / Node 服务 / CLI 脚本共用, 不依赖任何运行环境):
 *   - sanitizeKlines        修正 high/low 与 open/close 交叉的脏数据
 *   - mergeKlinesByDate     按日期去重合并 (增量缓存用)
 *   - parseTickflowColumns  TickFlow 列式返回 -> Kline[]
 *   - extractRateLimitDelay 解析 TickFlow 限流提示中的重试等待时长
 *   - 交易日 / 新鲜度判断 (北京时间, 忽略节假日)
 */
import type { Kline } from '../types/stock';

/** K 线周期 (与各数据源接口参数一致) */
export type KlinePeriod = '1d' | '1w';

/** 修正个别数据源 high/low 与 open/close 交叉的脏数据 */
export function sanitizeKlines(klines: Kline[]): Kline[] {
  return klines.map((k) => ({
    ...k,
    high: Math.max(k.open, k.high, k.low, k.close),
    low: Math.min(k.open, k.high, k.low, k.close),
  }));
}

/** 按日期合并: 新数据覆盖同日期旧数据, 返回按日期升序的完整序列 */
export function mergeKlinesByDate(prev: Kline[], next: Kline[]): Kline[] {
  const byDate = new Map<string, Kline>();
  for (const k of prev) byDate.set(k.date, k);
  for (const k of next) byDate.set(k.date, k);
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** TickFlow 列式 K 线返回 */
export interface TickflowColumns {
  timestamp: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume?: number[];
  amount?: number[];
}

/**
 * TickFlow 列式返回 -> Kline[]。
 * 时间戳按北京时间 (UTC+8) 归一化为 YYYY-MM-DD, 价格保留两位小数。
 */
export function parseTickflowColumns(data: TickflowColumns): Kline[] {
  const length = data.timestamp?.length || 0;
  const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const klines: Kline[] = [];
  for (let i = 0; i < length; i++) {
    const date = new Date(data.timestamp[i] + CHINA_OFFSET_MS);
    const dateStr = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    klines.push({
      date: dateStr,
      open: parseFloat(Number(data.open[i]).toFixed(2)),
      high: parseFloat(Number(data.high[i]).toFixed(2)),
      low: parseFloat(Number(data.low[i]).toFixed(2)),
      close: parseFloat(Number(data.close[i]).toFixed(2)),
      volume: data.volume?.[i] || 0,
      amount: data.amount?.[i] || 0,
    });
  }
  return klines;
}

/** 解析限流提示里的重试等待时长 (ms), 如 "请 1500ms 后重试" */
export function extractRateLimitDelay(text: string): number | null {
  const msMatch = text.match(/请\s*(\d+)\s*ms\s*后重试/);
  if (msMatch) return parseInt(msMatch[1], 10);
  const secMatch = text.match(/请\s*(\d+(?:\.\d+)?)\s*秒?\s*后重试/);
  if (secMatch) return Math.ceil(parseFloat(secMatch[1]) * 1000);
  return null;
}

// ---------------------------------------------------------------------------
// 交易日 / 新鲜度
// ---------------------------------------------------------------------------

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 86400000;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

/**
 * 预期最新交易日 (北京时间 YYYY-MM-DD, 忽略节假日):
 * 16:00 前当日日 K 尚未生成, 回退到上一工作日; 周末再回退到周五。
 */
export function expectedTradeDay(): string {
  const d = new Date(Date.now() + CHINA_OFFSET_MS);
  if (d.getUTCHours() < 16) d.setUTCDate(d.getUTCDate() - 1);
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 末根日期是否已覆盖预期最新交易日 (周线放宽到 7 天) */
export function isFresh(lastDate: string | undefined, period: KlinePeriod): boolean {
  if (!lastDate) return false;
  const expected = expectedTradeDay();
  if (period === '1w') return daysBetween(lastDate, expected) <= 7;
  return lastDate >= expected;
}
