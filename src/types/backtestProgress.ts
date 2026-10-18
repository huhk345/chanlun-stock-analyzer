/**
 * 单标的回测实时进度 —— 前后端共享契约。
 *
 * 单标的回测是一次同步 HTTP 请求 (POST /api/backtest/run), 请求期间可能
 * 长时间停留在「拉取 K 线」阶段 (上游限速/回退重试), 前端因此带上
 * progressId 轮询进度接口, 让用户能看到当前进行到哪一步:
 *
 *   POST /api/backtest/run                     请求体附带 progressId
 *   GET  /api/backtest/progress/:progressId    轮询阶段进度 (本文件的数据形状)
 *
 * 服务端按阶段写入内存进度 (server/backtestProgress.ts), 任务结束/失败后
 * 短暂保留供最后一次轮询读取, 过期自动清理。
 */

/** 单标的回测阶段 */
export type BacktestPhase =
  /** 请求已受理, 尚未进入拉取 (前端本地占位) */
  | 'queued'
  /** 从行情源拉取 K 线 (网络, 通常最慢) */
  | 'fetching'
  /** 运行策略回测引擎 */
  | 'computing'
  /** 回测完成, 正在组装响应 */
  | 'done'
  /** 失败 */
  | 'error';

export interface BacktestProgressView {
  phase: BacktestPhase;
  /** 当前阶段的描述, 直接展示给用户 */
  message: string;
  /** 本次回测开始时间 (ms) */
  startedAt: number;
  /** 服务端最后一次更新时间 (ms) */
  updatedAt: number;
  /** 已拉取到的 K 线根数 (拉取完成后可知) */
  klines?: number;
  /** K 线来源: 本地缓存 / 上游请求 */
  source?: 'cache' | 'network';
  /** phase === 'error' 时的错误信息 */
  error?: string;
}
