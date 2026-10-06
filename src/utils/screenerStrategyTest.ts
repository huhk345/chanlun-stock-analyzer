import type { Kline } from '../types/stock';
import type {
  StrategyParamValue,
  UserStrategyDefinition,
} from '../types/strategy';
import { buildStrategyParams, normalizeDecision, isValidStrategyId } from './strategyAdapter';
import { evaluateScreenerSignal } from './screener';
import { runBacktest } from './backtestRunner';
import { validateStrategyCode } from './strategyLoader';

// ---------------------------------------------------------------------------
// 选股策略测试框架: 纯函数, 无网络/存储依赖
//   1. 合成行情 (上行/下跌/箱体/突破/跌破) 秒级验证, 无需拉取真实K线
//   2. validateScreenerStrategy() 做静态 + 动态干跑检查
//   3. scoreScreenerStrategy() 给出可展示的测试报告 (信号/回测/诊断)
// 供 ScreenerStrategyLab (AI 创建 -> 测试 -> 选股扫描) 调用,
// 也可被 scripts/test-screener.ts 等烟雾测试复用。
// ---------------------------------------------------------------------------

export interface ScreenerTestRegime {
  id: string;
  label: string;
  klines: Kline[];
  /** 期望: 突破/上行 regimes 倾向 BUY, 下跌倾向非 BUY */
  expectBuy?: boolean;
}

function mkKlines(closes: number[], startDay = 1): Kline[] {
  return closes.map((c, i) => ({
    date: `2024-01-${String(startDay + i).padStart(2, '0')}`,
    open: c * 0.995,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: 100000 + i * 100,
    amount: c * 100000,
  }));
}

/** 5 套合成行情, 覆盖选股最关心的趋势/突破/风险场景 */
export function buildScreenerTestRegimes(): ScreenerTestRegime[] {
  const uptrend = mkKlines(Array.from({ length: 60 }, (_, i) => 10 + i * 0.1));
  const downtrend = mkKlines(Array.from({ length: 60 }, (_, i) => 16 - i * 0.1));
  const sideways = mkKlines(Array.from({ length: 60 }, (_, i) => 10 + Math.sin(i * 0.6) * 0.15));
  const breakoutCloses = [
    ...Array.from({ length: 40 }, (_, i) => 10 + Math.sin(i) * 0.1),
    12,
  ];
  const breakdownCloses = [
    ...Array.from({ length: 40 }, (_, i) => 10 + Math.sin(i) * 0.1),
    8,
  ];
  return [
    { id: 'uptrend', label: '稳步上行', klines: uptrend },
    { id: 'breakout', label: '箱体向上突破', klines: mkKlines(breakoutCloses), expectBuy: true },
    { id: 'sideways', label: '箱体震荡', klines: sideways },
    { id: 'downtrend', label: '单边下跌', klines: downtrend },
    { id: 'breakdown', label: '箱体向下跌破', klines: mkKlines(breakdownCloses) },
  ];
}

export interface ScreenerCheckResult {
  id: string;
  label: string;
  pass: boolean;
  detail: string;
}

export interface ScreenerRegimeResult {
  regimeId: string;
  label: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence?: number;
  reason?: string;
  error?: string;
  close: number;
  changePct: number;
  /** 该 regime 上的单股回测摘要 (10万本金全历史) */
  btReturn?: number;
  btSharpe?: number;
  btWinRate?: number;
  btTrades?: number;
}

export interface ScreenerStrategyReport {
  strategyId: string;
  strategyName: string;
  checks: ScreenerCheckResult[];
  regimes: ScreenerRegimeResult[];
  allPass: boolean;
  summary: string;
}

/**
 * 静态 + 动态校验: id 格式 / decide 函数 / 空数据不抛异常 / 非法决策可归一化。
 * 失败时返回中文 detail, 永不抛异常。
 */
