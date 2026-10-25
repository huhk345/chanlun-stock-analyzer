/**
 * 「逐日信号」磁盘缓存 + 增量续算。
 *
 * 组合模拟的瓶颈不在撮合, 而在信号生成: runBacktest 对每根 K 线都要重算一次
 * 截至当根的缠论结构 (O(n²)), 800 只 × 900 根的量级下这是整条链路里最慢的一步。
 * 但同一份 K 线 + 同一策略 + 同一组参数得到的信号是完全确定的, 因此可以落盘复用:
 *
 *   完全命中   → 直接读 JSON, 秒级完成;
 *   前缀命中   → 复用旧区间逐日信号与末态 (账户/持仓/成交), 只续算新增的 K 线;
 *   未命中     → 照常跑 runBacktest, 跑完立即写盘 (中途取消也不会丢掉已算好的标的)。
 *
 * 缓存按「策略观点配置」分目录:
 *   symbol / 复权方式 / 策略 id + 策略代码指纹 / 策略参数 / 选中指标
 * 目录内每个条目记录自己的 K 线前缀指纹与末端状态, 因此次日拉长区间时
 * (K 线只是追加) 可以命中旧条目并只算增量。组合层参数 (初始资金、最大持仓、
 * 仓位比例、止损、轮动、基准、费用) 一律不进键 —— 这些只影响 backtrader 撮合,
 * 改它们时信号缓存照常命中。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { BacktestAccountState, BacktestPositionState, UserStrategyDefinition } from '../src/types/strategy.ts';
import type { BacktestTrade, Kline } from '../src/types/stock.ts';

/** 缓存格式版本: 信号结构或指纹口径变化时 +1, 旧缓存自动失效 */
export const SIGNAL_CACHE_VERSION = 2;
/** 缓存保留天数 */
const CACHE_TTL_DAYS = 30;
/** 缓存文件数量上限 (超出后按 mtime 删最旧的) */
const MAX_CACHE_FILES = 8_000;
/** 单个「策略观点配置」下保留的条目数 (按 mtime 保留最近的): 日常续算只用最新一条, 留几条方便切换区间 */
const MAX_ENTRIES_PER_CONFIG = 4;
/** 清理间隔 (进程内) */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export interface CachedSignalRecord {
  date: string;
  action: 'BUY' | 'SELL';
  reason?: string;
  confidence?: number;
  price: number;
}

export interface CachedScoreRecord {
  date: string;
  score: number;
}

/** 区间末端的引擎状态: 续算时据此恢复账户/持仓/成交, 避免从头重跑 */
export interface CachedFinalState {
  account: BacktestAccountState;
  position: BacktestPositionState;
  trades: BacktestTrade[];
}

export interface SignalCacheEntry {
  version: number;
  /** 策略观点配置指纹 (不含区间/K 线), 同一配置的条目放在同一目录 */
  configKey: string;
  symbol: string;
  createdAt: string;
  /** 该条目覆盖的 K 线根数 (指纹即前 bars 根的指纹) */
  bars: number;
  firstDate: string;
  lastDate: string;
  barsFingerprint: string;
  signals: CachedSignalRecord[];
  scores: CachedScoreRecord[];
  /** 缺失时只能整段命中, 不能作为续算起点 */
  finalState?: CachedFinalState;
}

export interface SignalCacheConfigInput {
  symbol: string;
  adjust?: string;
  strategyId: string;
  /** 策略代码指纹 (decide 函数源码哈希), 策略改动后自动失效 */
  strategyFingerprint: string;
  params?: Record<string, unknown>;
  selectedIndicatorIds?: readonly string[];
}

export interface SignalCacheLookupInput extends SignalCacheConfigInput {
  /** 本次要生成的完整 K 线; 会与缓存条目的前缀做逐根指纹比对 */
  bars: readonly Kline[];
}

// ---------------------------------------------------------------------------
// 指纹 / 缓存键
// ---------------------------------------------------------------------------

/**
 * K 线内容指纹: 只哈希「策略真正会看」的字段。
 * 前复权价格会随除权变化, 因此价格进了指纹 —— 除权后旧缓存自然失效。
 * 末尾追加长度, 保证 600 根与 601 根的指纹不会相同, 同时让「前 N 根」的
 * 指纹与该 N 根独立计算的结果一致 (增量命中依赖这一点)。
 */
export function barsFingerprint(bars: readonly Kline[]): string {
  const hash = crypto.createHash('sha1');
  hash.update(`${bars.length}`);
  for (const bar of bars) {
    hash.update(`|${bar.date},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`);
  }
  return hash.digest('hex').slice(0, 20);
}

/**
 * 策略代码指纹: decide 源码 + id, 策略逻辑一改缓存自动失效。
 * 注意: decide 引用的模块级常量不在指纹内, 改动这类常量或引擎信号口径时
 * 必须手动 bump SIGNAL_CACHE_VERSION。
 */
export function strategyFingerprint(strategy: UserStrategyDefinition): string {
  let source = '';
  try {
    source = String(strategy.decide ?? '');
  } catch {
    source = '';
  }
  return crypto
    .createHash('sha1')
    .update(`${strategy.id}\n${source}`)
    .digest('hex')
    .slice(0, 16);
}

