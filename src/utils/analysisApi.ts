/**
 * 缠论买卖点后端 API 客户端.
 *
 * 默认打相对路径 /api (vite dev 已代理到 server); 生产/预览环境可用
 * VITE_ANALYSIS_API_URL 指向独立 Node 服务 (默认 tsx server/index.ts, :8899)。
 * 服务端不可用时回退到本地计算 (analyzeChanlunWithFallback 内置回退)。
 */
import type { Kline, BSPoint, Fraction, Hub, MergedKline, Segment, Stroke } from '../types/stock';
import { runChanlunPipeline } from './chanlun';

const API_BASE: string = ((import.meta.env?.VITE_ANALYSIS_API_URL as string | undefined) ?? '').replace(/\/$/, '');

async function post<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      if (data?.error) msg = data.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return (await resp.json()) as T;
}

interface ChanlunAnalysis {
  mergedKlines: MergedKline[];
  fractions: Fraction[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
  bsPoints: BSPoint[];
}

/** 后端完整缠论流水线; 失败抛异常 */
function analyzeChanlun(klines: Kline[]): Promise<ChanlunAnalysis> {
  return post<ChanlunAnalysis>('/api/chanlun/analyze', { klines });
}

/** 优先后端, 不可用时本地计算 */
export async function analyzeChanlunWithFallback(klines: Kline[]): Promise<ChanlunAnalysis> {
  try {
    return await analyzeChanlun(klines);
  } catch {
    return runChanlunPipeline(klines);
  }
}
