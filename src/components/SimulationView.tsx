/**
 * 策略模拟回测视图 (Simulation View)
 *
 * 两种模式:
 *   1. 单标的   — 一只票跑一遍策略, 输出绩效概览 / 权益曲线 / 逐笔账本
 *   2. 选股池   — 沪深300 / 中证500 / 全部 股票池内每只标的独立回测,
 *                等权汇总为组合报告 + 逐标的排行榜, 支持点击行下钻明细
 *
 * 数据与计算全部在服务端 (server/backtest.ts / server/poolBacktest.ts):
 *   - 单标的: POST /api/backtest/run
 *   - 选股池: POST /api/backtest/pool 发起任务, 前端轮询进度, 完成后取组合报告
 * 引擎: server/engine/backtestRunner.runBacktest (策略与回测引擎都在服务端) (沪深 A 股长仓; 信号当日收盘价成交 (尾盘模型); 佣金+印花税+过户费; 涨跌停按收盘价拦截; 固定止损为盘中止损单)
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  Play, Download, RefreshCw, LineChart as LineChartIcon, Target, Layers,
  X, Search, Loader2, Square, Percent, Wallet, ShieldAlert, Activity,
  Coins, ListOrdered, AlertTriangle, Info, ChevronUp, ChevronDown, SlidersHorizontal, FlaskConical, Check,
  ChartCandlestick, ClipboardList, FileCode2,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Kline, BacktestTrade } from '../types/stock';
import type { UserStrategyDefinition, BacktestDiagnostic } from '../types/strategy';
import { INDEX_META, type IndexId } from '../types/scan';
import type { BacktestProgressView } from '../types/backtestProgress';
import type {
  PoolBacktestInput,
  PoolBacktestJobView,
  PoolBacktestSummary,
  PoolSymbolDetailView,
  PoolSymbolResult,
  PoolTradeLogView,
} from '../types/poolBacktest';
import StrategySourceDialog from './StrategySourceDialog';
import ChanlunKlineChart from './ChanlunKlineChart';
import {
  EXCLUDABLE_BOARDS,
  isAshareSymbol,
  isBoardExcluded,
  resolveSymbol,
  type ExcludableBoard,
} from '../utils/symbols';
import { csvCell, downloadCsv } from '../utils/download';

interface SimulationViewProps {
  symbol?: string;
  klines?: Kline[];
}

type Mode = 'single' | 'pool';

const POOL_JOB_KEY = 'chanlun_pool_backtest_job';
const LEADER_PAGE_SIZE = 100;
/** 全池成交明细每次渲染的条数 (「显示更多」追加一批) */
const TRADE_LOG_PAGE_SIZE = 400;

const POOL_OPTIONS: { id: IndexId; label: string; count: number }[] = [
  { id: 'hs300', label: '沪深300', count: 300 },
  { id: 'zz500', label: '中证500', count: 500 },
];

const ADJUST_LABEL: Record<string, string> = { forward: '前复权', backward: '后复权', '': '不复权' };

/** 默认回测区间: 最近 3 年 (今天往前推 3 年 ~ 今天) */
const rangeForLastThreeYears = (): { rangeStart: string; rangeEnd: string } => {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 3);
  const toInput = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { rangeStart: toInput(start), rangeEnd: toInput(end) };
};

const DEFAULT_RANGE = rangeForLastThreeYears();

interface SingleState {
  symbol: string;
  initialCash: number;
  commissionRateWan: number;
  minCommission: number;
  stopLossPercent: string;
  rangeStart: string;
  rangeEnd: string;
  forceRefresh: boolean;
}

interface PoolState {
  indexes: Record<IndexId, boolean>;
  custom: string[];
  /** 排除板块: 创业板 / 科创板 / 北交所 */
  excludeBoards: ExcludableBoard[];
  initialCash: number;
  commissionRateWan: number;
  minCommission: number;
  stopLossPercent: string;
  rangeStart: string;
  rangeEnd: string;
  forceRefresh: boolean;
}

const DEFAULT_SINGLE: Omit<SingleState, 'symbol'> = {
  initialCash: 100_000,
  commissionRateWan: 2.5,
  minCommission: 5,
  stopLossPercent: '',
  ...DEFAULT_RANGE,
  forceRefresh: false,
};

const DEFAULT_POOL: Omit<PoolState, 'custom'> = {
  indexes: { hs300: true, zz500: true },
  // 默认排除创业板 / 科创板 / 北交所 (小投资者无交易权限)
  excludeBoards: EXCLUDABLE_BOARDS.map((b) => b.id),
  initialCash: 100_000,
  commissionRateWan: 2.5,
  minCommission: 5,
  stopLossPercent: '',
  ...DEFAULT_RANGE,
  forceRefresh: false,
};

// ---------------------------------------------------------------------------
// 展示工具
// ---------------------------------------------------------------------------