/** 参数对象稳定序列化 (键排序), 避免对象字面量顺序影响缓存键 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** 策略观点配置指纹: 决定「信号是否相同」的全部输入, 不含日期区间与 K 线 */
export function signalCacheConfigKey(input: SignalCacheConfigInput): string {
  const payload = [
    `v${SIGNAL_CACHE_VERSION}`,
    input.symbol,
    input.adjust ?? 'forward',
    input.strategyId,
    input.strategyFingerprint,
    stableStringify(input.params ?? {}),
    [...(input.selectedIndicatorIds ?? [])].sort().join('|'),
  ].join('\n');
  return crypto.createHash('sha1').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

const cacheRoot = (): string => {
  const base = process.env.KLINE_CACHE_DIR
    ? path.resolve(process.env.KLINE_CACHE_DIR)
    : path.resolve(import.meta.dirname, '..', '.cache');
  return path.join(base, 'simulation-signals');
};

const configDirOf = (configKey: string): string =>
  path.join(cacheRoot(), configKey.slice(0, 2), configKey);

const entryFileOf = (entry: SignalCacheEntry): string =>
  path.join(
    configDirOf(entry.configKey),
    `${entry.lastDate}_${entry.bars}_${entry.barsFingerprint.slice(0, 12)}.json`,
  );

function touch(file: string): void {
  const now = new Date();
  try {
    fs.utimesSync(file, now, now);
  } catch {
    /* 只读文件系统等情况忽略 */
  }
}

/** 读单个缓存文件; 版本 / 配置 / 结构不符一律当作无效 */
function readEntry(file: string, configKey: string): SignalCacheEntry | null {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf-8')) as SignalCacheEntry;
    if (!entry || entry.version !== SIGNAL_CACHE_VERSION) return null;
    if (entry.configKey !== configKey) return null;
    if (!Array.isArray(entry.signals) || !Array.isArray(entry.scores)) return null;
    if (typeof entry.bars !== 'number' || typeof entry.barsFingerprint !== 'string') return null;
    return entry;
  } catch {
    return null;
  }
}

/**
 * 查找可复用的缓存条目。
 * 命中条件: 同一策略观点配置 + 缓存覆盖的 K 线是本次 K 线的前缀 (逐根指纹一致)。
 * 返回覆盖最长前缀的条目; 若小于本次根数, 调用方据 finalState 只续算尾部。
 */
export function findSignalCache(input: SignalCacheLookupInput): SignalCacheEntry | null {
  const configKey = signalCacheConfigKey(input);
  const dir = configDirOf(configKey);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return null;
  }

  let best: { entry: SignalCacheEntry; file: string } | null = null;
  for (const name of names) {
    const file = path.join(dir, name);
    const entry = readEntry(file, configKey);
    if (!entry) continue;
    if (entry.bars < 1 || entry.bars > input.bars.length) continue;
    // 续算需要从末态恢复; 没有末态的旧条目只能整段复用
    if (entry.bars < input.bars.length && !entry.finalState) continue;
    if (barsFingerprint(input.bars.slice(0, entry.bars)) !== entry.barsFingerprint) continue;
    if (!best || entry.bars > best.entry.bars) best = { entry, file };
  }

  if (!best) return null;
  touch(best.file);
  return best.entry;
}

/** 写缓存 (先写临时文件再 rename, 避免进程被杀时留下半截 JSON) */
export function writeSignalCache(entry: SignalCacheEntry): void {
  const file = entryFileOf(entry);
  const dir = path.dirname(file);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file);
    pruneConfigDir(entry.configKey);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    console.warn('[signal-cache] 写入失败 (不影响本次模拟):', err instanceof Error ? err.message : err);
  }
}

/** 同一配置下只保留最近写入的若干条目 (历史区间已被新条目覆盖, 续算也不再需要) */
function pruneConfigDir(configKey: string): void {
  const dir = configDirOf(configKey);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  if (names.length <= MAX_ENTRIES_PER_CONFIG) return;
  const files = names
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return { file, mtime: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((f): f is { file: string; mtime: number } => f !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const f of files.slice(MAX_ENTRIES_PER_CONFIG)) {
    try {
      fs.rmSync(f.file, { force: true });
    } catch {
      /* ignore */
    }
  }
}

let lastPruneAt = 0;

/**
 * 清理过期 / 超量缓存。任务开始时调用一次, 内部有 10 分钟节流;
 * 全程 try/catch, 任何失败都不影响模拟本身。
 */
export function pruneSignalCache(force = false): void {
  const now = Date.now();
  if (!force && now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;

  const root = cacheRoot();
  const files: { file: string; mtime: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        try {
          files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  if (files.length === 0) return;

  const ttl = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const expired = files.filter((f) => now - f.mtime > ttl);
  for (const f of expired) {
    try {
      fs.rmSync(f.file, { force: true });
    } catch {
      /* ignore */
    }
  }

  const alive = files.filter((f) => now - f.mtime <= ttl).sort((a, b) => a.mtime - b.mtime);
  const overflow = alive.length - MAX_CACHE_FILES;
  for (let i = 0; i < overflow; i++) {
    try {
      fs.rmSync(alive[i].file, { force: true });
    } catch {
      /* ignore */
    }
  }
}
