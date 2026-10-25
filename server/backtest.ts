/**
 * 策略回测服务端入口: 从腾讯行情拉取 K 线, 运行服务端策略回测, 返回完整明细。
 *
 * 设计目标:
 *   - 用户输入: 标的 + 策略 id + 资金/费率等参数
 *   - 数据源: 腾讯 fqkline (免 Key, 服务端可用), 本地缓存 + 增量更新
 *   - 引擎: server/engine/backtestRunner.runBacktest (沪深 A 股长仓模式; 信号当日收盘价成交
 *     (尾盘模型), 杜绝未来数据; 佣金+印花税+过户费; 涨跌停按收盘价拦截;
 *     固定止损为盘中止损单, T+1 当日买入不可卖)
 *   - 策略: server/strategies (内置) + data/user-strategies (用户自建), 均由服务端编译执行
 *   - 输出: 回测报告 + 逐笔成交 + 权益曲线, 供前端展示或脚本调用
 *
 * 启动后端: pnpm server   (默认 http://localhost:8899)
 * 调用示例:
 *   curl -X POST http://localhost:8899/api/backtest/run \
 *     -H 'Content-Type: application/json' \
 *     -d '{"symbol":"000001.sz","strategyId":"ma-cross","initialCash":100000,"count":500}'
 *
 * 实时进度 (可选): 请求体附带 progressId (8~64 位 [A-Za-z0-9_-]),
 * 请求期间轮询 GET /api/backtest/progress/:progressId 获取阶段进度, 见 runServerBacktest 的 onProgress 参数。
 */

import { runBacktest } from './engine/backtestRunner.ts';
import { resolveIndicatorDefinitions, type IndicatorCodeInput } from './engine/indicatorResolve.ts';
import { getKlines } from './klines.ts';
import type { KlinePeriod } from '../src/utils/klineUtils.ts';
import { loadStrategies } from './strategies/index.ts';
import type {
  UserStrategyDefinition,
  BacktestDiagnostic,
} from '../src/types/strategy.ts';
import type { BacktestResult, Kline } from '../src/types/stock.ts';

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export interface ServerBacktestInput {
  /** 交易代码, 如 000001.sz / 600519.ss */
  symbol: string;
  /** K 线周期: '1d' | '1w', 默认 '1d' */
  period?: KlinePeriod;
  /** 兼容参数: 数据窗口固定为 2023-01-01 至今, 该值不再截断窗口 */
  count?: number;
  /** 复权口径: 'forward' | 'backward' | '', 默认 'forward' */
  adjust?: string;
  /** 强制刷新缓存, 默认 false */
  force?: boolean;
  /** 初始资金 (CNY), 默认 100,000 */
  initialCash?: number;
  /** 结算货币, 默认 'CNY' */
  currency?: string;
  /** 佣金费率, 默认 0.00025 (万分之 2.5) */
  commissionRate?: number;
  /** 最低佣金 per 笔 (CNY), 默认 5 */
  minCommission?: number;
  /** 固定止损百分比, 可选 */
  stopLossPercent?: number;
  /** 策略 ID (从 /api/strategies 获取), 必填 */
  strategyId: string;
  /** 策略参数覆盖 */
  params?: Record<string, unknown>;
  /** 选中的指标 ID */
  selectedIndicatorIds?: readonly string[];
  /**
   * 选中指标的代码 (指标定义保存在浏览器侧, 回测在服务端执行时随请求上传)。
   * 只在 selectedIndicatorIds 非空时需要。
   */
  indicatorCodes?: readonly IndicatorCodeInput[];
  /** 回测区间起始日 (YYYY-MM-DD), 可选 */
  rangeStart?: string;
  /** 回测区间结束日 (YYYY-MM-DD), 可选 */
  rangeEnd?: string;
}

export interface ServerBacktestOutput {
  symbol: string;
  period: KlinePeriod;
  adjust: string;
  /** 实际参与回测的 K 线根数 (过滤区间后) */
  klinesCount: number;
  dateRange: { start: string; end: string };
  result: BacktestResult;
  diagnostics: readonly BacktestDiagnostic[];
  /** 每日收盘权益, 用于绘制权益曲线 */
  equityCurve: number[];
  /** 与 equityCurve 一一对应的日期, 用于前端绘图 */
  equityDates: string[];
  /** 回测实际使用的 K 线 (过滤区间后), 供前端绘制价格图并标注每笔成交 */
  klines: Kline[];
}

