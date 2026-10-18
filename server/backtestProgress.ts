/**
 * 单标的回测进度注册表 (进程内存)。
 *
 * 单标的回测走同步接口 POST /api/backtest/run, 前端在请求期间额外轮询
 * GET /api/backtest/progress/:id 获取阶段进度。本模块只保存「当前跑到哪一步」,
 * 不保存结果; 任务结束/失败后的条目短暂保留 (供最后一次轮询), TTL 到期清理。
 *
 * 设计取舍:
 *   - 不做任务调度 (与选股池不同): 单标的请求本身很短, 只为补齐「看不见的等待」;
 *   - progressId 由前端生成并校验格式, 非法 id 直接忽略 (不影响回测本身)。
 */

import type { BacktestPhase, BacktestProgressView } from '../src/types/backtestProgress.ts';

/** 完成/失败后条目保留时长 (ms) */
const TTL_MS = 10 * 60 * 1000;
/** 同时最多保留的进度条目数 */
const MAX_ENTRIES = 200;

const entries = new Map<string, BacktestProgressView>();

/** progressId 白名单格式: 8~64 位 [A-Za-z0-9_-] (兼容 UUID / 随机串) */
export function isProgressId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);
}

function prune(): void {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (now - entry.updatedAt > TTL_MS) entries.delete(id);
  }
  if (entries.size > MAX_ENTRIES) {
    const oldest = [...entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let i = 0; i < oldest.length - MAX_ENTRIES; i++) entries.delete(oldest[i][0]);
  }
}

export interface BacktestProgressPatch {
  phase: BacktestPhase;
  message: string;
  klines?: number;
  source?: 'cache' | 'network';
  error?: string;
}

/** 请求受理, 写入初始进度 */
export function beginProgress(id: string): void {
  prune();
  entries.set(id, {
    phase: 'queued',
    message: '请求已受理, 准备拉取 K 线…',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** 更新当前阶段 (幂等覆盖) */
export function updateProgress(id: string, patch: BacktestProgressPatch): void {
  const prev = entries.get(id);
  if (!prev) return; // 条目已被清理: 静默忽略
  entries.set(id, { ...prev, ...patch, updatedAt: Date.now() });
}

/** 读取进度视图; 不存在 (未写入/已过期) 返回 null */
export function getProgress(id: string): BacktestProgressView | null {
  const entry = entries.get(id);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TTL_MS) {
    entries.delete(id);
    return null;
  }
  return { ...entry };
}