export function validateScreenerStrategy(
  strategy: UserStrategyDefinition,
  customParams?: Readonly<Record<string, StrategyParamValue>>,
): ScreenerCheckResult[] {
  const checks: ScreenerCheckResult[] = [];

  // 1. id 格式
  checks.push({
    id: 'id-format',
    label: 'ID 格式',
    pass: isValidStrategyId(strategy.id),
    detail: isValidStrategyId(strategy.id)
      ? `id "${strategy.id}" 合法 (小写 kebab-case)`
      : `id "${strategy.id}" 非法, 需小写 kebab-case (如 my-strategy)`,
  });

  // 2. decide 为函数
  const decideOk = typeof strategy.decide === 'function';
  checks.push({
    id: 'decide-fn',
    label: 'decide 函数',
    pass: decideOk,
    detail: decideOk ? 'decide() 已定义' : '缺少 decide() 函数',
  });
  if (!decideOk) return checks;

  const params = buildStrategyParams(strategy, customParams as Record<string, unknown> | undefined);

  // 3. 空 K 线不抛异常
  try {
    const d = normalizeDecision(
      strategy.decide({
        symbol: 'TEST.SH',
        timeframe: 'daily',
        klines: [],
        currentIndex: -1,
        currentKline: { date: '', open: 0, high: 0, low: 0, close: 0, volume: 0, amount: 0 },
        account: { initialCash: 100000, cash: 100000, equity: 100000, currency: 'CNY' },
        position: { shares: 0, averageCost: 0, marketValue: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0 },
        trades: [],
        params,
        currency: 'CNY',
        initialCash: 100000,
      }),
    );
    checks.push({
      id: 'empty-klines',
      label: '空数据保护',
      pass: d.action === 'HOLD',
      detail: d.action === 'HOLD' ? '空 K 线返回 HOLD' : `空 K 线返回 ${d.action}, 建议返回 HOLD`,
    });
  } catch (err) {
    checks.push({
      id: 'empty-klines',
      label: '空数据保护',
      pass: false,
      detail: `空 K 线抛异常: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 4. 数据不足 (仅 5 根) 不抛异常
  try {
    const tiny = buildScreenerTestRegimes()[0].klines.slice(0, 5);
    const d = normalizeDecision(
      strategy.decide({
        symbol: 'TEST.SH',
        timeframe: 'daily',
        klines: tiny,
        currentIndex: tiny.length - 1,
        currentKline: tiny[tiny.length - 1],
        account: { initialCash: 100000, cash: 100000, equity: 100000, currency: 'CNY' },
        position: { shares: 0, averageCost: 0, marketValue: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0 },
        trades: [],
        params,
        currency: 'CNY',
        initialCash: 100000,
      }),
    );
    checks.push({
      id: 'tiny-data',
      label: '数据不足保护',
      pass: ['BUY', 'SELL', 'HOLD'].includes(d.action),
      detail: `5 根 K 线返回 ${d.action}${d.reason ? `: ${d.reason}` : ''}`,
    });
  } catch (err) {
    checks.push({
      id: 'tiny-data',
      label: '数据不足保护',
      pass: false,
      detail: `5 根 K 线抛异常: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 5. 下跌趋势不应无脑买入 (过度拟合/常买策略拦截)
  try {
    const regimes = buildScreenerTestRegimes();
    const down = regimes.find((r) => r.id === 'downtrend')!;
    const sig = evaluateScreenerSignal(strategy, down.klines, 'TEST.SH', customParams);
    checks.push({
      id: 'downtrend-guard',
      label: '下跌保护',
      pass: sig.action !== 'BUY',
      detail: sig.action !== 'BUY'
        ? `下跌趋势返回 ${sig.action}, 未追高`
        : '下跌趋势仍返回 BUY, 可能过度激进',
    });
  } catch (err) {
    checks.push({
      id: 'downtrend-guard',
      label: '下跌保护',
      pass: false,
      detail: `评估失败: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return checks;
}

/**
 * 在 5 套合成行情上跑信号 + 单股回测, 生成可展示的测试报告。
 * 永不抛异常; 单 regime 失败降级为 error 字段。
 */
export function scoreScreenerStrategy(
  strategy: UserStrategyDefinition,
  customParams?: Readonly<Record<string, StrategyParamValue>>,
): ScreenerStrategyReport {
  const checks = validateScreenerStrategy(strategy, customParams);
  const regimes = buildScreenerTestRegimes();
  const results: ScreenerRegimeResult[] = regimes.map((r) => {
    try {
      const sig = evaluateScreenerSignal(strategy, r.klines, `TEST.${r.id}`, customParams);
      let bt: ScreenerRegimeResult['btReturn'];
      let sharpe: number | undefined;
      let winRate: number | undefined;
      let trades: number | undefined;
      try {
        const { result } = runBacktest({
          klines: r.klines,
          symbol: `TEST.${r.id}`,
          userId: 'screener-lab',
          initialCash: 100000,
          currency: 'CNY',
          strategy,
          params: customParams as Record<string, unknown> | undefined,
        });
        bt = Math.round(result.totalReturnPercent * 100) / 100;
        sharpe = Math.round(result.sharpeRatio * 100) / 100;
        winRate = Math.round(result.winRate * 10) / 10;
        trades = result.totalTrades;
      } catch { /* 回测失败不阻塞信号展示 */ }
      return {
        regimeId: r.id,
        label: r.label,
        action: sig.action,
        confidence: sig.confidence,
        reason: sig.reason,
        close: sig.close,
        changePct: Math.round(sig.changePct * 100) / 100,
        btReturn: bt,
        btSharpe: sharpe,
        btWinRate: winRate,
        btTrades: trades,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        regimeId: r.id,
        label: r.label,
        action: 'HOLD' as const,
        error: msg,
        close: 0,
        changePct: 0,
      };
    }
  });

  const criticalFailed = checks.filter((c) => !c.pass && (c.id === 'decide-fn' || c.id === 'empty-klines'));
  const buyCount = results.filter((r) => r.action === 'BUY').length;
  const allPass = criticalFailed.length === 0 && !results.some((r) => r.error);
  const summary = allPass
    ? `${strategy.name} 在 ${results.length} 套合成行情中触发 ${buyCount} 次买入, 未发现崩溃, 可进入实盘抽测/全量扫描。`
    : `${strategy.name} 存在 ${criticalFailed.length + results.filter((r) => r.error).length} 项关键问题, 请先修复再扫描。`;

  return { strategyId: strategy.id, strategyName: strategy.name, checks, regimes: results, allPass, summary };
}

/** 校验用户粘贴/AI 生成的代码字符串, 返回可直接展示的错误列表 (中文)。 */
export function validateScreenerCode(code: string): { valid: boolean; errors: string[] } {
  return validateStrategyCode(code);
}

/** 选股实验室默认抽测样本 (沪深代表性个股, 覆盖大/中/小盘与创业板)。 */
export const SCREENER_LAB_SAMPLES: readonly string[] = [
  '600519.SH', // 贵州茅台 (大盘价值)
  '000001.SZ', // 平安银行 (金融)
  '300750.SZ', // 宁德时代 (创业板成长)
  '600900.SH', // 长江电力 (防御)
  '002594.SZ', // 比亚迪 (制造)
  '601318.SH', // 中国平安 (保险)
  '000733.SZ', // 振华科技 (中小盘)
  '688981.SH', // 中芯国际 (科创)
] as const;
