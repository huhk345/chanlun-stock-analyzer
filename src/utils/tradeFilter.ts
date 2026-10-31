/**
 * 散户「可交易范围」过滤。
 *
 * 背景: 创业板 / 科创板 / 北交所都有开户门槛 (资产 + 交易经验), 普通账户没开通就
 * 根本下不了单。扫描列表、回测股票池里混着这些标的, 等于在给人看「买不了的信号」。
 *
 * 两类规则, 性质不同:
 *   - **板块可调**: 创业板 / 科创板 / 北交所有没有开通因人而异, 用 chip 自己选;
 *   - **ST/退市固定剔除**: 不在任何人的可交易清单里, 不提供开关, 界面上也不显示
 *     (用户明确要求: 不需要选, 也不用看到)。
 *
 * 这里只做**视图过滤**, 不改数据:
 *   - 板块判定复用 symbols.ts 的 aShareBoard() (按代码段, 与交易所口径一致);
 *   - ST/退市只能看名字, 名称缺失时一律放行 (宁可见到, 不可误杀)。
 *
 * 状态存在 localStorage 并全局广播: 扫描页与回测页共用同一份设置,
 * 在一处改了另一处立刻跟着变 (跨标签页也同步)。
 */
import {
  EXCLUDABLE_BOARDS,
  aShareBoard,
  isBoardExcluded,
  type ExcludableBoard,
} from './symbols';

export interface TradeFilter {
  /** 被排除的板块 (主板永远保留, 不在此列); ST/退市不受此字段影响, 恒定剔除 */
  boards: ExcludableBoard[];
}

/**
 * 默认值 = 只有主板。
 *
 * 没开通创业板/科创板/北交所是散户的常态, 所以默认就把这三个关掉;
 * 开通了的点一下 chip 就能放开。
 */
export const DEFAULT_TRADE_FILTER: TradeFilter = {
  boards: ['chinext', 'star', 'bse'],
};

/** 各板块的开户门槛, 用于 chip 的 tooltip */
export const BOARD_HINTS: Record<ExcludableBoard, string> = {
  chinext: '需开通创业板权限: 2 年交易经验 + 10 万资产',
  star: '需开通科创板权限: 2 年交易经验 + 50 万资产',
  bse: '需开通北交所权限: 2 年交易经验 + 50 万资产',
};

const STORAGE_KEY = 'chanlun_trade_filter';

// ---------------------------------------------------------------------------
// 全局状态 (localStorage + 订阅)
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();

/** 只接受已知板块 id, 防止旧版本/手改 localStorage 带进脏值 */
function normalize(raw: unknown): TradeFilter {
  const input = (raw ?? {}) as Partial<TradeFilter> & { excludeSt?: unknown };
  const ids = EXCLUDABLE_BOARDS.map((b) => b.id);
  const boards = Array.isArray(input.boards)
    ? ids.filter((id) => (input.boards as string[]).includes(id))
    : [...DEFAULT_TRADE_FILTER.boards];
  // 旧版本存过 excludeSt, 现在恒定剔除 ST, 读进来直接丢掉这个字段
  return { boards };
}

function readStored(): TradeFilter {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { boards: [...DEFAULT_TRADE_FILTER.boards] };
    return normalize(JSON.parse(raw));
  } catch {
    return { boards: [...DEFAULT_TRADE_FILTER.boards] };
  }
}

let current: TradeFilter = readStored();

function emit(): void {
  for (const fn of listeners) fn();
}

/** 当前设置 (useSyncExternalStore 的 getSnapshot: 引用在 set 之前保持不变) */
export function getTradeFilter(): TradeFilter {
  return current;
}

export function setTradeFilter(next: TradeFilter): void {
  const normalized = normalize(next);
  const same =
    normalized.boards.length === current.boards.length &&
    normalized.boards.every((b) => current.boards.includes(b));
  current = normalized;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    /* 隐私模式下写不进去, 本次会话仍然生效 */
  }
  if (!same) emit();
}

export function subscribeTradeFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 别的标签页改了设置: 跟着刷新 (storage 事件只在其他标签页触发)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    current = readStored();
    emit();
  });
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** ST / *ST / SST / 退市整理 —— 只看名字, 名字缺失时返回 false (放行) */
export function isStName(name?: string | null): boolean {
  const n = (name ?? '').trim();
  if (!n) return false;
  if (/^(S?\*?ST)/i.test(n)) return true;
  return n.includes('退');
}

/** 该标的是否被排除; 返回排除原因 (用于角标/提示), 不排除返回 null */
export function exclusionReason(
  symbol: string,
  name: string | null | undefined,
  filter: TradeFilter,
): string | null {
  if (isBoardExcluded(symbol, filter.boards)) {
    const board = aShareBoard(symbol);
    return EXCLUDABLE_BOARDS.find((b) => b.id === board)?.label ?? board;
  }
  if (isStName(name)) return 'ST/退市';
  return null;
}

export function passesTradeFilter(
  symbol: string,
  name: string | null | undefined,
  filter: TradeFilter,
): boolean {
  return exclusionReason(symbol, name, filter) === null;
}

/** 是否有板块被排除 (决定要不要显示「全部」按钮与对应文案) */
export function isTradeFilterActive(filter: TradeFilter): boolean {
  return filter.boards.length > 0;
}

/** 一句话描述被剔除的板块, 空设置返回 '' (ST/退市 恒定剔除, 不进 UI 文案) */
export function describeTradeFilter(filter: TradeFilter): string {
  return filter.boards
    .map((id) => EXCLUDABLE_BOARDS.find((b) => b.id === id)?.label ?? id)
    .join(' + ');
}

/** 只保留主板 (创业板/科创板/北交所都放开; ST 仍然固定剔除) */
export const OPEN_TRADE_FILTER: TradeFilter = { boards: [] };
