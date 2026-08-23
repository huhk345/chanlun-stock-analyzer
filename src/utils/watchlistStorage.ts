// ---------------------------------------------------------------------------
// 自选股 (Watchlist) 存储层
// 从「缠论买卖点扫描」加入的信号股, 记录加入理由与加入日基准价,
// 供市场总览页跟踪自加入以来的涨跌。持久化于浏览器 localStorage。
// ---------------------------------------------------------------------------

import { BSPointType } from '../types/stock';

export interface WatchItem {
  symbolKey: string;    // '000001.SZ'
  code: string;         // '000001'
  name: string;         // 中文名称, 扫描时可能缺失
  signalType: BSPointType;
  signalLabel: string;  // '一买' 等
  signalDate: string;   // 信号日期 YYYY-MM-DD
  signalPrice: number;  // 信号价
  basePrice: number;    // 加入当日收盘价 (跟踪基准)
  baseDate: string;     // 加入当日数据日期 YYYY-MM-DD
  reason: string;       // 加入理由
  addedAt: number;      // 加入时间戳 (ms)
}

const WATCHLIST_KEY = 'chanlun_watchlist';

function isValidItem(v: unknown): v is WatchItem {
  const it = v as WatchItem;
  return (
    !!it &&
    typeof it.symbolKey === 'string' &&
    typeof it.code === 'string' &&
    typeof it.basePrice === 'number' &&
    typeof it.baseDate === 'string' &&
    typeof it.addedAt === 'number'
  );
}

export function loadWatchlist(): WatchItem[] {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.filter(isValidItem).sort((a: WatchItem, b: WatchItem) => b.addedAt - a.addedAt);
      }
    }
  } catch { /* ignore */ }
  return [];
}

export function saveWatchlist(items: WatchItem[]) {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(items));
  } catch { /* ignore */ }
}

/** 加入/覆盖同一标的 (以最新一次操作为准), 返回新数组 (按加入时间倒序) */
export function upsertWatchlist(items: WatchItem[], item: WatchItem): WatchItem[] {
  const next = items.filter(it => it.symbolKey !== item.symbolKey);
  next.push(item);
  next.sort((a, b) => b.addedAt - a.addedAt);
  saveWatchlist(next);
  return next;
}

export function removeFromWatchlist(items: WatchItem[], symbolKey: string): WatchItem[] {
  const next = items.filter(it => it.symbolKey !== symbolKey);
  saveWatchlist(next);
  return next;
}

/** '000001.SZ' -> 'sz000001' (腾讯行情代码) */
export function toTencentSymbol(symbolKey: string): string {
  const [code, ex] = symbolKey.split('.');
  return `${(ex || 'SZ').toLowerCase()}${code}`;
}
