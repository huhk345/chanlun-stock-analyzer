/**
 * Rust 模拟引擎客户端。
 *
 * 走同源 /api/rust (Vite 代理到 8901 端口的 Rust 服务)。
 *   GET  /api/rust/health
 *   GET  /api/rust/strategies
 *   GET  /api/rust/pools
 *   POST /api/rust/sim            录制一整段逐日模拟
 *   GET  /api/rust/sim/:id        取回已录制的模拟
 *   POST /api/rust/sim/:id/step   游标移动 (索引查找, 不重跑)
 */
import type {
  RustKlineBar,
  RustPool,
  RustPoolCoverage,
  RustSimInput,
  RustSimResult,
  RustStrategy,
  RustUpdateProgress,
} from '../types/rustSim';

const BASE = '/api/rust';

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchRustHealth(): Promise<{ ok: boolean; framework: string }> {
  return jsonOrThrow(await fetch(`${BASE}/health`));
}

export async function fetchRustStrategies(): Promise<RustStrategy[]> {
  const data = await jsonOrThrow<{ strategies: RustStrategy[] }>(await fetch(`${BASE}/strategies`));
  return data.strategies;
}

/** 单只标的的日线，供点开个股画 K 线（只读引擎本地缓存） */
export async function fetchRustKline(symbol: string): Promise<RustKlineBar[]> {
  const data = await jsonOrThrow<{ symbol: string; bars: RustKlineBar[] }>(
    await fetch(`${BASE}/kline/${encodeURIComponent(symbol)}`),
  );
  return data.bars;
}

export async function fetchRustPools(): Promise<RustPool[]> {
  const data = await jsonOrThrow<{ pools: RustPool[] }>(await fetch(`${BASE}/pools`));
  return data.pools;
}

export async function runRustSim(input: RustSimInput): Promise<RustSimResult> {
  const res = await fetch(`${BASE}/sim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<RustSimResult>(res);
}

export async function getRustSim(runId: string): Promise<RustSimResult> {
  return jsonOrThrow(await fetch(`${BASE}/sim/${encodeURIComponent(runId)}`));
}

// ---------------------------------------------------------------------------
// Pool data maintenance
// ---------------------------------------------------------------------------

export async function fetchPoolCoverage(pools: string[]): Promise<{
  pools: RustPoolCoverage[];
  indexUpdatedAt: number;
}> {
  const query = pools.join(',');
  return jsonOrThrow(await fetch(`${BASE}/pool/coverage?pools=${encodeURIComponent(query)}`));
}

export async function startPoolUpdate(input: {
  pools: string[];
  custom?: string[];
  mode?: 'incremental' | 'full';
}): Promise<{ jobId: string; total: number; mode: string }> {
  const res = await fetch(`${BASE}/pool/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow(res);
}

export async function getUpdateProgress(jobId: string): Promise<RustUpdateProgress> {
  return jsonOrThrow(await fetch(`${BASE}/pool/update/${encodeURIComponent(jobId)}`));
}