const fmt = (n: number, digits = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '--';

const pct = (n: number) => (Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '--');
const money = (n: number) => `¥${fmt(n)}`;
const upDown = (n: number) => (n > 0 ? 'text-red-400' : n < 0 ? 'text-green-400' : 'text-zinc-300');
const toneOf = (n: number): Tone => (n > 0 ? 'up' : n < 0 ? 'down' : 'default');

/** 权益轴刻度: 十万级保留 2 位小数, 百万级起用整数万, 亿级用亿 */
const fmtAxis = (v: number) => {
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(abs >= 1e6 ? 0 : 2)}万`;
  return v.toFixed(0);
};

/** 秒数 -> "45s" / "1m20s" / "1h05m"; 无效/未知返回 "--" */
const fmtDuration = (sec: number | null | undefined): string => {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '--';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

/** 生成单标的回测 progressId (服务端白名单: 8~64 位 [A-Za-z0-9_-]) */
const newProgressId = (): string => {
  try {
    return crypto.randomUUID().replace(/-/g, '');
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
};

const inputCls =
  'w-full rounded-xl border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-100 font-mono placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition disabled:opacity-50';
const labelCls = 'mb-1.5 block text-[11px] font-semibold text-zinc-400';
const chipCls = (active: boolean) =>
  `flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-semibold transition cursor-pointer select-none ${
    active
      ? 'border-blue-500/50 bg-blue-500/15 text-blue-300'
      : 'border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700'
  }`;

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

type Tone = 'default' | 'up' | 'down' | 'accent' | 'warn';

const TONE_CLS: Record<Tone, string> = {
  default: 'text-zinc-100',
  up: 'text-red-400',
  down: 'text-green-400',
  accent: 'text-blue-400',
  warn: 'text-amber-400',
};

function Kpi({
  label,
  value,
  sub,
  tone = 'default',
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  icon?: React.ReactNode;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-3 md:p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10px] font-mono uppercase tracking-wider text-zinc-500">{label}</span>
        {icon}
      </div>
      <p className={`mt-1.5 truncate text-base md:text-lg font-extrabold font-mono ${TONE_CLS[tone]}`} title={value}>
        {value}
      </p>
      {sub && <p className="mt-0.5 truncate text-[10px] text-zinc-500">{sub}</p>}
    </div>
  );
}

function EquityTooltip({
  active,
  payload,
  label,
  initial,
}: {
  active?: boolean;
  payload?: { value?: number }[];
  label?: string;
  initial: number;
}) {
  if (!active || !payload?.length) return null;
  const value = Number(payload[0]?.value ?? 0);
  const change = initial > 0 ? ((value - initial) / initial) * 100 : 0;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-2 shadow-xl">
      <p className="text-[10px] font-mono text-zinc-500">{label}</p>
      <p className="text-sm font-bold font-mono text-zinc-100">{money(value)}</p>
      <p className={`text-[10px] font-mono ${upDown(change)}`}>{pct(change)} vs 起始</p>
    </div>
  );
}

function EquityChart({
  dates,
  values,
  initialBalance,
  gradientId,
  heightClass = 'h-64 md:h-72',
  tone = 'blue',
}: {
  dates: string[];
  values: number[];
  initialBalance: number;
  gradientId: string;
  heightClass?: string;
  tone?: 'blue' | 'cyan';
}) {
  const data = useMemo(() => dates.map((d, i) => ({ date: d, equity: values[i] ?? initialBalance })), [dates, values, initialBalance]);
  if (data.length === 0) {
    return (
      <div className={`flex items-center justify-center ${heightClass} text-xs text-zinc-600`}>
        暂无权益数据
      </div>
    );
  }
  const stroke = tone === 'cyan' ? '#22d3ee' : '#3b82f6';
  return (
    <div className={`w-full ${heightClass}`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: '#71717a' }}
            minTickGap={64}
            axisLine={{ stroke: '#3f3f46' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: '#71717a' }}
            width={56}
            tickFormatter={(v: number) => fmtAxis(v)}
            axisLine={false}
            tickLine={false}
            domain={['auto', 'auto']}
          />
          <Tooltip content={<EquityTooltip initial={initialBalance} />} />
          <ReferenceLine y={initialBalance} stroke="#52525b" strokeDasharray="4 4" />
          <Area type="monotone" dataKey="equity" stroke={stroke} strokeWidth={1.8} fill={`url(#${gradientId})`} dot={false} activeDot={{ r: 3 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * 价格 K 线 + 缠论分析 + 买卖成交标注 (单标的报告 / 池下钻共用)。
 * 实现在 ChanlunKlineChart: 笔/线段/中枢/分型/三类买卖点均可在图上开关。
 */

function TradesTable({ trades }: { trades: BacktestTrade[] }) {
  if (!trades || trades.length === 0) {
    return <p className="py-6 text-center text-xs text-zinc-500">未触发任何交易。</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-xs text-zinc-300">
        <thead className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 text-zinc-500 font-mono font-semibold backdrop-blur">
          <tr>
            <th className="px-3 py-2.5">日期</th>
            <th className="px-3 py-2.5">方向</th>
            <th className="px-3 py-2.5 text-right">价格</th>
            <th className="px-3 py-2.5 text-right">股数</th>
            <th className="px-3 py-2.5 text-right">金额</th>
            <th className="px-3 py-2.5 text-right">费用</th>
            <th className="px-3 py-2.5 text-right">盈亏</th>
            <th className="px-3 py-2.5 font-sans">信号依据</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-900 font-mono">
          {trades.map((t, i) => (
            <tr key={`${t.id ?? t.date}-${t.type}-${i}`} className="hover:bg-zinc-900/40">
              <td className="px-3 py-2 whitespace-nowrap font-sans text-zinc-400">{t.date}</td>
              <td className="px-3 py-2">
                <span
                  className={`rounded px-2 py-0.5 text-[10px] font-extrabold ${
                    t.type === 'BUY'
                      ? 'border border-red-900/20 bg-red-950/30 text-red-400'
                      : 'border border-green-900/20 bg-green-950/30 text-green-400'
                  }`}
                >
                  {t.type === 'BUY' ? '买入' : '卖出'}
                </span>
              </td>
              <td className="px-3 py-2 text-right font-bold">¥{fmt(t.price)}</td>
              <td className="px-3 py-2 text-right text-zinc-400">{t.shares}</td>
              <td className="px-3 py-2 text-right">¥{fmt(t.value)}</td>
              <td className="px-3 py-2 text-right text-zinc-500">¥{fmt(t.fee ?? 0)}</td>
              <td
                className={`px-3 py-2 text-right font-extrabold ${
                  t.pnl !== undefined ? upDown(t.pnl) : 'font-normal text-zinc-600'
                }`}
              >
                {t.pnl !== undefined
                  ? `${t.pnl >= 0 ? '+' : ''}¥${fmt(t.pnl)} (${fmt(t.pnlPercent ?? 0)}%)`
                  : '--'}
              </td>
              <td
                className="max-w-[260px] truncate px-3 py-2 font-sans text-zinc-400"
                title={t.reason ?? t.signalType}
              >
                {t.reason ?? t.signalType}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: BacktestDiagnostic[] }) {
  if (!diagnostics || diagnostics.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-900/30 bg-amber-950/20 p-3 md:p-4">
      <h5 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5" />
        诊断信息
      </h5>
      <div className="max-h-48 space-y-1 overflow-auto text-xs">
        {diagnostics.map((d, i) => (
          <div key={i} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-amber-500">•</span>
            <span className="text-amber-300/90">
              {d.date ? <span className="font-mono text-amber-500/80">{d.date} </span> : null}
              {d.message}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 单标的回测进度卡: 阶段清单 (拉取 K 线 → 策略回测 → 生成报告) + 实时消息与耗时。
 * progress 为 null 时展示本地占位的「等待服务端受理」。
 */
function SingleRunProgress({
  progress,
  now,
  title,
}: {
  progress: BacktestProgressView | null;
  now: number;
  title?: string;
}) {
  const phase = progress?.phase ?? 'queued';
  const stepIndex = phase === 'done' ? 2 : phase === 'computing' ? 1 : 0;
  // 阶段粒度的进度: 拉取 K 线 (24%) → 运行回测 (72%) → 完成 (100%)
  const barPct = phase === 'done' ? 100 : phase === 'computing' ? 72 : phase === 'queued' ? 8 : 24;
  const elapsedSec = progress ? (now - progress.startedAt) / 1000 : null;
  const steps = ['拉取 K 线', '策略回测', '生成报告'];

  return (
    <section className="rounded-2xl border border-blue-500/25 bg-blue-500/[0.05] p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-blue-300">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在运行模拟回测…
        </div>
        {title && <span className="truncate font-mono text-[11px] text-zinc-500">{title}</span>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {steps.map((label, i) => {
          const state = i < stepIndex ? 'done' : i === stepIndex ? 'active' : 'pending';
          return (
            <span
              key={label}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold ${
                state === 'done'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : state === 'active'
                    ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                    : 'border-zinc-800 bg-zinc-900/60 text-zinc-600'
              }`}
            >
              {state === 'done' ? (
                <Check className="h-3 w-3" />
              ) : state === 'active' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-zinc-700" />
              )}
              {label}
            </span>
          );
        })}
      </div>

      <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-[width] duration-700"
          style={{ width: `${barPct}%` }}
        />
        {phase !== 'done' && (
          <div className="progress-slide pointer-events-none absolute inset-y-0 w-1/4 bg-gradient-to-r from-transparent via-white/25 to-transparent" />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-zinc-500">
        <span className="text-zinc-400">{progress?.message ?? '请求已发送, 等待服务端受理…'}</span>
        <span className="flex flex-wrap gap-x-3">
          {progress?.klines !== undefined && (
            <span>
              {progress.klines} 根 · {progress.source === 'cache' ? '本地缓存' : '行情源'}
            </span>
          )}
          <span>已用 {fmtDuration(elapsedSec)}</span>
        </span>
      </div>
    </section>
  );
}

/** 单标的绩效卡组 (单标的模式与池下钻共用) */
function SymbolKpiGrid({ detail }: { detail: PoolSymbolDetailView }) {
  const r = detail.result;
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
      <Kpi label="起始资金" value={money(r.initialBalance)} icon={<Wallet className="h-3.5 w-3.5 text-zinc-600" />} />
      <Kpi label="期末权益" value={money(r.finalBalance)} />
      <Kpi label="总收益" value={pct(r.totalReturnPercent)} tone={toneOf(r.totalReturnPercent)} />
      <Kpi label="买入持有" value={pct(r.buyHoldReturnPercent)} tone={toneOf(r.buyHoldReturnPercent)} />
      <Kpi label="最大回撤" value={`${fmt(r.maxDrawdownPercent ?? 0)}%`} />
      <Kpi
        label="夏普比率"
        value={fmt(r.sharpeRatio)}
        tone={r.sharpeRatio >= 1 ? 'accent' : 'default'}
      />
      <Kpi label="胜率" value={`${fmt(r.winRate)}%`} sub={`${r.totalTrades} 笔交易`} />
      <Kpi label="总费用" value={money(r.totalFees)} tone="warn" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export default function SimulationView({ symbol: initialSymbol, klines }: SimulationViewProps) {
  const [mode, setMode] = useState<Mode>(() => {
    try {
      if (new URLSearchParams(window.location.search).get('mode') === 'pool') return 'pool';
    } catch {
      /* ignore */
    }
    return 'single';
  });

  // ---- 策略 ----
  const [strategies, setStrategies] = useState<UserStrategyDefinition[]>([]);
  const [strategyId, setStrategyId] = useState('');
  const [paramsJson, setParamsJson] = useState('{}');
  const [strategyLoadError, setStrategyLoadError] = useState('');
  /** 策略列表是否已完成一次加载 (区分「加载中」与「加载完但为空」) */
  const [strategiesLoaded, setStrategiesLoaded] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  /** 策略参数卡片: 参数多时默认折叠, 让配置区更紧凑 */
  const [paramsExpanded, setParamsExpanded] = useState(true);

  const selectedStrategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) ?? null,
    [strategies, strategyId],
  );

  useEffect(() => {
    setParamsExpanded((selectedStrategy?.params?.length ?? 0) <= 8);
  }, [selectedStrategy?.id]);

  const loadStrategies = useCallback(async () => {
    try {
      const r = await fetch('/api/strategies');
      const data = await r.json();
      const list: UserStrategyDefinition[] = data?.strategies ?? [];
      setStrategies(list);
      setStrategyId((prev) => (prev && list.some((s) => s.id === prev) ? prev : list[0]?.id ?? ''));
      setStrategyLoadError('');
    } catch (err) {
      setStrategyLoadError(err instanceof Error ? err.message : '策略列表加载失败');
    } finally {
      setStrategiesLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadStrategies();
  }, [loadStrategies]);

  // ---- 单标的模式 ----
  const [single, setSingle] = useState<SingleState>(() => ({
    symbol: initialSymbol ? resolveSymbol(initialSymbol).resolved : '',
    ...DEFAULT_SINGLE,
  }));
  const [singleResult, setSingleResult] = useState<PoolSymbolDetailView | null>(null);
  const [singleLoading, setSingleLoading] = useState(false);
  /** 单标的回测的实时进度 (请求进行中轮询服务端, 见 server/backtestProgress.ts) */
  const [singleProgress, setSingleProgress] = useState<BacktestProgressView | null>(null);
  const [progressId, setProgressId] = useState<string | null>(null);

  useEffect(() => {
    if (initialSymbol && single.symbol === '') {
      setSingle((prev) => ({ ...prev, symbol: resolveSymbol(initialSymbol).resolved }));
    }
  }, [initialSymbol, single.symbol]);

  // 用当前分析标的的 K 线初始化区间 (近 3 年)
  useEffect(() => {
    if (!klines || klines.length === 0) return;
    const end = klines[klines.length - 1].date;
    const endD = new Date(end);
    const startD = new Date(endD);
    startD.setFullYear(startD.getFullYear() - 3);
    const startStr = startD.toISOString().split('T')[0];
    const first = klines.find((k) => k.date >= startStr);
    setSingle((prev) => ({
      ...prev,
      rangeStart: prev.rangeStart || (first ? first.date : klines[0].date),
      rangeEnd: prev.rangeEnd || end,
    }));
  }, [klines]);

  // ---- 选股池模式 ----
  const [pool, setPool] = useState<PoolState>(() => ({ ...DEFAULT_POOL, custom: [] }));
  /** 指数成分股名单 (仅用于排除板块后的股票池计数预览) */
  const [members, setMembers] = useState<Partial<Record<IndexId, string[]>>>({});
  const [customInput, setCustomInput] = useState('');
  const [jobId, setJobId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(POOL_JOB_KEY);
    } catch {
      return null;
    }
  });
  const [job, setJob] = useState<PoolBacktestJobView | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [detailSymbol, setDetailSymbol] = useState<string | null>(null);
  const [detail, setDetail] = useState<PoolSymbolDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailCache = useRef(new Map<string, PoolSymbolDetailView>());
  const [leaderQuery, setLeaderQuery] = useState('');
  const [sortKey, setSortKey] = useState<keyof PoolSymbolResult | 'code'>('returnPercent');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [showAllRows, setShowAllRows] = useState(false);
  /** 收益筛选: 全部 / 盈利 / 亏损 (默认全部; 用于在「收益降序」首页之外直观看到亏损标的) */
  const [leaderReturnFilter, setLeaderReturnFilter] = useState<'all' | 'profit' | 'loss'>('all');
  /** 默认隐藏未产生任何交易的标的 (收益恒为 0%, 会稀释统计并造成「全是 0%」的误读) */
  const [hideUntraded, setHideUntraded] = useState(true);
  const [poolTableTab, setPoolTableTab] = useState<'leader' | 'trades'>('leader');
  /** 全池逐笔成交明细 (按日期升序): 惰性加载, 切换任务时清空 */
  const [tradeLog, setTradeLog] = useState<PoolTradeLogView | null>(null);
  const [tradeLogLoading, setTradeLogLoading] = useState(false);
  const [tradeLogQuery, setTradeLogQuery] = useState('');
  const [tradeLogLimit, setTradeLogLimit] = useState(TRADE_LOG_PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);

  const poolSummary: PoolBacktestSummary | null = job?.state === 'done' ? job.result ?? null : null;

  // 加载指数成分股名单: 「本次回测宇宙」在排除板块后精确实时计数
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const out: Partial<Record<IndexId, string[]>> = {};
      await Promise.all(
        POOL_OPTIONS.map(async (o) => {
          try {
            const r = await fetch(`/${INDEX_META[o.id].file}`);
            if (!r.ok) return;
            const list = (await r.json()) as unknown;
            if (Array.isArray(list)) out[o.id] = list.filter((s): s is string => typeof s === 'string');
          } catch {
            /* 名单加载失败时退回静态只数估算 */
          }
        }),
      );
      if (!cancelled) setMembers(out);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // URL 同步模式 (仅 canonicalize, 不新增历史记录)
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (mode === 'pool') url.searchParams.set('mode', 'pool');
      else url.searchParams.delete('mode');
      if (url.toString() !== window.location.href) window.history.replaceState({}, '', url.toString());
    } catch {
      /* ignore */
    }
  }, [mode]);

  // 任务 ID 持久化: 长时间池回测切换页面后再回来也能继续看进度
  useEffect(() => {
    try {
      if (jobId) localStorage.setItem(POOL_JOB_KEY, jobId);
      else localStorage.removeItem(POOL_JOB_KEY);
    } catch {
      /* ignore */
    }
  }, [jobId]);

  // 轮询池回测任务
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      try {
        const r = await fetch(`/api/backtest/pool/${jobId}`);
        if (r.status === 404) {
          if (!stopped) {
            setJob(null);
            setJobId(null);
          }
          return;
        }
        if (!r.ok) throw new Error(`状态查询失败 (${r.status})`);
        const view: PoolBacktestJobView = await r.json();
        if (stopped) return;
        setJob(view);
        if (view.state !== 'running' && timer) clearInterval(timer);
      } catch (err) {
        if (stopped) return;
        if (timer) clearInterval(timer);
        setPoolError(err instanceof Error ? err.message : '池回测状态查询失败');
      }
    };

    void tick();
    timer = setInterval(() => void tick(), 1000);
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [jobId]);

  // 切换回测任务时清空成交明细缓存与视图状态 (避免展示上一个任务的成交)
  useEffect(() => {
    setTradeLog(null);
    setTradeLogQuery('');
    setTradeLogLimit(TRADE_LOG_PAGE_SIZE);
    setPoolTableTab('leader');
  }, [jobId]);

  // 单标的回测进度: 请求进行中轮询服务端阶段进度 (拉取 K 线 → 回测计算)。
  // 404 = 服务端尚未写入或条目已过期, 保持本地占位进度即可。
  useEffect(() => {
    if (!progressId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/backtest/progress/${progressId}`);
        if (!r.ok) return;
        const view: BacktestProgressView = await r.json();
        if (!stopped) setSingleProgress(view);
      } catch {
        /* 轮询失败不打断回测本身 */
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 700);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [progressId]);

  // 运行中的每秒心跳: 进度卡片的「已用 / 剩余」时间每秒刷新 (不依赖轮询节奏)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const running = singleLoading || poolLoading || job?.state === 'running';
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [singleLoading, poolLoading, job?.state]);

  // 池回测完成/中断时清空下钻面板 (结果已过期)
  useEffect(() => {
    setDetailSymbol(null);
    setDetail(null);
    setShowAllRows(false);
    detailCache.current.clear();
  }, [job?.id]);

  // ---- 参数 ----
  const paramValues = useMemo<Record<string, unknown> | null>(() => {
    try {
      const v = JSON.parse(paramsJson || '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }, [paramsJson]);

  const setParamValue = useCallback(
    (key: string, value: string | number | boolean) => {
      setParamsJson((prev) => {
        try {
          const obj = JSON.parse(prev || '{}') as Record<string, unknown>;
          obj[key] = value;
          return JSON.stringify(obj);
        } catch {
          return JSON.stringify({ [key]: value });
        }
      });
    },
    [],
  );

  const commissionRateOf = (wan: number) => wan / 10_000;

  // ---- 单标的回测 ----
  const handleRunSingle = useCallback(async () => {
    setError(null);
    setSingleResult(null);
    setSingleLoading(true);
    // 实时进度: 请求体携带 progressId, 请求期间轮询服务端的阶段进度
    const pid = newProgressId();
    setProgressId(pid);
    setSingleProgress({
      phase: 'queued',
      message: '请求已发送, 等待服务端受理…',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    try {
      if (paramValues === null) throw new Error('策略参数 JSON 格式无效, 请检查');
      const body: Record<string, unknown> = {
        symbol: resolveSymbol(single.symbol.trim()).resolved,
        strategyId,
        period: '1d',
        adjust: 'forward',
        initialCash: single.initialCash,
        commissionRate: commissionRateOf(single.commissionRateWan),
        minCommission: single.minCommission,
        params: paramValues,
        force: single.forceRefresh,
        progressId: pid,
      };
      if (single.rangeStart) body.rangeStart = single.rangeStart;
      if (single.rangeEnd) body.rangeEnd = single.rangeEnd;
      if (single.stopLossPercent) body.stopLossPercent = parseFloat(single.stopLossPercent);

      const resp = await fetch('/api/backtest/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err?.error || `请求失败 (${resp.status})`);
      }
      setSingleResult(await resp.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : '回测失败，请检查参数与网络');
    } finally {
      setSingleLoading(false);
      setProgressId(null);
      setSingleProgress(null);
    }
  }, [single, strategyId, paramValues]);

  // ---- 选股池回测 ----
  const poolUniverseCount =
    POOL_OPTIONS.reduce((sum, o) => sum + (pool.indexes[o.id] ? o.count : 0), 0) + pool.custom.length;

  /** 排除板块后的股票池预览: 优先用真实成分股名单精确计数 */
  const poolPreview = useMemo(() => {
    const exclude = pool.excludeBoards;
    let base = 0;
    let kept = 0;
    for (const o of POOL_OPTIONS) {
      if (!pool.indexes[o.id]) continue;
      const list = members[o.id];
      if (list && list.length > 0) {
        base += list.length;
        kept += exclude.length > 0 ? list.filter((s) => !isBoardExcluded(s, exclude)).length : list.length;
      } else {
        base += o.count;
        kept += o.count;
      }
    }
    const customKept =
      exclude.length > 0 ? pool.custom.filter((s) => !isBoardExcluded(s, exclude)).length : pool.custom.length;
    const exact = POOL_OPTIONS.some((o) => pool.indexes[o.id] && (members[o.id]?.length ?? 0) > 0);
    return {
      total: base + pool.custom.length,
      kept: kept + customKept,
      excluded: base + pool.custom.length - (kept + customKept),
      exact,
    };
  }, [pool.indexes, pool.custom, pool.excludeBoards, members]);

  const poolEffectiveCount = pool.excludeBoards.length > 0 ? poolPreview.kept : poolUniverseCount;
  const poolRunning = job?.state === 'running' || poolLoading;

  const toggleBoard = (id: ExcludableBoard) =>
    setPool((prev) => ({
      ...prev,
      excludeBoards: prev.excludeBoards.includes(id)
        ? prev.excludeBoards.filter((b) => b !== id)
        : [...prev.excludeBoards, id],
    }));

  const handleAddCustom = useCallback(() => {
    const tokens = customInput.split(/[\s,;，；、]+/).filter(Boolean);
    if (tokens.length === 0) return;
    const next = new Set(pool.custom);
    const invalid: string[] = [];
    for (const token of tokens) {
      const { resolved, isChinaStock } = resolveSymbol(token);
      if (isChinaStock && isAshareSymbol(resolved)) next.add(resolved);
      else invalid.push(token);
    }
    setPool((prev) => ({ ...prev, custom: [...next] }));
    setCustomInput('');
    setPoolError(invalid.length > 0 ? `已忽略非 A 股代码: ${invalid.join(', ')}` : null);
  }, [customInput, pool.custom]);

  const handleRunPool = useCallback(async () => {
    setPoolError(null);
    setError(null);
    setPoolLoading(true);
    try {
      if (paramValues === null) throw new Error('策略参数 JSON 格式无效, 请检查');
      const indexes = POOL_OPTIONS.filter((o) => pool.indexes[o.id]).map((o) => o.id);
      const input: PoolBacktestInput = {
        strategyId,
        indexes,
        custom: pool.custom,
        excludeBoards: pool.excludeBoards,
        period: '1d',
        adjust: 'forward',
        initialCash: pool.initialCash,
        commissionRate: commissionRateOf(pool.commissionRateWan),
        minCommission: pool.minCommission,
        params: paramValues,
        force: pool.forceRefresh,
      };
      if (pool.rangeStart) input.rangeStart = pool.rangeStart;
      if (pool.rangeEnd) input.rangeEnd = pool.rangeEnd;
      if (pool.stopLossPercent) input.stopLossPercent = parseFloat(pool.stopLossPercent);

      const resp = await fetch('/api/backtest/pool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        // 409: 已有其他任务在跑 — 自动挂到正在运行的任务上继续看进度
        if (resp.status === 409 && err?.jobId) {
          setJobId(err.jobId);
          throw new Error(`${err.error ?? '已有任务进行中'} (已自动切换到该任务)`);
        }
        throw new Error(err?.error || `请求失败 (${resp.status})`);
      }
      const data = await resp.json();
      setJob(data.job ?? null);
      setJobId(data.jobId);
    } catch (err) {
      setPoolError(err instanceof Error ? err.message : '池回测发起失败，请检查参数与网络');
    } finally {
      setPoolLoading(false);
    }
  }, [jobId, pool, strategyId, paramValues]);

  const handleCancelPool = useCallback(async () => {
    if (!jobId) return;
    try {
      const resp = await fetch(`/api/backtest/pool/${jobId}/cancel`, { method: 'POST' });
      if (resp.ok) setJob(await resp.json());
    } catch {
      setPoolError('中断请求失败, 请稍后重试');
    }
  }, [jobId]);

  // ---- 池排行榜下钻 ----
  const handleSelectSymbol = useCallback(
    async (row: PoolSymbolResult) => {
      if (detailSymbol === row.symbol) {
        setDetailSymbol(null);
        setDetail(null);
        return;
      }
      setDetailSymbol(row.symbol);
      const cached = detailCache.current.get(row.symbol);
      if (cached) {
        setDetail(cached);
        return;
      }
      if (!jobId) return;
      setDetail(null);
      setDetailLoading(true);
      try {
        const resp = await fetch(`/api/backtest/pool/${jobId}/symbol/${encodeURIComponent(row.symbol)}`);
        if (!resp.ok) throw new Error(`明细加载失败 (${resp.status})`);
        const data: PoolSymbolDetailView = await resp.json();
        detailCache.current.set(row.symbol, data);
        setDetail(data);
      } catch (err) {
        setPoolError(err instanceof Error ? err.message : '明细加载失败');
      } finally {
        setDetailLoading(false);
      }
    },
    [detailSymbol, jobId],
  );

  // ---- 排行榜排序 / 过滤 ----
  /** 标的 -> 全池收益排名 (排行榜与下钻面板共用) */
  const rankBySymbol = useMemo(() => {
    const map = new Map<string, number>();
    poolSummary?.rows.forEach((r, i) => map.set(r.symbol, i + 1));
    return map;
  }, [poolSummary]);

  const leaderRows = useMemo(() => {
    if (!poolSummary) return [];
    const q = leaderQuery.trim();
    let rows = poolSummary.rows;
    if (q) {
      const upper = q.toUpperCase();
      rows = rows.filter(
        (r) =>
          r.symbol.toUpperCase().includes(upper) ||
          (r.name ?? '').includes(q) ||
          (r.industry ?? '').includes(q),
      );
    }
    if (leaderReturnFilter === 'profit') rows = rows.filter((r) => r.returnPercent > 0);
    else if (leaderReturnFilter === 'loss') rows = rows.filter((r) => r.returnPercent < 0);
    if (hideUntraded) rows = rows.filter((r) => r.trades > 0);
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === 'code' || sortKey === 'symbol') {
        return dir * a.symbol.localeCompare(b.symbol);
      }
      if (sortKey === 'name') {
        return dir * (a.name ?? a.code).localeCompare(b.name ?? b.code);
      }
      const av = Number(a[sortKey as keyof PoolSymbolResult] ?? 0);
      const bv = Number(b[sortKey as keyof PoolSymbolResult] ?? 0);
      return dir * (av - bv);
    });
  }, [poolSummary, leaderQuery, leaderReturnFilter, hideUntraded, sortKey, sortDir]);

  /** 全池未交易标的数 (用于标签与提示文案; 不受搜索/筛选影响) */
  const untradedCount = useMemo(
    () => (poolSummary ? poolSummary.rows.filter((r) => r.trades === 0).length : 0),
    [poolSummary],
  );

  /** 筛选后 (搜索 + 收益筛选) 的盈亏统计 */
  const leaderStats = useMemo(() => {
    const profit = leaderRows.filter((r) => r.returnPercent > 0).length;
    const flat = leaderRows.filter((r) => r.returnPercent === 0).length;
    const loss = leaderRows.length - profit - flat;
    return {
      profit,
      flat,
      loss,
      positivePct: leaderRows.length > 0 ? (profit / leaderRows.length) * 100 : 0,
    };
  }, [leaderRows]);

  /** 当前排序列的可读名 (用于「当前只显示前 100」这类提示文案) */
  const leaderSortLabel = useMemo(() => {
    const labels: Record<string, string> = {
      code: '代码', symbol: '标的', name: '名称', returnPercent: '收益', buyHoldPercent: '买入持有',
      excessPercent: '超额', trades: '交易', winRate: '胜率', sharpeRatio: '夏普',
      maxDrawdownPercent: '回撤', fees: '费用',
    };
    return labels[sortKey] ?? String(sortKey);
  }, [sortKey]);

  /** 成交明细: 文本过滤 (代码/名称/信号来源) */
  const tradeLogRows = useMemo(() => {
    if (!tradeLog) return [];
    const q = tradeLogQuery.trim();
    if (!q) return tradeLog.trades;
    const upper = q.toUpperCase();
    return tradeLog.trades.filter(
      (t) =>
        t.symbol.toUpperCase().includes(upper) ||
        (t.name ?? '').includes(q) ||
        t.signalType.toUpperCase().includes(upper),
    );
  }, [tradeLog, tradeLogQuery]);
  const tradeLogVisible = tradeLogRows.slice(0, tradeLogLimit);

  const toggleSort = useCallback(
    (key: typeof sortKey) => {
      if (sortKey === key) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
      else {
        setSortKey(key);
        setSortDir('desc');
      }
    },
    [sortKey],
  );

  // ---- 导出 ----
  const handleExportSingle = useCallback(() => {
    if (!singleResult?.result?.trades?.length) return;
    const rows: (string | number)[][] = [['日期', '方向', '信号来源', '信号依据', '执行价格', '交易股数', '交易金额', '费用', '盈亏', '盈亏率']];
    for (const t of singleResult.result.trades) {
      rows.push([
        t.date,
        t.type === 'BUY' ? '买入' : '卖出',
        t.signalType,
        csvCell(String(t.reason ?? t.signalType)),
        t.price,
        t.shares,
        t.value,
        t.fee ?? 0,
        t.pnl ?? '',
        t.pnlPercent ?? '',
      ]);
    }
    downloadCsv(
      `${singleResult.symbol}_backtest_${singleResult.dateRange.start}_${singleResult.dateRange.end}.csv`,
      rows,
    );
  }, [singleResult]);

  const handleExportPool = useCallback(() => {
    if (!poolSummary) return;
    // CSV 字段不能带千分位分隔符 (会破坏列), 数值统一用普通小数
    const num = (n: number, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : '');
    const rows: (string | number)[][] = [
      ['代码', '名称', '行业', '收益%', '买入持有%', '超额%', '交易数', '胜率%', '夏普', '最大回撤%', '费用', '数据起点', '数据终点'],
    ];
    for (const r of poolSummary.rows) {
      rows.push([
        r.symbol,
        csvCell(r.name ?? ''),
        csvCell(r.industry ?? ''),
        num(r.returnPercent),
        num(r.buyHoldPercent),
        num(r.excessPercent),
        r.trades,
        num(r.winRate),
        num(r.sharpeRatio),
        num(r.maxDrawdownPercent),
        num(r.fees),
        r.dateRange.start,
        r.dateRange.end,
      ]);
    }
    downloadCsv(`pool_backtest_${poolSummary.dateRange.start}_${poolSummary.dateRange.end}.csv`, rows);
  }, [poolSummary]);

  // ---- 全池成交明细 (按日期) ----
  const loadTradeLog = useCallback(
    async (force = false): Promise<PoolTradeLogView | null> => {
      if (!jobId) return null;
      if (tradeLog && !force) return tradeLog;
      setTradeLogLoading(true);
      try {
        const resp = await fetch(`/api/backtest/pool/${jobId}/trades`);
        if (!resp.ok) throw new Error(`成交明细加载失败 (${resp.status})`);
        const data: PoolTradeLogView = await resp.json();
        setTradeLog(data);
        return data;
      } catch (err) {
        setPoolError(err instanceof Error ? err.message : '成交明细加载失败');
        return null;
      } finally {
        setTradeLogLoading(false);
      }
    },
    [jobId, tradeLog],
  );

  const handleExportTrades = useCallback(async () => {
    const data = tradeLog ?? (await loadTradeLog());
    if (!data || data.trades.length === 0) {
      setPoolError('没有可导出的成交 (该任务未产生任何交易)');
      return;
    }
    const rows: (string | number)[][] = [
      ['日期', '代码', '名称', '方向', '信号来源', '信号依据', '执行价格', '交易股数', '交易金额', '费用', '盈亏', '盈亏率%'],
    ];
    for (const t of data.trades) {
      rows.push([
        t.date,
        t.symbol,
        csvCell(t.name ?? ''),
        t.type === 'BUY' ? '买入' : '卖出',
        t.signalType,
        csvCell(String(t.reason ?? '')),
        t.price,
        t.shares,
        t.value,
        t.fee,
        t.pnl ?? '',
        t.pnlPercent ?? '',
      ]);
    }
    const range = poolSummary ? `${poolSummary.dateRange.start}_${poolSummary.dateRange.end}` : 'all';
    downloadCsv(`pool_trades_${range}.csv`, rows);
  }, [tradeLog, loadTradeLog, poolSummary]);

  // ---- 渲染 ----
  if (!strategiesLoaded) {
    return (
      <div className="mx-auto flex w-full max-w-[1560px] flex-col items-center justify-center gap-3 py-24 text-zinc-500">
        {strategyLoadError ? (
          <>
            <AlertTriangle className="h-8 w-8 text-amber-500" />
            <p className="text-sm">策略列表加载失败: {strategyLoadError}</p>
            <button onClick={() => void loadStrategies()} className="text-xs text-blue-400 underline">
              重试
            </button>
          </>
        ) : (
          <>
            <RefreshCw className="h-8 w-8 animate-spin" />
            <p className="text-sm">加载策略中…</p>
          </>
        )}
      </div>
    );
  }

  if (strategies.length === 0) {
    return (
      <div className="mx-auto flex w-full max-w-[1560px] flex-col items-center justify-center gap-3 py-24 text-zinc-500">
        <FlaskConical className="h-8 w-8 text-zinc-700" />
        <p className="text-sm text-zinc-400">暂无策略</p>
        <p className="max-w-md text-center text-xs leading-relaxed text-zinc-600">
          在服务端 <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-zinc-400">server-py/chanlun_server/strategies/</code> 目录下
          新增 <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-zinc-400">.py</code> 策略文件
          (导出包含 id / name / decide 的对象), 或在「管理策略」里新建, 重启/刷新后即可加载。
        </p>
        <button onClick={() => void loadStrategies()} className="text-xs text-blue-400 underline">
          重新加载策略列表
        </button>
      </div>
    );
  }

  const singleCanRun = !!single.symbol.trim() && !!strategyId && !singleLoading;
  const poolCanRun = poolEffectiveCount > 0 && !!strategyId && !poolRunning;

  const leaderVisible = showAllRows ? leaderRows : leaderRows.slice(0, LEADER_PAGE_SIZE);
  const detailRow = detailSymbol ? poolSummary?.rows.find((r) => r.symbol === detailSymbol) : undefined;

  const sortIndicator = (key: typeof sortKey) =>
    sortKey === key ? (
      sortDir === 'desc' ? (
        <ChevronDown className="h-3 w-3 text-blue-400" />
      ) : (
        <ChevronUp className="h-3 w-3 text-blue-400" />
      )
    ) : null;

  const th = (key: typeof sortKey, label: string, align: 'left' | 'right' = 'right') => (
    <th
      className={`cursor-pointer select-none whitespace-nowrap px-3 py-2.5 transition hover:text-zinc-300 ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
      onClick={() => toggleSort(key)}
      title="点击排序"
    >
      <span className={`inline-flex items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
        {label}
        {sortIndicator(key)}
      </span>
    </th>
  );

  // 选股池模式走等权汇总回测 (POST /api/backtest/pool)。
  // 「共享资金逐日组合模拟」依赖 backtrader 执行层, 该引擎已随 Node 服务端一起移除,
  // 因此这里不再渲染 PortfolioSimulationView; 单标的模式保持原实现。
  return (
    <div className="mx-auto w-full max-w-[1560px]">

      {/* ================= 页头 (紧凑单行) ================= */}
      <section className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-gradient-to-br from-zinc-900/90 via-zinc-900/40 to-zinc-950 px-4 py-3">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-blue-500/25 bg-blue-500/15">
              <FlaskConical className="h-4 w-4 text-blue-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold tracking-tight text-zinc-100 md:text-base">策略模拟回测</h2>
              <p className="truncate text-[10px] text-zinc-500 md:text-[11px]">
                腾讯行情 · 沪深 A 股 · 信号当日收盘价成交 · 佣金 + 印花税 + 过户费 · 涨跌停拦截
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded-xl border border-zinc-800 bg-zinc-900/80 p-1">
              <button
                onClick={() => setMode('single')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                  mode === 'single' ? 'bg-blue-500/20 text-blue-300' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Target className="h-3.5 w-3.5" />
                单标的
              </button>
              <button
                onClick={() => setMode('pool')}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition cursor-pointer ${
                  mode === 'pool' ? 'bg-blue-500/20 text-blue-300' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Layers className="h-3.5 w-3.5" />
                选股池
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ================= 双栏工作区 ================= */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:mt-5 md:grid-cols-[300px_minmax(0,1fr)] md:items-start lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]">

        {/* ══════ 左栏: 回测控制台 (xl 起吸顶, 设置区独立滚动) ══════ */}
        <aside className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-[64px] xl:max-h-[calc(100vh_-_180px)]">
          <div className="flex flex-col gap-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">

          {/* 1. 回测范围 */}
          <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-3.5">
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
              {mode === 'single' ? <Target className="h-3.5 w-3.5 text-blue-400" /> : <Layers className="h-3.5 w-3.5 text-blue-400" />}
              回测范围
              <span className="ml-auto font-normal normal-case tracking-normal text-zinc-600">
                {mode === 'single' ? '单只独立回测' : '池内等权汇总'}
              </span>
            </div>

            {mode === 'single' ? (
              <div>
                <label className={labelCls}>标的代码</label>
                <input
                  type="text"
                  value={single.symbol}
                  onChange={(e) => setSingle((prev) => ({ ...prev, symbol: e.target.value.toUpperCase() }))}
                  placeholder="如 600519.SH / 000001.SZ / 600519"
                  className={inputCls}
                />
                <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                  支持 6 位纯代码自动补后缀 (60/68/90 → .SH, 其余 → .SZ)。
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {POOL_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => setPool((prev) => ({ ...prev, indexes: { ...prev.indexes, [o.id]: !prev.indexes[o.id] } }))}
                      className={chipCls(pool.indexes[o.id])}
                    >
                      {o.label}
                      <span className="font-mono text-[10px] opacity-70">{o.count}</span>
                    </button>
                  ))}
                  <button
                    onClick={() =>
                      setPool((prev) => {
                        const all = prev.indexes.hs300 && prev.indexes.zz500;
                        return { ...prev, indexes: { hs300: !all, zz500: !all } };
                      })
                    }
                    className={chipCls(pool.indexes.hs300 && pool.indexes.zz500)}
                  >
                    全部
                    <span className="font-mono text-[10px] opacity-70">800</span>
                  </button>
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <label className={`${labelCls} mb-0`}>排除板块</label>
                    <button
                      onClick={() =>
                        setPool((prev) => ({
                          ...prev,
                          excludeBoards:
                            prev.excludeBoards.length === EXCLUDABLE_BOARDS.length
                              ? []
                              : EXCLUDABLE_BOARDS.map((b) => b.id),
                        }))
                      }
                      className="text-[10px] text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                    >
                      {pool.excludeBoards.length === EXCLUDABLE_BOARDS.length ? '恢复全部' : '全部排除'}
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {EXCLUDABLE_BOARDS.map((b) => {
                      const on = pool.excludeBoards.includes(b.id);
                      return (
                        <button
                          key={b.id}
                          onClick={() => toggleBoard(b.id)}
                          title={`排除${b.label} (${b.hint})`}
                          className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[10px] font-semibold transition cursor-pointer ${
                            on
                              ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                              : 'border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {on && <Check className="h-3 w-3" />}
                          {b.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                    默认排除创业板 / 科创板 / 北交所: 小投资者无交易权限.
                  </p>
                </div>

                <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3 py-2">
                  <span className="text-[10px] text-zinc-500">本次回测宇宙</span>
                  <span className="font-mono text-xs font-bold text-zinc-200">
                    {pool.excludeBoards.length > 0 ? `${poolPreview.exact ? '' : '≈'}${poolEffectiveCount}` : poolUniverseCount} 只
                    <span className="ml-1.5 text-[10px] font-normal text-zinc-500">
                      {pool.indexes.hs300 ? '沪深300' : ''}
                      {pool.indexes.hs300 && pool.indexes.zz500 ? ' + ' : ''}
                      {pool.indexes.zz500 ? '中证500' : ''}
                      {pool.custom.length > 0 ? ` + 自定义 ${pool.custom.length}` : ''}
                      {poolPreview.excluded > 0 ? ` · 已排除 ${poolPreview.excluded} 只` : ''}
                    </span>
                  </span>
                </div>

                <div>
                  <label className={labelCls}>附加自定义标的 (可选)</label>
                  <div className="flex gap-2">
                      <input
                        type="text"
                        value={customInput}
                        onChange={(e) => setCustomInput(e.target.value.toUpperCase())}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleAddCustom();
                          }
                        }}
                        placeholder="输入 6 位代码, 逗号分隔, 回车添加"
                        className={inputCls}
                      />
                      <button
                        onClick={handleAddCustom}
                        disabled={!customInput.trim()}
                        className="shrink-0 rounded-xl border border-zinc-700 bg-zinc-800 px-3.5 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-40 cursor-pointer"
                      >
                        添加
                      </button>
                    </div>
                    {pool.custom.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {pool.custom.map((s) => (
                          <span
                            key={s}
                            className="flex items-center gap-1 rounded-lg border border-zinc-700/80 bg-zinc-900 px-2 py-1 font-mono text-[10px] text-zinc-300"
                          >
                            {s}
                            <button
                              onClick={() => setPool((prev) => ({ ...prev, custom: prev.custom.filter((c) => c !== s) }))}
                              className="text-zinc-500 transition hover:text-red-400 cursor-pointer"
                              title="移除"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                </div>
              </div>
            )}
          </section>

          {/* 2. 策略与参数 */}
          <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-3.5">
            <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
              <SlidersHorizontal className="h-3.5 w-3.5 text-blue-400" />
              策略
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => setSourceOpen(true)}
                  disabled={!strategyId}
                  className="flex h-6 items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/80 px-2 text-[10px] font-semibold normal-case tracking-normal text-zinc-400 transition hover:border-blue-500/40 hover:text-blue-300 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                  title="查看当前策略源码"
                >
                  <FileCode2 className="h-3 w-3" />
                  查看源码
                </button>
                <button
                  onClick={() => void loadStrategies()}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900/80 text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                  title="重新加载策略列表"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>
            </div>
            <div>
              <label className={labelCls}>策略选择</label>
              <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} className={inputCls}>
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.id})
                  </option>
                ))}
              </select>
              {selectedStrategy?.description && (
                <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">{selectedStrategy.description}</p>
              )}
              <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                策略来源: 服务端策略注册表 (server/strategies 内置 + data/user-strategies 自建); 回测在服务端执行, 全池共用同一份策略代码与参数。
              </p>
            </div>

            {selectedStrategy?.params && selectedStrategy.params.length > 0 && (
              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between">
                  <label className={`${labelCls} mb-0`}>策略参数 ({selectedStrategy.params.length})</label>
                  <button
                    onClick={() => setParamsExpanded((v) => !v)}
                    className="text-[11px] font-semibold text-blue-400 transition hover:text-blue-300 cursor-pointer"
                  >
                    {paramsExpanded ? '收起' : '展开'}
                  </button>
                </div>
                {paramsExpanded && (
                <div className="grid grid-cols-2 gap-2">
                  {selectedStrategy.params.map((p) => {
                    const current = (paramValues?.[p.key] ?? p.defaultValue) as string | number | boolean;
                    return (
                      <label
                        key={p.key}
                        className="block rounded-lg border border-zinc-800 bg-zinc-900/70 px-2.5 py-2 transition focus-within:border-blue-500/60"
                        title={p.key}
                      >
                        <span className="block truncate text-[10px] text-zinc-500">{p.label}</span>
                        {p.type === 'boolean' ? (
                          <input
                            type="checkbox"
                            checked={Boolean(current)}
                            onChange={(e) => setParamValue(p.key, e.target.checked)}
                            className="mt-1.5 h-4 w-4 rounded border-zinc-600 text-blue-500"
                          />
                        ) : (
                          <input
                            type="number"
                            value={Number(current)}
                            min={p.min}
                            max={p.max}
                            step={p.step ?? 1}
                            onChange={(e) => setParamValue(p.key, parseFloat(e.target.value))}
                            className="mt-1 w-full bg-transparent font-mono text-xs text-zinc-100 focus:outline-none"
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
                )}
              </div>
            )}

            <details className="group mt-3">
              <summary className="cursor-pointer select-none text-[11px] text-zinc-500 transition hover:text-zinc-300">
                高级: 参数 JSON 覆盖
                {paramValues === null && <span className="ml-2 text-red-400">JSON 格式无效</span>}
              </summary>
              <textarea
                value={paramsJson}
                onChange={(e) => setParamsJson(e.target.value)}
                rows={2}
                placeholder='{"fastPeriod": 10}'
                className={`${inputCls} mt-2 resize-none`}
              />
            </details>
          </section>

          {/* 3. 数据与区间 */}
          <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-3.5">
              <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                <Activity className="h-3.5 w-3.5 text-blue-400" />
                数据与区间
              </div>
              {(() => {
                const cfg = mode === 'single' ? single : pool;
                const setCfg = (patch: Partial<SingleState> & Partial<PoolState>) =>
                  mode === 'single'
                    ? setSingle((prev) => ({ ...prev, ...patch }))
                    : setPool((prev) => ({ ...prev, ...patch }));
                return (
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className={labelCls}>起始日</label>
                      <input
                        type="date"
                        value={cfg.rangeStart}
                        onChange={(e) => setCfg({ rangeStart: e.target.value })}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>结束日</label>
                      <input
                        type="date"
                        value={cfg.rangeEnd}
                        onChange={(e) => setCfg({ rangeEnd: e.target.value })}
                        className={inputCls}
                      />
                    </div>
                    <div className="col-span-2 flex items-center">
                      <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
                        <input
                          type="checkbox"
                          checked={cfg.forceRefresh}
                          onChange={(e) => setCfg({ forceRefresh: e.target.checked })}
                          className="h-4 w-4 rounded border-zinc-600 text-blue-500"
                        />
                        强制刷新缓存
                      </label>
                    </div>
                  </div>
                );
              })()}
          </section>

          {/* 4. 资金与风控 */}
          <section className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-3.5">
              <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                <Wallet className="h-3.5 w-3.5 text-blue-400" />
                资金与风控
                <span className="ml-auto font-normal normal-case tracking-normal text-zinc-600">
                  {mode === 'single' ? '单标的' : '单只名义本金'}
                </span>
              </div>
              {(() => {
                const cfg = mode === 'single' ? single : pool;
                const setCfg = (patch: Partial<SingleState> & Partial<PoolState>) =>
                  mode === 'single'
                    ? setSingle((prev) => ({ ...prev, ...patch }))
                    : setPool((prev) => ({ ...prev, ...patch }));
                return (
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className={labelCls}>{mode === 'single' ? '初始资金 (¥)' : '名义本金 (¥/只)'}</label>
                      <div className="relative">
                        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 font-mono text-xs font-bold text-zinc-500">
                          ¥
                        </span>
                        <input
                          type="number"
                          value={cfg.initialCash}
                          onChange={(e) =>
                            setCfg({ initialCash: Math.max(1000, parseInt(e.target.value) || cfg.initialCash) })
                          }
                          className={`${inputCls} pl-7`}
                        />
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>佣金 (‱)</label>
                      <input
                        type="number"
                        value={cfg.commissionRateWan}
                        step="0.1"
                        min="0"
                        onChange={(e) => setCfg({ commissionRateWan: parseFloat(e.target.value) || 0 })}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>最低佣金 (¥)</label>
                      <input
                        type="number"
                        value={cfg.minCommission}
                        onChange={(e) => setCfg({ minCommission: Math.max(0, parseFloat(e.target.value) || 0) })}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>固定止损 % (盘中止损单)</label>
                      <input
                        type="number"
                        value={cfg.stopLossPercent}
                        step="0.5"
                        onChange={(e) => setCfg({ stopLossPercent: e.target.value })}
                        placeholder="可选"
                        className={inputCls}
                      />
                    </div>
                  </div>
                );
              })()}
          </section>

          </div>

          {/* 运行栏: 常驻左栏底部。xl 吸顶布局下固定在侧栏底部, 滚动结果区也无需回滚即可运行;
              窄屏单列布局下紧随设置区之后。 */}
          <div className="flex shrink-0 flex-col gap-2.5 rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-3.5">
            <p className="text-[10px] leading-relaxed text-zinc-500">
            {mode === 'single' ? (
              <>
                <span className="font-mono text-zinc-300">{single.symbol || '—'}</span>
                <span className="mx-1.5 text-zinc-700">·</span>
                {selectedStrategy?.name ?? '策略'}
                <span className="mx-1.5 text-zinc-700">·</span>
                前复权
                <span className="mx-1.5 text-zinc-700">·</span>
                {single.rangeStart} ~ {single.rangeEnd}
              </>
            ) : (
              <>
                {poolEffectiveCount} 只标的
                {poolPreview.excluded > 0 && (
                  <span className="text-zinc-600"> (已排除 {poolPreview.excluded})</span>
                )}
                <span className="mx-1.5 text-zinc-700">·</span>
                {selectedStrategy?.name ?? '策略'}
                <span className="mx-1.5 text-zinc-700">·</span>
                名义本金 {money(pool.initialCash)}/只
                <span className="mx-1.5 text-zinc-700">·</span>
                等权组合
                <span className="text-zinc-600"> (约 1~3 分钟, 命中缓存更快)</span>
              </>
            )}
            </p>
            <button
              onClick={() => void (mode === 'single' ? handleRunSingle() : handleRunPool())}
              disabled={mode === 'single' ? !singleCanRun : !poolCanRun}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-500/10 transition hover:bg-blue-400 active:bg-blue-600 disabled:opacity-50 cursor-pointer"
            >
            {mode === 'single' && singleLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : poolRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4 fill-current" />
            )}
            <span>
              {mode === 'single'
                ? singleLoading
                  ? '回测中…'
                  : '运行模拟回测'
                : poolRunning
                  ? '池回测进行中…'
                  : '运行选股池回测'}
            </span>
            </button>
          </div>
        </aside>

        {/* ══════ 右栏: 结果区 (xl 双栏并排, 左栏设置常驻) ══════ */}
        <div className="min-w-0 space-y-4 md:space-y-5">

          {/* 操作错误提示 */}
          {error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-red-900/30 bg-red-950/20 p-3 text-xs text-red-400 md:p-4">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="leading-relaxed">{error}</p>
            </div>
          )}

          {/* ================= 单标的进度 ================= */}
          {mode === 'single' && singleLoading && (
            <SingleRunProgress
              progress={singleProgress}
              now={now}
              title={`${single.symbol || '—'} · ${selectedStrategy?.name ?? '策略'}`}
            />
          )}

          {/* ================= 池回测进度 ================= */}
          {mode === 'pool' && job?.state === 'running' && (() => {
            const p = job.progress;
            const percent = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
            const elapsedSec = Math.max(0, (now - job.startedAt) / 1000);
            // 处理速度与剩余时间估算; 样本太少 (前 3 秒 / 3 只) 时不显示, 避免数字抖动
            const rate = p.done >= 3 && elapsedSec >= 3 ? p.done / elapsedSec : null;
            const etaSec = rate !== null && p.total > p.done ? (p.total - p.done) / rate : null;
            return (
              <section className="rounded-2xl border border-blue-500/25 bg-blue-500/[0.05] p-4 md:p-5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-blue-300">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    正在回测选股池…
                  </div>
                  <button
                    onClick={() => void handleCancelPool()}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition hover:border-red-800 hover:text-red-400 cursor-pointer"
                  >
                    <Square className="h-3 w-3 fill-current" />
                    中断
                  </button>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-[width] duration-300"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-zinc-500">
                  <span className="text-zinc-300">
                    {p.total > 0 ? `${p.done}/${p.total} (${percent}%)` : '正在构建股票池…'}
                  </span>
                  <span className="flex flex-wrap gap-x-3">
                    <span>成功 {p.ok}</span>
                    {p.failed > 0 && <span className="text-amber-500/90">失败 {p.failed}</span>}
                    <span>有交易 {p.traded}</span>
                    <span>缓存命中 {p.cached}</span>
                    {rate !== null && <span>{rate >= 1 ? `${rate.toFixed(1)} 只/秒` : `${(rate * 60).toFixed(0)} 只/分`}</span>}
                    <span>已用 {fmtDuration(elapsedSec)}</span>
                    {etaSec !== null && Number.isFinite(etaSec) && (
                      <span className="text-blue-300/90">剩余约 {fmtDuration(etaSec)}</span>
                    )}
                  </span>
                </div>
                {job.active && job.active.length > 0 && (
                  <div
                    className="mt-1.5 truncate text-[10px] font-mono text-zinc-600"
                    title={job.active.join(', ')}
                  >
                    正在回测: {job.active.join(' · ')}
                  </div>
                )}
              </section>
            );
          })()}
          {mode === 'pool' && poolError && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-900/30 bg-amber-950/20 p-3 text-xs text-amber-300 md:p-4">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="leading-relaxed">{poolError}</p>
            </div>
          )}
          {mode === 'pool' && job?.state === 'cancelled' && (
            <div className="flex items-start gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 text-xs text-zinc-400 md:p-4">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <p>任务已中断。已完成部分的缓存与结果不会保留为组合报告, 可重新发起回测。</p>
            </div>
          )}
          {mode === 'pool' && job?.state === 'error' && (
            <div className="flex items-start gap-2.5 rounded-xl border border-red-900/30 bg-red-950/20 p-3 text-xs text-red-400 md:p-4">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{job.error ?? '池回测任务失败'}</p>
            </div>
          )}

          {/* ================= 单标的报告 ================= */}
          {mode === 'single' && singleResult && (
            <section className="space-y-4 md:space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                  <span className="flex items-center gap-1.5 font-mono text-sm font-bold text-zinc-100">
                    <LineChartIcon className="h-4 w-4 text-blue-400" />
                    {singleResult.symbol}
                  </span>
                  <span className="rounded-md border border-zinc-700/70 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-400">
                    {selectedStrategy?.name ?? singleResult.result.id}
                  </span>
                  <span className="font-mono text-[10px] text-zinc-500">
                    {singleResult.dateRange.start} ~ {singleResult.dateRange.end} · {singleResult.klinesCount} 根 ·{' '}
                    {singleResult.period === '1w' ? '周线' : '日线'} · {ADJUST_LABEL[singleResult.adjust] ?? singleResult.adjust}
                  </span>
                </div>
                <button
                  onClick={handleExportSingle}
                  disabled={!singleResult.result.trades?.length}
                  className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-100 transition hover:bg-zinc-700 disabled:opacity-50 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  导出 CSV
                </button>
              </div>

              <SymbolKpiGrid detail={singleResult} />

              {/* 价格 K 线 + 缠论分析 + 买卖成交标注 */}
              {(singleResult.klines?.length ?? 0) > 0 && (
                <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4 md:p-5">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h5 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                      <ChartCandlestick className="h-3.5 w-3.5 text-blue-400" />
                      K线 · 缠论分析 & 成交标注
                      <span className="font-mono font-normal normal-case tracking-normal text-zinc-600">
                        (笔/线段/中枢/买卖点)
                      </span>
                    </h5>
                    <span className="flex items-center gap-3 font-mono text-[10px] text-zinc-500">
                      <span>买入 {singleResult.result.trades.filter((t) => t.type === 'BUY').length} 笔</span>
                      <span>卖出 {singleResult.result.trades.filter((t) => t.type === 'SELL').length} 笔</span>
                    </span>
                  </div>
                  <ChanlunKlineChart
                    klines={singleResult.klines}
                    trades={singleResult.result.trades}
                    heightClass="h-72 md:h-80"
                  />
                </div>
              )}

              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4 md:p-5">
                <h5 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                  <LineChartIcon className="h-3.5 w-3.5 text-blue-400" />
                  权益曲线
                  <span className="font-mono font-normal normal-case tracking-normal text-zinc-600">
                    (虚线为初始资金)
                  </span>
                </h5>
                <EquityChart
                  dates={singleResult.equityDates}
                  values={singleResult.equityCurve}
                  initialBalance={singleResult.result.initialBalance}
                  gradientId="equity-single"
                />
              </div>

              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4 md:p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h5 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                    <ListOrdered className="h-3.5 w-3.5 text-blue-400" />
                    逐笔成交账本
                    <span className="font-mono font-normal normal-case tracking-normal text-zinc-600">
                      {singleResult.result.trades.length} 笔
                    </span>
                  </h5>
                </div>
                <TradesTable trades={singleResult.result.trades} />
              </div>

              <DiagnosticsPanel diagnostics={singleResult.diagnostics} />
            </section>
          )}

          {/* ================= 选股池报告 ================= */}
          {mode === 'pool' && poolSummary && (
            <section className="space-y-4 md:space-y-5">

              {/* 组合 KPI */}
              <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
                <Kpi
                  label="组合收益 (等权)"
                  value={pct(poolSummary.totalReturnPercent)}
                  tone={toneOf(poolSummary.totalReturnPercent)}
                  sub={`中位 ${pct(poolSummary.medianReturnPercent)} · 均值 ${pct(poolSummary.meanReturnPercent)}`}
                />
                <Kpi
                  label="等权买入持有"
                  value={pct(poolSummary.buyHoldReturnPercent)}
                  tone={toneOf(poolSummary.buyHoldReturnPercent)}
                  sub={`策略超额 ${pct(poolSummary.totalReturnPercent - poolSummary.buyHoldReturnPercent)}`}
                />
                <Kpi
                  label="最大回撤"
                  value={`${fmt(poolSummary.maxDrawdownPercent)}%`}
                  sub="组合权益曲线"
                  icon={<ShieldAlert className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="夏普比率"
                  value={fmt(poolSummary.sharpeRatio)}
                  tone={poolSummary.sharpeRatio >= 1 ? 'accent' : 'default'}
                  sub="组合权益曲线 (日频)"
                  icon={<Activity className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="盈利标的占比"
                  value={`${fmt(poolSummary.symbolWinRate)}%`}
                  sub={`${poolSummary.profitable}/${poolSummary.tested} 只正收益`}
                  icon={<Percent className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="跑赢买入持有"
                  value={`${fmt(poolSummary.beatBuyHoldRate)}%`}
                  sub={`${poolSummary.beatBuyHold}/${poolSummary.tested} 只跑赢基准`}
                  icon={<Target className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="总交易 / 有交易标的"
                  value={`${poolSummary.totalTrades}`}
                  sub={`${poolSummary.traded}/${poolSummary.tested} 只产生交易`}
                  icon={<ListOrdered className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="总费用"
                  value={money(poolSummary.totalFees)}
                  tone="warn"
                  sub={`名义本金 ${money(poolSummary.initialCash)}/只`}
                  icon={<Coins className="h-3.5 w-3.5 text-zinc-600" />}
                />
              </div>

              {/* 组合权益曲线 */}
              <div className="rounded-2xl border border-zinc-800/80 bg-zinc-950/60 p-4 md:p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h5 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                    <LineChartIcon className="h-3.5 w-3.5 text-blue-400" />
                    组合权益曲线 (等权)
                    <span className="font-mono font-normal normal-case tracking-normal text-zinc-600">
                      (各标的归一化权益逐日平均 · 起始 {money(poolSummary.initialCash)})
                    </span>
                  </h5>
                  <span className="font-mono text-[10px] text-zinc-500">
                    {poolSummary.dateRange.start} ~ {poolSummary.dateRange.end} · 成功 {poolSummary.tested} 只
                    {poolSummary.failed > 0 ? ` · 失败 ${poolSummary.failed} 只` : ''}
                  </span>
                </div>
                <EquityChart
                  dates={poolSummary.equityDates}
                  values={poolSummary.equityCurve}
                  initialBalance={poolSummary.initialCash}
                  gradientId="equity-pool"
                  heightClass="h-72 md:h-80"
                />
              </div>

              {/* 池内明细: 逐标的回测排行榜 / 全部成交明细 (按日期) */}
              <div className="overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950/60">
                {/* Tab 切换 */}
                <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800/80 px-2">
                  <button
                    onClick={() => setPoolTableTab('leader')}
                    className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-3 text-xs font-bold transition cursor-pointer ${
                      poolTableTab === 'leader'
                        ? 'border-blue-400 text-blue-400'
                        : 'border-transparent text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <ListOrdered className="h-3.5 w-3.5" />
                    逐标的回测排行榜
                    <span className="font-mono text-[10px] font-normal text-zinc-500">{leaderRows.length}</span>
                  </button>
                  <button
                    onClick={() => setPoolTableTab('trades')}
                    className={`-mb-px flex items-center gap-1.5 border-b-2 px-2.5 py-3 text-xs font-bold transition cursor-pointer ${
                      poolTableTab === 'trades'
                        ? 'border-blue-400 text-blue-400'
                        : 'border-transparent text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    <ClipboardList className="h-3.5 w-3.5" />
                    全部成交明细 (按日期)
                    <span className="font-mono text-[10px] font-normal text-zinc-500">
                      {tradeLog ? tradeLog.total : '—'}
                    </span>
                  </button>
                </div>

                {poolTableTab === 'leader' ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 px-4 py-3">
                      <h5 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                        <ListOrdered className="h-3.5 w-3.5 text-blue-400" />
                        逐标的回测排行榜
                        <span className="font-mono font-normal normal-case tracking-normal text-zinc-600">
                          {leaderRows.length}/{poolSummary.rows.length} 只 ·{' '}
                          <span className="text-red-400">盈利 {leaderStats.profit}</span>{' '}
                          <span className="text-green-400">亏损 {leaderStats.loss}</span>
                          {leaderStats.flat > 0 ? <span> / 持平 {leaderStats.flat}</span> : null}
                          <span> (正收益率 {leaderStats.positivePct.toFixed(1)}%)</span>
                          {hideUntraded && untradedCount > 0 ? (
                            <span> · 已隐藏未交易 {untradedCount} 只</span>
                          ) : null}
                          {' '}· 点击行查看明细
                        </span>
                      </h5>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                          <input
                            value={leaderQuery}
                            onChange={(e) => setLeaderQuery(e.target.value)}
                            placeholder="搜索代码 / 名称 / 行业"
                            className={`${inputCls} w-52 pl-8`}
                          />
                        </div>
                        <div className="flex items-center gap-0.5 rounded-lg border border-zinc-700 bg-zinc-900 p-0.5">
                          {([['all', '全部', 'text-zinc-400'], ['profit', '仅盈利', 'text-red-400'], ['loss', '仅亏损', 'text-green-400']] as const).map(
                            ([key, label, tone]) => (
                              <button
                                key={key}
                                onClick={() => setLeaderReturnFilter(key)}
                                className={`rounded-md px-2 py-1.5 text-[11px] font-semibold transition cursor-pointer ${
                                  leaderReturnFilter === key
                                    ? `bg-zinc-700 ${tone}`
                                    : 'text-zinc-500 hover:text-zinc-300'
                                }`}
                                title={key === 'all' ? '全部标的 (默认收益降序, 首页不只有赢家, 翻页看全池)' : key === 'profit' ? '只看收益 > 0 的标的' : '只看收益 < 0 的标的'}
                              >
                                {label}
                              </button>
                            ),
                          )}
                        </div>
                        <label
                          className="flex cursor-pointer select-none items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-[11px] font-semibold text-zinc-400 transition hover:text-zinc-200"
                          title="未产生任何交易的标的收益恒为 0%, 默认隐藏 (取消勾选可重新显示)"
                        >
                          <input
                            type="checkbox"
                            checked={hideUntraded}
                            onChange={(e) => setHideUntraded(e.target.checked)}
                            className="h-3 w-3 accent-blue-500"
                          />
                          隐藏未交易{untradedCount > 0 ? ` (${untradedCount})` : ''}
                        </label>
                        <button
                          onClick={handleExportPool}
                          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-100 transition hover:bg-zinc-700 cursor-pointer"
                        >
                          <Download className="h-3.5 w-3.5" />
                          导出全池 CSV
                        </button>
                      </div>
                    </div>

                    <div className="max-h-[560px] overflow-auto">
                      <table className="w-full min-w-[980px] text-left text-xs">
                        <thead className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 font-mono font-semibold text-zinc-500 backdrop-blur">
                          <tr>
                            <th className="w-12 px-3 py-2.5 text-left font-normal text-zinc-600">#</th>
                            {th('code', '标的', 'left')}
                            {th('returnPercent', '收益')}
                            {th('buyHoldPercent', '买入持有')}
                            {th('excessPercent', '超额')}
                            {th('trades', '交易')}
                            {th('winRate', '胜率')}
                            {th('sharpeRatio', '夏普')}
                            {th('maxDrawdownPercent', '回撤')}
                            {th('fees', '费用')}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-900">
                          {leaderVisible.map((r, i) => {
                            const rank = rankBySymbol.get(r.symbol) ?? poolSummary.rows.indexOf(r) + 1;
                            const active = detailSymbol === r.symbol;
                            return (
                              <tr
                                key={r.symbol}
                                onClick={() => void handleSelectSymbol(r)}
                                className={`cursor-pointer transition ${
                                  active ? 'bg-blue-500/10' : 'hover:bg-zinc-900/50'
                                }`}
                              >
                                <td className="px-3 py-2 font-mono text-[10px] text-zinc-600">{rank}</td>
                                <td className="px-3 py-2">
                                  <span className="font-semibold text-zinc-200">{r.name ?? r.code}</span>
                                  <span className="ml-2 font-mono text-[10px] text-zinc-500">{r.symbol}</span>
                                  {r.industry && (
                                    <span className="ml-2 hidden text-[10px] text-zinc-600 lg:inline">
                                      {r.industry.split('>').pop()?.trim()}
                                    </span>
                                  )}
                                </td>
                                <td className={`px-3 py-2 text-right font-mono font-bold ${upDown(r.returnPercent)}`}>
                                  {pct(r.returnPercent)}
                                </td>
                                <td className={`px-3 py-2 text-right font-mono ${upDown(r.buyHoldPercent)}`}>
                                  {pct(r.buyHoldPercent)}
                                </td>
                                <td className={`px-3 py-2 text-right font-mono font-semibold ${upDown(r.excessPercent)}`}>
                                  {pct(r.excessPercent)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-zinc-400">{r.trades}</td>
                                <td className="px-3 py-2 text-right font-mono text-zinc-300">{fmt(r.winRate)}%</td>
                                <td className="px-3 py-2 text-right font-mono text-zinc-300">{fmt(r.sharpeRatio)}</td>
                                <td className="px-3 py-2 text-right font-mono text-zinc-400">{fmt(r.maxDrawdownPercent)}%</td>
                                <td className="px-3 py-2 text-right font-mono text-zinc-500">{fmt(r.fees, 0)}</td>
                              </tr>
                            );
                          })}
                          {leaderVisible.length === 0 && (
                            <tr>
                              <td colSpan={10} className="py-10 text-center text-xs text-zinc-500">
                                {hideUntraded && untradedCount > 0
                                  ? '没有匹配的标的 (未产生交易的标的已隐藏, 可取消勾选「隐藏未交易」查看)'
                                  : '没有匹配的标的'}
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {leaderRows.length > LEADER_PAGE_SIZE && (
                      <div className="flex items-center justify-center border-t border-zinc-800/80 px-4 py-2.5">
                        <span className="mr-3 font-mono text-[10px] text-zinc-600">
                          当前: 按{leaderSortLabel}{sortDir === 'desc' ? '降序' : '升序'}前 {LEADER_PAGE_SIZE} 只 (非全池)
                        </span>
                        <button
                          onClick={() => setShowAllRows((v) => !v)}
                          className="text-[11px] font-semibold text-blue-400 transition hover:text-blue-300 cursor-pointer"
                        >
                          {showAllRows ? '收起' : `显示全部 ${leaderRows.length} 只`}
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 px-4 py-3">
                      <h5 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                        <ClipboardList className="h-3.5 w-3.5 text-blue-400" />
                        全部成交明细 (按日期)
                        <span className="font-mono font-normal normal-case tracking-normal text-zinc-600">
                          {tradeLog
                            ? `${tradeLogRows.length}/${tradeLog.total} 笔 · ${tradeLog.trades[0]?.date ?? ''} ~ ${tradeLog.trades[tradeLog.trades.length - 1]?.date ?? ''}`
                            : '全池逐笔买入 / 卖出 / 止损, 日期升序'}
                        </span>
                      </h5>
                      <div className="flex flex-wrap items-center gap-2">
                        {tradeLog && tradeLog.total > 0 && (
                          <div className="relative">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
                            <input
                              value={tradeLogQuery}
                              onChange={(e) => setTradeLogQuery(e.target.value)}
                              placeholder="搜索代码 / 名称 / 信号"
                              className={`${inputCls} w-52 pl-8`}
                            />
                          </div>
                        )}
                        <button
                          onClick={() => void handleExportTrades()}
                          disabled={tradeLogLoading}
                          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-100 transition hover:bg-zinc-700 disabled:opacity-50 cursor-pointer"
                        >
                          <Download className="h-3.5 w-3.5" />
                          导出全部成交 CSV
                        </button>
                      </div>
                    </div>

                    {!tradeLog ? (
                      <div className="flex flex-col items-center gap-3 py-10">
                        <p className="text-xs text-zinc-500">
                          合并全部标的的成交记录 (买入 / 卖出 / 止损), 按日期升序排列
                        </p>
                        <button
                          onClick={() => void loadTradeLog()}
                          disabled={tradeLogLoading}
                          className="flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-xs font-semibold text-blue-300 transition hover:bg-blue-500/20 disabled:opacity-50 cursor-pointer"
                        >
                          {tradeLogLoading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ClipboardList className="h-3.5 w-3.5" />
                          )}
                          {tradeLogLoading ? '加载中…' : '加载全部成交明细'}
                        </button>
                      </div>
                    ) : tradeLog.trades.length === 0 ? (
                      <div className="py-10 text-center text-xs text-zinc-500">该任务未产生任何交易</div>
                    ) : (
                      <>
                        <div className="max-h-[560px] overflow-auto">
                          <table className="w-full min-w-[920px] text-left text-xs">
                            <thead className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 font-mono font-semibold text-zinc-500 backdrop-blur">
                              <tr>
                                <th className="px-3 py-2.5 text-left font-normal text-zinc-600">日期</th>
                                <th className="px-3 py-2.5 text-left font-normal text-zinc-600">标的</th>
                                <th className="px-3 py-2.5 text-left font-normal text-zinc-600">方向</th>
                                <th className="px-3 py-2.5 text-left font-normal text-zinc-600">信号</th>
                                <th className="px-3 py-2.5 text-right font-normal text-zinc-600">价格</th>
                                <th className="px-3 py-2.5 text-right font-normal text-zinc-600">股数</th>
                                <th className="px-3 py-2.5 text-right font-normal text-zinc-600">金额</th>
                                <th className="px-3 py-2.5 text-right font-normal text-zinc-600">费用</th>
                                <th className="px-3 py-2.5 text-right font-normal text-zinc-600">盈亏</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-zinc-900">
                              {tradeLogVisible.map((t, i) => (
                                <tr key={`${t.symbol}-${t.date}-${t.type}-${i}`} className="hover:bg-zinc-900/40">
                                  <td className="whitespace-nowrap px-3 py-2 font-mono text-zinc-400">{t.date}</td>
                                  <td className="whitespace-nowrap px-3 py-2">
                                    <span className="font-semibold text-zinc-300">{t.name ?? t.code}</span>
                                    <span className="ml-1.5 font-mono text-[10px] text-zinc-500">{t.symbol}</span>
                                  </td>
                                  <td
                                    className={`whitespace-nowrap px-3 py-2 font-semibold ${
                                      t.type === 'BUY' ? 'text-red-400' : 'text-green-400'
                                    }`}
                                  >
                                    {t.type === 'BUY' ? '买入' : '卖出'}
                                  </td>
                                  <td
                                    className="max-w-[260px] truncate px-3 py-2 text-zinc-400"
                                    title={String(t.reason ?? t.signalType)}
                                  >
                                    {t.signalType}
                                    {t.reason ? ` · ${t.reason}` : ''}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono text-zinc-300">{t.price.toFixed(2)}</td>
                                  <td className="px-3 py-2 text-right font-mono text-zinc-300">
                                    {t.shares.toLocaleString()}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono text-zinc-300">{money(t.value)}</td>
                                  <td className="px-3 py-2 text-right font-mono text-zinc-500">{fmt(t.fee)}</td>
                                  <td
                                    className={`px-3 py-2 text-right font-mono font-semibold ${
                                      t.pnl === undefined ? 'text-zinc-600' : upDown(t.pnl)
                                    }`}
                                  >
                                    {t.pnl === undefined ? '--' : money(t.pnl)}
                                    {t.pnlPercent !== undefined ? (
                                      <span className="ml-1 text-[10px]">({pct(t.pnlPercent)})</span>
                                    ) : null}
                                  </td>
                                </tr>
                              ))}
                              {tradeLogVisible.length === 0 && (
                                <tr>
                                  <td colSpan={9} className="py-10 text-center text-xs text-zinc-500">
                                    没有匹配的成交
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                        {tradeLogRows.length > tradeLogLimit && (
                          <div className="flex items-center justify-center gap-3 border-t border-zinc-800/80 px-4 py-2.5">
                            <span className="font-mono text-[10px] text-zinc-600">
                              已显示 {tradeLogVisible.length}/{tradeLogRows.length} 笔
                            </span>
                            <button
                              onClick={() => setTradeLogLimit((v) => v + TRADE_LOG_PAGE_SIZE)}
                              className="text-[11px] font-semibold text-blue-400 transition hover:text-blue-300 cursor-pointer"
                            >
                              显示更多
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>

              {/* 下钻明细 */}
              {detailSymbol && (
                <div className="rounded-2xl border border-blue-500/20 bg-zinc-950/70 p-4 md:p-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-500/25 bg-blue-500/10">
                        <Target className="h-4 w-4 text-blue-400" />
                      </span>
                      <div>
                        <p className="text-sm font-bold text-zinc-100">
                          {detailRow?.name ?? detailSymbol}
                          <span className="ml-2 font-mono text-[11px] font-normal text-zinc-500">{detailSymbol}</span>
                        </p>
                        {detailRow && (
                          <p className="mt-0.5 text-[10px] text-zinc-500">
                            池内排名第 {rankBySymbol.get(detailRow.symbol) ?? '-'} · 收益 {pct(detailRow.returnPercent)} ·
                            超额 {pct(detailRow.excessPercent)} · {detailRow.dateRange.start} ~ {detailRow.dateRange.end}
                          </p>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setDetailSymbol(null);
                        setDetail(null);
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                      title="关闭"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {detailLoading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-xs text-zinc-500">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      加载明细…
                    </div>
                  ) : detail ? (
                    <div className="space-y-4">
                      <SymbolKpiGrid detail={detail} />
                      {(detail.klines?.length ?? 0) > 0 && (
                        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950 p-3 md:p-4">
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <h6 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                              <ChartCandlestick className="h-3.5 w-3.5 text-cyan-400" />
                              K线 · 缠论分析 & 成交标注
                            </h6>
                            <span className="flex items-center gap-3 font-mono text-[10px] text-zinc-600">
                              <span>买入 {detail.result.trades.filter((t) => t.type === 'BUY').length} 笔</span>
                              <span>卖出 {detail.result.trades.filter((t) => t.type === 'SELL').length} 笔</span>
                            </span>
                          </div>
                          <ChanlunKlineChart
                            klines={detail.klines}
                            trades={detail.result.trades}
                            heightClass="h-64 md:h-72"
                          />
                        </div>
                      )}
                      <div className="rounded-xl border border-zinc-800/80 bg-zinc-950 p-3 md:p-4">
                        <h6 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">权益曲线</h6>
                        <EquityChart
                          dates={detail.equityDates}
                          values={detail.equityCurve}
                          initialBalance={detail.result.initialBalance}
                          gradientId={`equity-detail-${detailSymbol?.replace(/[^A-Za-z0-9]/g, '')}`}
                          heightClass="h-52"
                          tone="cyan"
                        />
                      </div>
                      <div className="max-h-[380px] overflow-auto rounded-xl border border-zinc-800/80 bg-zinc-950">
                        <TradesTable trades={detail.result.trades} />
                      </div>
                      <DiagnosticsPanel diagnostics={detail.diagnostics} />
                    </div>
                  ) : (
                    <p className="py-6 text-center text-xs text-zinc-500">该标的没有可用的明细数据。</p>
                  )}
                </div>
              )}

              {/* 失败清单 */}
              {poolSummary.failures.length > 0 && (
                <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/30 p-4">
                  <h5 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                    失败标的 ({poolSummary.failed})
                  </h5>
                  <div className="max-h-40 space-y-1 overflow-auto text-[11px]">
                    {poolSummary.failures.map((f) => (
                      <p key={f.symbol} className="font-mono text-zinc-500">
                        <span className="text-zinc-300">{f.symbol}</span> — {f.error}
                      </p>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* 空态引导 */}
          {((mode === 'single' && !singleResult && !singleLoading) ||
            (mode === 'pool' && !poolSummary && job?.state !== 'running')) && (
            <section className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/20 py-12 text-center xl:min-h-[460px]">
              <LineChartIcon className="h-7 w-7 text-zinc-700" />
              <p className="text-xs text-zinc-500">
                {mode === 'single'
                  ? '在左侧设置标的与策略参数后, 点击「运行模拟回测」查看绩效报告'
                  : '在左侧选择股票池与策略后, 点击「运行选股池回测」查看组合报告与逐标的排行榜'}
              </p>
            </section>
          )}
        </div>
      </div>

      <StrategySourceDialog
        strategyId={strategyId}
        strategyName={selectedStrategy?.name}
        isOpen={sourceOpen}
        onClose={() => setSourceOpen(false)}
      />
    </div>
  );
}