/**
 * 阶段进度上报 (可选)。
 * HTTP 层用它把「拉取 K 线 / 运行回测」写进进度注册表供前端轮询;
 * CLI 脚本用它向终端打印进度; 不传则完全静默。
 */
export interface BacktestProgressUpdate {
  phase: 'fetching' | 'computing';
  message: string;
  klines?: number;
  source?: 'cache' | 'network';
}

export type BacktestProgressReporter = (update: BacktestProgressUpdate) => void;

// ---------------------------------------------------------------------------
// 数据准备 (回测 / 单步回测共用)
// ---------------------------------------------------------------------------

export interface BacktestKlineQuery {
  symbol: string;
  period?: KlinePeriod;
  count?: number;
  adjust?: string;
  force?: boolean;
  rangeStart?: string;
  rangeEnd?: string;
}

/**
 * 拉取 K 线并按区间过滤 —— runServerBacktest 与 stepper 会话共用同一口径,
 * 保证「一次性回测」和「逐步回测」看到的 K 线完全一致。
 */
export async function fetchBacktestKlines(
  query: BacktestKlineQuery,
  onProgress?: BacktestProgressReporter,
): Promise<{ klines: Kline[]; cached: boolean }> {
  const { symbol, period = '1d', count = 500, adjust = 'forward', force = false } = query;

  onProgress?.({
    phase: 'fetching',
    message: `正在拉取 ${symbol} 的${period === '1w' ? '周线' : '日线'} (2023-01-01 至今, ${adjust === 'backward' ? '后复权' : adjust === '' ? '不复权' : '前复权'})…`,
  });

  const result = await getKlines(symbol, period, count, adjust, force);
  let klines = result.klines;

  if (query.rangeStart || query.rangeEnd) {
    klines = klines.filter(
      (k) =>
        (!query.rangeStart || k.date >= query.rangeStart) &&
        (!query.rangeEnd || k.date <= query.rangeEnd),
    );
  }

  if (klines.length === 0) {
    throw new Error(`没有可用的 K 线数据 (symbol=${symbol}, period=${period})`);
  }

  return { klines, cached: result.cached };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runServerBacktest(
  input: ServerBacktestInput,
  onProgress?: BacktestProgressReporter,
): Promise<ServerBacktestOutput> {
  const {
    symbol,
    period = '1d',
    adjust = 'forward',
    initialCash = 100_000,
    currency = 'CNY',
    commissionRate = 0.00025,
    minCommission = 5,
    stopLossPercent,
    strategyId,
    params,
    selectedIndicatorIds,
    indicatorCodes,
    rangeStart,
    rangeEnd,
  } = input;

  if (!symbol) throw new Error('symbol is required');
  if (!strategyId) throw new Error('strategyId is required');

  // 1. 从腾讯行情拉取 K 线 (失败自动回退 TickFlow, 见 server/klines.ts)
  const { klines, cached } = await fetchBacktestKlines(input, onProgress);

  // 2. 解析策略 (内置 + 用户自建, 均由服务端编译)
  const strategies = await loadStrategies();
  const strategy = strategies.find((s) => s.id === strategyId);
  if (!strategy) {
    const available = strategies.map((s) => `${s.id} (${s.name})`).join(', ');
    throw new Error(`策略未找到: ${strategyId}. 可用策略: ${available}`);
  }

  // 3. 解析选中指标 (浏览器上传的代码, 服务端沙箱编译)
  const indicators = selectedIndicatorIds?.length
    ? resolveIndicatorDefinitions(indicatorCodes).definitions
    : [];

  // 4. 运行回测
  onProgress?.({
    phase: 'computing',
    message: `K 线就绪 (${klines.length} 根, ${cached ? '本地缓存' : '行情源'}), 正在运行「${strategy.name}」回测…`,
    klines: klines.length,
    source: cached ? 'cache' : 'network',
  });
  const runResult = runBacktest({
    klines,
    symbol,
    userId: 'server',
    initialCash,
    currency,
    stopLossPercent,
    commissionRate,
    minCommission,
    strategy,
    params,
    selectedIndicatorIds,
    indicators,
  });

  const equityCurve = (runResult.equityCurve ?? []) as number[];
  const equityDates = klines.map((k) => k.date);

  return {
    symbol,
    period,
    adjust,
    klinesCount: klines.length,
    dateRange: { start: klines[0].date, end: klines[klines.length - 1].date },
    result: runResult.result,
    diagnostics: runResult.diagnostics,
    equityCurve,
    equityDates,
    klines,
  };
}

export { runBacktest };
export type { UserStrategyDefinition };
