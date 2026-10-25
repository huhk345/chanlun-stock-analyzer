/**
 * 股票池「共享资金逐日组合模拟」。
 *
 * 与旧版「每只票独立回测再等权平均」不同:
 *   - 只有一个资金账户, 同一天多个买点竞争现金与仓位;
 *   - TS 策略只用截至当日的 K 线 / 缠论结构给出 BUY / SELL;
 *   - Python backtrader 按当日收盘价逐日撮合, 含 T+1、涨跌停、整手、佣金/印花税/过户费;
 *   - 输出组合权益曲线 + 默认沪深300全收益基准 + 市场环境指标 + 逐笔成交 + 信号账本 + 标的排行。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ChartCandlestick,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  FlaskConical,
  Gauge,
  Layers,
  LineChart as LineChartIcon,
  ListChecks,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Square,
  Target,
  Wallet,
  X,
} from 'lucide-react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { INDEX_META, type IndexId } from '../types/scan';
import type { BacktestTrade } from '../types/stock';
import { EXCLUDABLE_BOARDS, isBoardExcluded, type ExcludableBoard } from '../utils/symbols';
import { csvCell, downloadCsv } from '../utils/download';
import type {
  PortfolioBenchmarkId,
  PortfolioEquityPoint,
  PortfolioMarketIndicator,
  PortfolioOpenPosition,
  PortfolioSignalPage,
  PortfolioSignalRow,
  PortfolioSimulationInput,
  PortfolioSimulationJobView,
  PortfolioSymbolStat,
  PortfolioTradeRow,
  SimulationEngineHealth,
} from '../types/portfolioSimulation';
import StrategySourceDialog from './StrategySourceDialog';
import StockKlineDrawer from './StockKlineDrawer';

// ---------------------------------------------------------------------------
// 常量 & 格式化
// ---------------------------------------------------------------------------

const POOL_OPTIONS: { id: IndexId; label: string; count: number }[] = [
  { id: 'hs300', label: '沪深300', count: 300 },
  { id: 'zz500', label: '中证500', count: 500 },
];

const POOL_JOB_KEY = 'chanlun_portfolio_simulation_job';

/** 组合基准选项: 默认沪深300全收益 (含股息再投资) */
const BENCHMARK_OPTIONS: { id: PortfolioBenchmarkId; label: string; hint: string }[] = [
  { id: 'hs300_tr', label: '沪深300全收益 (H00300)', hint: '含股息再投资, 默认' },
  { id: 'hs300', label: '沪深300 (000300)', hint: '价格指数, 不含股息' },
  { id: 'equal_weight', label: '池内等权买入持有', hint: '与本策略同股票池' },
];

const SIGNAL_PAGE_SIZE = 200;
const TRADE_PAGE_SIZE = 50;

const today = () => new Date().toISOString().slice(0, 10);

interface PoolConfig {
  indexes: Record<IndexId, boolean>;
  custom: string[];
  /** 排除板块: 创业板 300/301、科创板 688/689、北交所 */
  excludeBoards: ExcludableBoard[];
  rangeStart: string;
  rangeEnd: string;
  adjust: 'forward' | 'backward' | '';
  initialCash: string;
  maxPositions: string;
  positionPercent: string;
  stopLoss: string;
  commissionWan: string;
  minCommission: string;
  benchmark: PortfolioBenchmarkId;
  forceRefresh: boolean;
  /** 持仓已满时用更强候选替换最弱持仓 (仅对给出 score 的轮动策略有效) */
  rotationEnabled: boolean;
  rotationMinScoreDelta: string;
  rotationMaxPerDay: string;
}

const DEFAULT_CONFIG: PoolConfig = {
  indexes: { hs300: true, zz500: false },
  custom: [],
  excludeBoards: [],
  rangeStart: '2023-01-01',
  rangeEnd: today(),
  adjust: 'forward',
  initialCash: '100000',
  maxPositions: '10',
  positionPercent: '10',
  stopLoss: '',
  commissionWan: '2.5',
  minCommission: '5',
  benchmark: 'hs300_tr',
  forceRefresh: false,
  rotationEnabled: false,
  rotationMinScoreDelta: '1',
  rotationMaxPerDay: '2',
};

interface StrategyParamDef {
  key: string;
  label: string;
  type: 'number' | 'string' | 'boolean';
  defaultValue: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
}

interface StrategyListItem {
  id: string;
  name: string;
  description?: string;
  requiresChanLun?: boolean;
  params?: StrategyParamDef[];
  availableIndicators?: { id: string; name: string; defaultSelected?: boolean }[];
  requiredIndicators?: { id: string }[];
}

const moneyFmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

function money(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '--';
  return `¥${moneyFmt.format(v)}`;
}

function compactMoney(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '--';
  const abs = Math.abs(v);
  if (abs >= 1e8) return `¥${(v / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `¥${(v / 1e4).toFixed(2)}万`;
  return `¥${moneyFmt.format(v)}`;
}

function pct(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '--';
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

function num(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '--';
  return v.toFixed(digits);
}

function upDown(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v) || v === 0) return 'text-zinc-300';
  return v > 0 ? 'text-red-400' : 'text-green-400';
}

function axisFmt(v: number): string {
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return v.toFixed(0);
}

const cardCls = 'rounded-2xl border border-zinc-800/80 bg-zinc-900/30';
const labelCls = 'mb-1 block text-[10px] font-mono uppercase tracking-wider text-zinc-500';
const inputCls =
  'w-full rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-xs text-zinc-200 outline-none transition placeholder:text-zinc-600 focus:border-blue-500/60 focus:ring-1 focus:ring-blue-500/20';
const thCls = 'whitespace-nowrap px-2.5 py-2 text-left text-[10px] font-mono uppercase tracking-wider text-zinc-500';
const tdCls = 'whitespace-nowrap px-2.5 py-2 text-[11px] text-zinc-300';

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
    <div className="relative overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[10px] font-mono uppercase tracking-wider text-zinc-500">{label}</span>
        {icon}
      </div>
      <p className={`mt-1.5 truncate text-base font-extrabold font-mono md:text-lg ${TONE_CLS[tone]}`} title={value}>
        {value}
      </p>
      {sub && <p className="mt-0.5 truncate text-[10px] text-zinc-500">{sub}</p>}
    </div>
  );
}

function Badge({ tone, children }: { tone: 'blue' | 'amber' | 'green' | 'red' | 'zinc'; children: React.ReactNode }) {
  const cls = {
    blue: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    red: 'border-red-500/30 bg-red-500/10 text-red-300',
    zinc: 'border-zinc-700 bg-zinc-800/60 text-zinc-300',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-mono ${cls}`}>
      {children}
    </span>
  );
}

function SideBadge({ side }: { side: 'BUY' | 'SELL' }) {
  return side === 'BUY' ? <Badge tone="red">买入</Badge> : <Badge tone="green">卖出</Badge>;
}

// ---------------------------------------------------------------------------
// 标的单元格: 点击打开该股 K 线抽屉 (与分析页同款图表)
// ---------------------------------------------------------------------------

type SelectSymbol = (symbol: string, name?: string) => void;

function SymbolCell({
  symbol,
  name,
  onSelect,
}: {
  symbol: string;
  name?: string;
  onSelect?: SelectSymbol;
}) {
  if (!onSelect) {
    return (
      <>
        <span className="font-mono text-zinc-200">{symbol}</span>
        {name && <span className="ml-1.5 text-zinc-500">{name}</span>}
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(symbol, name)}
      title={`查看 ${symbol}${name ? ` ${name}` : ''} 的 K 线`}
      className="group/sym -mx-1 inline-flex max-w-full items-center gap-1 rounded px-1 text-left font-mono text-zinc-200 transition hover:bg-blue-500/10 hover:text-blue-300 cursor-pointer"
    >
      <span className="truncate">{symbol}</span>
      {name && (
        <span className="truncate font-sans text-zinc-500 transition group-hover/sym:text-blue-300/80">
          {name}
        </span>
      )}
      <ChartCandlestick className="h-3 w-3 shrink-0 text-blue-400 opacity-0 transition group-hover/sym:opacity-80" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// 市场环境 (默认基准数据: 中证全债 / 10Y 国债 / 沪深300 PE / ERP ...)
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<PortfolioMarketIndicator['kind'], string> = {
  index: '指数',
  yield: '利率',
  valuation: '估值',
  derived: '派生',
};

/** 指数用 %, 利率/估值/派生用绝对值 (百分点或倍数) */
function marketDelta(v: number | null | undefined, unit: string, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '--';
  const suffix = unit === '点' ? '%' : unit === '%' ? 'pp' : unit;
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`;
}

function deltaTone(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return 'text-zinc-500';
  return v > 0 ? 'text-red-400' : 'text-green-400';
}

function MarketContextPanel({ items }: { items: PortfolioMarketIndicator[] }) {
  if (items.length === 0) return null;
  const asOf = items.map((i) => i.lastDate).sort().slice(-1)[0];

  return (
    <section className={cardCls}>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-4 py-2.5">
        <h3 className="flex items-center gap-1.5 text-xs font-bold text-zinc-300">
          <Activity className="h-3.5 w-3.5 text-blue-400" />
          市场环境 · 默认基准数据
        </h3>
        <span className="text-[10px] text-zinc-500">中证指数 / 东方财富 · 截至 {asOf}</span>
        <span className="ml-auto text-[10px] font-mono text-zinc-600">不参与选股, 仅供对照</span>
      </div>
      <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-3 xl:grid-cols-5">
        {items.map((it) => {
          const stroke =
            it.change20d === null || !Number.isFinite(it.change20d) || it.change20d === 0
              ? '#71717a'
              : it.change20d > 0
                ? '#f87171'
                : '#4ade80';
          return (
            <div key={it.id} className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-2.5">
              <div className="flex items-start justify-between gap-1">
                <span
                  className="truncate text-[10px] font-mono uppercase tracking-wider text-zinc-500"
                  title={`${it.name} · ${it.source}`}
                >
                  {it.name}
                </span>
                <span className="shrink-0 text-[9px] text-zinc-600">{KIND_LABEL[it.kind]}</span>
              </div>
              <p className="mt-1 font-mono text-sm font-bold text-zinc-100">
                {num(it.lastValue, 2)}
                <span className="ml-0.5 text-[10px] font-normal text-zinc-500">{it.unit}</span>
              </p>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] font-mono">
                <span className={deltaTone(it.change1d)}>日 {marketDelta(it.change1d, it.unit)}</span>
                <span className={deltaTone(it.change20d)}>20日 {marketDelta(it.change20d, it.unit)}</span>
              </div>
              <div className="mt-1.5 h-8">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={it.spark.map((p, i) => ({ i, v: p.value }))}
                    margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
                  >
                    <Line
                      type="monotone"
                      dataKey="v"
                      stroke={stroke}
                      strokeWidth={1.2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 权益曲线
// ---------------------------------------------------------------------------

function EquityTooltip({
  active,
  payload,
  label,
  initial,
}: {
  active?: boolean;
  payload?: { dataKey?: string; value?: number }[];
  label?: string;
  initial: number;
}) {
  if (!active || !payload?.length) return null;
  const get = (key: string) => Number(payload.find((p) => p.dataKey === key)?.value ?? 0);
  const strategy = get('strategy');
  const benchmark = get('benchmark');
  const ret = initial > 0 ? ((strategy - initial) / initial) * 100 : 0;
  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-950/95 px-3 py-2 shadow-xl">
      <p className="text-[10px] font-mono text-zinc-500">{label}</p>
      <p className="mt-1 text-[11px] font-mono text-blue-300">
        组合 {money(strategy)} <span className={upDown(ret)}>({pct(ret)})</span>
      </p>
      <p className="text-[10px] font-mono text-zinc-500">基准 {money(benchmark)}</p>
    </div>
  );
}

function PortfolioEquityChart({ equity, initial }: { equity: PortfolioEquityPoint[]; initial: number }) {
  const data = useMemo(() => {
    if (equity.length === 0) return [];
    const step = Math.max(1, Math.ceil(equity.length / 900));
    const sampled = equity.filter((_, i) => i % step === 0 || i === equity.length - 1);
    return sampled.map((p) => ({ date: p.date, strategy: p.value, benchmark: p.benchmark }));
  }, [equity]);

  if (data.length === 0) {
    return <div className="flex h-64 items-center justify-center text-xs text-zinc-600">暂无权益数据</div>;
  }

  return (
    <div className="h-64 w-full md:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="portfolio-equity" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
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
            tickFormatter={axisFmt}
            axisLine={false}
            tickLine={false}
            domain={['auto', 'auto']}
          />
          <Tooltip content={<EquityTooltip initial={initial} />} />
          <ReferenceLine y={initial} stroke="#52525b" strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="strategy"
            stroke="#3b82f6"
            strokeWidth={1.8}
            fill="url(#portfolio-equity)"
            dot={false}
            activeDot={{ r: 3 }}
          />
          <Line
            type="monotone"
            dataKey="benchmark"
            stroke="#a1a1aa"
            strokeWidth={1.2}
            strokeDasharray="5 4"
            dot={false}
            activeDot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 成交账本
// ---------------------------------------------------------------------------

function TradesTable({
  trades,
  fileBase,
  onSelectSymbol,
}: {
  trades: PortfolioTradeRow[];
  /** 导出文件名 (不含扩展名), 一般为 portfolio_trades_<起>_<止> */
  fileBase: string;
  onSelectSymbol?: SelectSymbol;
}) {
  const [side, setSide] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    return trades.filter((t) => {
      if (side !== 'ALL' && t.side !== side) return false;
      if (!q) return true;
      return (
        t.symbol.toUpperCase().includes(q) ||
        (t.name ?? '').toUpperCase().includes(q) ||
        (t.reason ?? '').toUpperCase().includes(q)
      );
    });
  }, [trades, side, query]);

  useEffect(() => setPage(0), [side, query]);

  const pages = Math.max(1, Math.ceil(filtered.length / TRADE_PAGE_SIZE));
  const rows = filtered.slice(page * TRADE_PAGE_SIZE, (page + 1) * TRADE_PAGE_SIZE);

  /** 导出当前筛选后的成交 (CSV 字段不能带千分位, 数值统一用普通小数) */
  const handleExport = useCallback(() => {
    if (filtered.length === 0) return;
    const num = (n: number | undefined, digits = 2) =>
      n === undefined || !Number.isFinite(n) ? '' : n.toFixed(digits);
    const rowsOut: (string | number)[][] = [
      ['日期', '方向', '代码', '名称', '成交价', '成交股数', '成交金额', '费用', '盈亏', '盈亏率%', '持有天数', '建仓日期', '成交原因'],
    ];
    for (const t of filtered) {
      rowsOut.push([
        t.date,
        t.side === 'BUY' ? '买入' : '卖出',
        t.symbol,
        csvCell(t.name ?? ''),
        num(t.price),
        t.shares,
        num(t.value),
        num(t.fee),
        num(t.pnl),
        num(t.pnlPercent),
        t.holdDays ?? '',
        t.entryDate ?? '',
        csvCell(t.reason ?? ''),
      ]);
    }
    downloadCsv(`${fileBase}.csv`, rowsOut);
  }, [filtered, fileBase]);

  if (trades.length === 0) {
    return <div className="px-3 py-10 text-center text-xs text-zinc-600">本次模拟没有产生成交</div>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-3 py-2.5">
        <div className="flex rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
          {(['ALL', 'BUY', 'SELL'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setSide(v)}
              className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition cursor-pointer ${
                side === v ? 'bg-blue-500/20 text-blue-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {v === 'ALL' ? '全部' : v === 'BUY' ? '买入' : '卖出'}
            </button>
          ))}
        </div>
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="代码 / 名称 / 原因"
            className={`${inputCls} py-1.5 pl-8`}
          />
        </div>
        <span className="text-[10px] font-mono text-zinc-500">{filtered.length} 笔</span>
        <button
          onClick={handleExport}
          disabled={filtered.length === 0}
          title="导出当前筛选的成交明细"
          className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[10px] font-semibold text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-40 cursor-pointer"
        >
          <Download className="h-3.5 w-3.5" />
          导出 CSV
        </button>
      </div>

      <div className="max-h-[460px] overflow-auto">
        <table className="w-full min-w-[900px] text-left">
          <thead className="sticky top-0 z-10 bg-zinc-900/95 backdrop-blur">
            <tr className="border-b border-zinc-800">
              <th className={thCls}>日期</th>
              <th className={thCls}>方向</th>
              <th className={thCls}>标的</th>
              <th className={`${thCls} text-right`}>价格</th>
              <th className={`${thCls} text-right`}>股数</th>
              <th className={`${thCls} text-right`}>金额</th>
              <th className={`${thCls} text-right`}>费用</th>
              <th className={`${thCls} text-right`}>盈亏</th>
              <th className={`${thCls} text-right`}>持有</th>
              <th className={thCls}>原因</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={`${t.date}-${t.symbol}-${t.side}-${i}`} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                <td className={`${tdCls} font-mono text-zinc-400`}>{t.date}</td>
                <td className={tdCls}>
                  <SideBadge side={t.side} />
                </td>
                <td className={tdCls}>
                  <SymbolCell symbol={t.symbol} name={t.name} onSelect={onSelectSymbol} />
                </td>
                <td className={`${tdCls} text-right font-mono`}>{num(t.price)}</td>
                <td className={`${tdCls} text-right font-mono`}>{intFmt.format(t.shares)}</td>
                <td className={`${tdCls} text-right font-mono`}>{compactMoney(t.value)}</td>
                <td className={`${tdCls} text-right font-mono text-amber-400/80`}>{num(t.fee)}</td>
                <td className={`${tdCls} text-right font-mono ${upDown(t.pnl)}`}>
                  {t.pnl === undefined || t.pnl === null ? '--' : money(t.pnl)}
                  {t.pnlPercent !== undefined && (
                    <span className="ml-1 text-[10px] opacity-80">({pct(t.pnlPercent)})</span>
                  )}
                </td>
                <td className={`${tdCls} text-right font-mono text-zinc-500`}>
                  {t.holdDays === undefined ? '--' : `${t.holdDays}天`}
                </td>
                <td className={`${tdCls} max-w-[260px] truncate text-zinc-500`} title={t.reason}>
                  {t.reason ?? '--'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-zinc-800/80 px-3 py-2">
          <span className="text-[10px] font-mono text-zinc-500">
            第 {page + 1}/{pages} 页
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="rounded-md border border-zinc-800 p-1 text-zinc-400 transition hover:text-zinc-100 disabled:opacity-30 cursor-pointer"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              className="rounded-md border border-zinc-800 p-1 text-zinc-400 transition hover:text-zinc-100 disabled:opacity-30 cursor-pointer"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 信号账本
// ---------------------------------------------------------------------------

function SignalStatus({ row }: { row: PortfolioSignalRow }) {
  if (row.status === 'filled') return <Badge tone="blue">已成交</Badge>;
  if (row.status === 'rejected') return <Badge tone="red">被拒绝</Badge>;
  return <Badge tone="amber">{row.skipReason || '未成交'}</Badge>;
}

function SignalsTable({
  jobId,
  total,
  fileBase,
  onSelectSymbol,
}: {
  jobId: string;
  total: number;
  /** 导出文件名 (不含扩展名), 一般为 portfolio_signals_<起>_<止> */
  fileBase: string;
  onSelectSymbol?: SelectSymbol;
}) {
  const [action, setAction] = useState<'ALL' | 'BUY' | 'SELL' | 'SKIPPED'>('ALL');
  const [symbolInput, setSymbolInput] = useState('');
  const [symbol, setSymbol] = useState('');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<PortfolioSignalPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOffset(0);
  }, [action, symbol]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = new URLSearchParams({ limit: String(SIGNAL_PAGE_SIZE), offset: String(offset), action });
    if (symbol) q.set('symbol', symbol);
    fetch(`/api/simulation/${jobId}/signals?${q}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || `信号加载失败 (${r.status})`);
        if (!cancelled) setPage(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '信号加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, action, symbol, offset]);

  const rows = page?.rows ?? [];
  const count = page?.total ?? total;
  const pages = Math.max(1, Math.ceil(count / SIGNAL_PAGE_SIZE));

  /** 导出当前筛选下的全部信号 (信号账本分页存放, 需逐页拉取) */
  const handleExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const all: PortfolioSignalRow[] = [];
      const limit = 1000;
      for (;;) {
        const q = new URLSearchParams({ limit: String(limit), offset: String(all.length), action });
        if (symbol) q.set('symbol', symbol);
        const resp = await fetch(`/api/simulation/${jobId}/signals?${q}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data?.error || `信号导出失败 (${resp.status})`);
        all.push(...(data.rows ?? []));
        if (all.length >= (data.total ?? 0) || (data.rows ?? []).length === 0) break;
      }
      if (all.length === 0) {
        setError('没有可导出的信号');
        return;
      }
      const num = (n: number | undefined, digits = 2) =>
        n === undefined || !Number.isFinite(n) ? '' : n.toFixed(digits);
      const statusText = (s: PortfolioSignalRow) =>
        s.status === 'filled' ? '已成交' : s.status === 'rejected' ? '被拒绝' : (s.skipReason || '未成交');
      const rowsOut: (string | number)[][] = [
        ['日期', '方向', '代码', '名称', '信号价', '组合执行', '成交股数', '费用', '盈亏', '策略原因'],
      ];
      for (const s of all) {
        rowsOut.push([
          s.date,
          s.action === 'BUY' ? '买入' : '卖出',
          s.symbol,
          csvCell(s.name ?? ''),
          num(s.price),
          csvCell(statusText(s)),
          s.shares ?? '',
          num(s.fee),
          num(s.pnl),
          csvCell(s.reason ?? ''),
        ]);
      }
      downloadCsv(`${fileBase}.csv`, rowsOut);
    } catch (err) {
      setError(err instanceof Error ? err.message : '信号导出失败');
    } finally {
      setExporting(false);
    }
  }, [jobId, action, symbol, fileBase]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-3 py-2.5">
        <div className="flex rounded-lg border border-zinc-800 bg-zinc-950/60 p-0.5">
          {(
            [
              ['ALL', '全部'],
              ['BUY', '买入'],
              ['SELL', '卖出'],
              ['SKIPPED', '未成交'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setAction(v)}
              className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition cursor-pointer ${
                action === v ? 'bg-blue-500/20 text-blue-300' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <form
          className="relative min-w-[180px] flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            setSymbol(symbolInput.trim().toUpperCase());
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
          <input
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
            placeholder="按标的筛选, 回车确认 (如 000001.SZ)"
            className={`${inputCls} py-1.5 pl-8 pr-14`}
          />
          {symbolInput && (
            <button
              type="button"
              onClick={() => {
                setSymbolInput('');
                setSymbol('');
              }}
              className="absolute right-1.5 top-1/2 flex h-5 items-center rounded px-1.5 text-[10px] text-zinc-500 hover:text-zinc-200 cursor-pointer"
            >
              清除
            </button>
          )}
        </form>

        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
        <span className="text-[10px] font-mono text-zinc-500">{count} 条信号</span>
        <button
          onClick={() => void handleExport()}
          disabled={exporting || count === 0}
          title="导出当前筛选的全部信号"
          className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-[10px] font-semibold text-zinc-300 transition hover:border-zinc-600 hover:text-zinc-100 disabled:opacity-40 cursor-pointer"
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          导出 CSV
        </button>
      </div>

      {error && <div className="px-3 py-3 text-[11px] text-red-400">{error}</div>}

      <div className="max-h-[460px] overflow-auto">
        <table className="w-full min-w-[980px] text-left">
          <thead className="sticky top-0 z-10 bg-zinc-900/95 backdrop-blur">
            <tr className="border-b border-zinc-800">
              <th className={thCls}>日期</th>
              <th className={thCls}>标的</th>
              <th className={thCls}>方向</th>
              <th className={`${thCls} text-right`}>信号价</th>
              <th className={thCls}>组合执行</th>
              <th className={`${thCls} text-right`}>成交股数</th>
              <th className={`${thCls} text-right`}>费用</th>
              <th className={`${thCls} text-right`}>盈亏</th>
              <th className={thCls}>策略原因</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s, i) => (
              <tr key={`${s.date}-${s.symbol}-${s.action}-${i}`} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                <td className={`${tdCls} font-mono text-zinc-400`}>{s.date}</td>
                <td className={tdCls}>
                  <SymbolCell symbol={s.symbol} name={s.name} onSelect={onSelectSymbol} />
                </td>
                <td className={tdCls}>
                  <SideBadge side={s.action} />
                </td>
                <td className={`${tdCls} text-right font-mono`}>{num(s.price)}</td>
                <td className={tdCls}>
                  <SignalStatus row={s} />
                </td>
                <td className={`${tdCls} text-right font-mono text-zinc-400`}>
                  {s.shares === undefined ? '--' : intFmt.format(s.shares)}
                </td>
                <td className={`${tdCls} text-right font-mono text-amber-400/80`}>
                  {s.fee === undefined ? '--' : num(s.fee)}
                </td>
                <td className={`${tdCls} text-right font-mono ${upDown(s.pnl)}`}>
                  {s.pnl === undefined ? '--' : money(s.pnl)}
                </td>
                <td className={`${tdCls} max-w-[320px] truncate text-zinc-500`} title={s.reason}>
                  {s.reason || '--'}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-10 text-center text-xs text-zinc-600">
                  没有符合条件的信号
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between border-t border-zinc-800/80 px-3 py-2">
          <span className="text-[10px] font-mono text-zinc-500">
            第 {Math.floor(offset / SIGNAL_PAGE_SIZE) + 1}/{pages} 页
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setOffset((o) => Math.max(0, o - SIGNAL_PAGE_SIZE))}
              disabled={offset === 0}
              className="rounded-md border border-zinc-800 p-1 text-zinc-400 transition hover:text-zinc-100 disabled:opacity-30 cursor-pointer"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setOffset((o) => Math.min((pages - 1) * SIGNAL_PAGE_SIZE, o + SIGNAL_PAGE_SIZE))}
              disabled={offset >= (pages - 1) * SIGNAL_PAGE_SIZE}
              className="rounded-md border border-zinc-800 p-1 text-zinc-400 transition hover:text-zinc-100 disabled:opacity-30 cursor-pointer"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 标的排行 / 当前持仓
// ---------------------------------------------------------------------------

type SymbolSortKey = keyof Pick<
  PortfolioSymbolStat,
  'realizedPnl' | 'realizedReturnPercent' | 'winRate' | 'closedTrades' | 'fees' | 'buys'
>;

function SymbolTable({ rows, onSelectSymbol }: { rows: PortfolioSymbolStat[]; onSelectSymbol?: SelectSymbol }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SymbolSortKey; dir: 'asc' | 'desc' }>({
    key: 'realizedPnl',
    dir: 'desc',
  });

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    const list = rows.filter(
      (r) =>
        !q ||
        r.symbol.toUpperCase().includes(q) ||
        (r.name ?? '').toUpperCase().includes(q) ||
        (r.industry ?? '').toUpperCase().includes(q),
    );
    return list.sort((a, b) => {
      const av = Number(a[sort.key] ?? 0);
      const bv = Number(b[sort.key] ?? 0);
      return sort.dir === 'desc' ? bv - av : av - bv;
    });
  }, [rows, query, sort]);

  if (rows.length === 0) {
    return <div className="px-3 py-10 text-center text-xs text-zinc-600">没有标的数据</div>;
  }

  const header = (key: SymbolSortKey, label: string) => (
    <button
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
      className={`inline-flex items-center gap-0.5 transition hover:text-zinc-300 cursor-pointer ${
        sort.key === key ? 'text-blue-400' : ''
      }`}
    >
      {label}
      {sort.key === key && (sort.dir === 'desc' ? <ArrowDownRight className="h-2.5 w-2.5" /> : <ArrowUpRight className="h-2.5 w-2.5" />)}
    </button>
  );

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-2.5">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-600" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="代码 / 名称 / 板块"
            className={`${inputCls} py-1.5 pl-8`}
          />
        </div>
        <span className="text-[10px] font-mono text-zinc-500">{filtered.length} 只</span>
      </div>

      <div className="max-h-[460px] overflow-auto">
        <table className="w-full min-w-[880px] text-left">
          <thead className="sticky top-0 z-10 bg-zinc-900/95 backdrop-blur">
            <tr className="border-b border-zinc-800">
              <th className={thCls}>标的</th>
              <th className={thCls}>板块</th>
              <th className={`${thCls} text-right`}>{header('buys', '买入')}</th>
              <th className={`${thCls} text-right`}>卖出</th>
              <th className={`${thCls} text-right`}>{header('closedTrades', '平仓')}</th>
              <th className={`${thCls} text-right`}>{header('winRate', '胜率')}</th>
              <th className={`${thCls} text-right`}>{header('realizedPnl', '已实现盈亏')}</th>
              <th className={`${thCls} text-right`}>{header('realizedReturnPercent', '收益率')}</th>
              <th className={`${thCls} text-right`}>{header('fees', '费用')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.symbol} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
                <td className={tdCls}>
                  <SymbolCell symbol={s.symbol} name={s.name} onSelect={onSelectSymbol} />
                </td>
                <td className={`${tdCls} max-w-[220px] truncate text-zinc-500`} title={s.industry}>
                  {s.industry ?? '--'}
                </td>
                <td className={`${tdCls} text-right font-mono text-zinc-400`}>{s.buys}</td>
                <td className={`${tdCls} text-right font-mono text-zinc-400`}>{s.sells}</td>
                <td className={`${tdCls} text-right font-mono text-zinc-400`}>{s.closedTrades}</td>
                <td className={`${tdCls} text-right font-mono text-zinc-300`}>
                  {s.closedTrades > 0 ? `${s.winRate.toFixed(1)}%` : '--'}
                </td>
                <td className={`${tdCls} text-right font-mono ${upDown(s.realizedPnl)}`}>{money(s.realizedPnl)}</td>
                <td className={`${tdCls} text-right font-mono ${upDown(s.realizedReturnPercent)}`}>
                  {pct(s.realizedReturnPercent)}
                </td>
                <td className={`${tdCls} text-right font-mono text-zinc-500`}>{num(s.fees)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PositionsTable({
  rows,
  onSelectSymbol,
}: {
  rows: PortfolioOpenPosition[];
  onSelectSymbol?: SelectSymbol;
}) {
  if (rows.length === 0) {
    return <div className="px-3 py-10 text-center text-xs text-zinc-600">期末无持仓 (全部为现金)</div>;
  }
  return (
    <div className="max-h-[460px] overflow-auto">
      <table className="w-full min-w-[760px] text-left">
        <thead className="sticky top-0 z-10 bg-zinc-900/95 backdrop-blur">
          <tr className="border-b border-zinc-800">
            <th className={thCls}>标的</th>
            <th className={`${thCls} text-right`}>股数</th>
            <th className={`${thCls} text-right`}>成本价</th>
            <th className={`${thCls} text-right`}>现价</th>
            <th className={`${thCls} text-right`}>市值</th>
            <th className={`${thCls} text-right`}>权重</th>
            <th className={`${thCls} text-right`}>浮动盈亏</th>
            <th className={thCls}>建仓日</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.symbol} className="border-b border-zinc-800/50 hover:bg-zinc-800/20">
              <td className={tdCls}>
                <SymbolCell symbol={p.symbol} name={p.name} onSelect={onSelectSymbol} />
              </td>
              <td className={`${tdCls} text-right font-mono`}>{intFmt.format(p.shares)}</td>
              <td className={`${tdCls} text-right font-mono`}>{num(p.avgCost)}</td>
              <td className={`${tdCls} text-right font-mono`}>{num(p.price)}</td>
              <td className={`${tdCls} text-right font-mono`}>{compactMoney(p.marketValue)}</td>
              <td className={`${tdCls} text-right font-mono text-zinc-400`}>{p.weightPercent.toFixed(1)}%</td>
              <td className={`${tdCls} text-right font-mono ${upDown(p.pnl)}`}>
                {money(p.pnl)}
                <span className="ml-1 text-[10px] opacity-80">({pct(p.pnlPercent)})</span>
              </td>
              <td className={`${tdCls} font-mono text-zinc-500`}>{p.entryDate}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 进度卡
// ---------------------------------------------------------------------------

const PHASES = [
  { key: 'fetching', label: '拉取历史数据' },
  { key: 'generating-signals', label: '生成逐日信号' },
  { key: 'simulating', label: 'backtrader 撮合' },
  { key: 'done', label: '完成' },
] as const;

function ProgressCard({ job, onCancel }: { job: PortfolioSimulationJobView; onCancel: () => void }) {
  const p = job.progress;
  const activeIndex = Math.max(0, PHASES.findIndex((x) => x.key === p.phase));
  const ratio =
    p.phase === 'fetching' || p.phase === 'generating-signals'
      ? p.total > 0
        ? p.done / p.total
        : 0
      : p.phase === 'simulating'
        ? p.simulationTotalDays > 0
          ? p.simulationDay / p.simulationTotalDays
          : 0
        : p.phase === 'done'
          ? 1
          : 0;

  return (
    <section className={`${cardCls} overflow-hidden`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-blue-500/25 bg-blue-500/15">
          <Loader2 className={`h-4 w-4 text-blue-400 ${job.state === 'running' ? 'animate-spin' : ''}`} />
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-zinc-200">组合模拟进行中</p>
          <p className="truncate text-[10px] text-zinc-500">{p.message}</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="font-mono text-[10px] text-zinc-500">
            {job.id} · {Math.round((p.updatedAt - p.startedAt) / 1000)}s
          </span>
          <button
            onClick={onCancel}
            className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/60 px-2.5 py-1.5 text-[10px] font-semibold text-zinc-300 transition hover:border-red-500/40 hover:text-red-300 cursor-pointer"
          >
            <Square className="h-3 w-3" />
            中断
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {PHASES.map((phase, i) => (
            <div key={phase.key} className="flex items-center gap-1.5">
              <span
                className={`rounded-md px-2 py-1 text-[10px] font-mono ${
                  i === activeIndex
                    ? 'bg-blue-500/20 text-blue-300'
                    : i < activeIndex
                      ? 'bg-emerald-500/10 text-emerald-300/80'
                      : 'bg-zinc-800/60 text-zinc-500'
                }`}
              >
                {i < activeIndex ? '✓ ' : ''}
                {phase.label}
              </span>
              {i < PHASES.length - 1 && <span className="text-zinc-700">→</span>}
            </div>
          ))}
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all"
            style={{ width: `${Math.min(100, Math.max(2, ratio * 100))}%` }}
          />
        </div>

        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-zinc-500">
          <span>标的 {p.done}/{p.total}</span>
          <span>缓存命中 {p.cached}</span>
          <span>新拉取 {p.fetched}</span>
          {p.failed > 0 && <span className="text-amber-400">失败 {p.failed}</span>}
          <span>信号 {p.signals}</span>
          {(p.signalCached > 0 || p.signalExtended > 0 || p.signalComputed > 0) && (
            <span className="text-emerald-400/80">
              信号 整段命中 {p.signalCached} · 增量续算 {p.signalExtended} · 新计算 {p.signalComputed}
            </span>
          )}
          {p.simulationTotalDays > 0 && (
            <span>
              撮合 {p.simulationDay}/{p.simulationTotalDays} 日
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export default function PortfolioSimulationView({
  onModeChange,
}: {
  onModeChange?: (mode: 'single' | 'pool') => void;
}) {
  const [config, setConfig] = useState<PoolConfig>(DEFAULT_CONFIG);
  const [customInput, setCustomInput] = useState('');
  const [strategies, setStrategies] = useState<StrategyListItem[]>([]);
  const [strategyId, setStrategyId] = useState('');
  const [paramValues, setParamValues] = useState<Record<string, string | boolean>>({});
  const [strategiesError, setStrategiesError] = useState('');
  const [sourceOpen, setSourceOpen] = useState(false);
  const [health, setHealth] = useState<SimulationEngineHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const [jobId, setJobId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(POOL_JOB_KEY);
    } catch {
      return null;
    }
  });
  const [job, setJob] = useState<PortfolioSimulationJobView | null>(null);
  const [resultTab, setResultTab] = useState<'trades' | 'signals' | 'symbols' | 'positions' | 'diagnostics'>('trades');
  /** K 线抽屉当前标的 (null = 关闭) */
  const [chartTarget, setChartTarget] = useState<{ symbol: string; name?: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const selectedStrategy = useMemo(
    () => strategies.find((s) => s.id === strategyId) ?? null,
    [strategies, strategyId],
  );

  const poolCount = useMemo(
    () =>
      POOL_OPTIONS.reduce((sum, o) => sum + (config.indexes[o.id] ? o.count : 0), 0) + config.custom.length,
    [config.indexes, config.custom.length],
  );

  // ---- 成分股名单 (仅用于「排除板块」后的精确只数预览) ----
  const [members, setMembers] = useState<Partial<Record<IndexId, string[]>>>({});
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
            /* 拿不到名单时退回静态估算 */
          }
        }),
      );
      if (!cancelled) setMembers(out);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 排除板块后的股票池预览: 优先用真实成分股名单精确计数,
   * 名单未加载成功时退回「静态只数 × 粗略比例」的估算。
   */
  const poolPreview = useMemo(() => {
    const exclude = config.excludeBoards;
    let base = 0;
    let kept = 0;
    for (const o of POOL_OPTIONS) {
      if (!config.indexes[o.id]) continue;
      const list = members[o.id];
      if (list && list.length > 0) {
        base += list.length;
        kept += exclude.length ? list.filter((s) => !isBoardExcluded(s, exclude)).length : list.length;
      } else {
        base += o.count;
        kept += o.count;
      }
    }
    const customKept = exclude.length
      ? config.custom.filter((s) => !isBoardExcluded(s, exclude)).length
      : config.custom.length;
    const exact = POOL_OPTIONS.some((o) => config.indexes[o.id] && (members[o.id]?.length ?? 0) > 0);
    return {
      total: base + config.custom.length,
      kept: kept + customKept,
      excluded: base + config.custom.length - (kept + customKept),
      exact,
    };
  }, [config.indexes, config.custom, config.excludeBoards, members]);

  const toggleBoard = (id: ExcludableBoard) =>
    setConfig((prev) => ({
      ...prev,
      excludeBoards: prev.excludeBoards.includes(id)
        ? prev.excludeBoards.filter((b) => b !== id)
        : [...prev.excludeBoards, id],
    }));

  // ---- 策略列表 ----
  const loadStrategies = useCallback(async () => {
    try {
      const r = await fetch('/api/strategies');
      const data = await r.json();
      const list: StrategyListItem[] = data?.strategies ?? [];
      setStrategies(list);
      setStrategyId((prev) => (prev && list.some((s) => s.id === prev) ? prev : list[0]?.id ?? ''));
      setStrategiesError('');
    } catch (err) {
      setStrategiesError(err instanceof Error ? err.message : '策略列表加载失败');
    }
  }, []);

  useEffect(() => {
    void loadStrategies();
    fetch('/api/simulation/health')
      .then((r) => r.json())
      .then((h: SimulationEngineHealth) => setHealth(h))
      .catch(() => setHealth({ ready: false, python: '', error: '执行引擎健康检查失败' }));
  }, [loadStrategies]);

  // 策略切换 → 参数回到默认值
  useEffect(() => {
    if (!selectedStrategy) return;
    const next: Record<string, string | boolean> = {};
    for (const p of selectedStrategy.params ?? []) {
      next[p.key] = p.type === 'boolean' ? Boolean(p.defaultValue) : String(p.defaultValue ?? '');
    }
    setParamValues(next);
  }, [selectedStrategy?.id]);

  // ---- 任务轮询 ----
  useEffect(() => {
    try {
      if (jobId) localStorage.setItem(POOL_JOB_KEY, jobId);
      else localStorage.removeItem(POOL_JOB_KEY);
    } catch {
      /* ignore */
    }
  }, [jobId]);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return;
    }
    let stopped = false;

    const tick = async () => {
      try {
        const r = await fetch(`/api/simulation/${jobId}`);
        if (r.status === 404) {
          if (!stopped) {
            setJob(null);
            setJobId(null);
          }
          return;
        }
        if (!r.ok) throw new Error(`状态查询失败 (${r.status})`);
        const view: PortfolioSimulationJobView = await r.json();
        if (stopped) return;
        setJob(view);
        setError(view.state === 'error' ? view.error ?? '组合模拟失败' : null);
        if (view.state !== 'running' && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch (err) {
        if (stopped) return;
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setError(err instanceof Error ? err.message : '任务状态查询失败');
      }
    };

    void tick();
    pollRef.current = setInterval(() => void tick(), 1500);
    return () => {
      stopped = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobId]);

  // ---- 自定义标的 ----
  const addCustom = () => {
    const parts = customInput
      .split(/[,，\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = new Set(config.custom);
    const invalid: string[] = [];
    for (const raw of parts) {
      const m = /^(\d{6})(?:\.(SH|SZ|SS))?$/.exec(raw);
      if (!m) {
        invalid.push(raw);
        continue;
      }
      const code = m[1];
      const suffix = m[2] === 'SS' ? 'SH' : m[2] ?? (/^(60|68|90)/.test(code) ? 'SH' : 'SZ');
      next.add(`${code}.${suffix}`);
    }
    setConfig((prev) => ({ ...prev, custom: [...next] }));
    setCustomInput('');
    if (invalid.length > 0) setError(`已忽略非 A 股代码: ${invalid.join(', ')}`);
  };

  // ---- 发起模拟 ----
  const buildParams = (): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {};
    for (const p of selectedStrategy?.params ?? []) {
      const raw = paramValues[p.key];
      if (p.type === 'boolean') out[p.key] = Boolean(raw);
      else if (p.type === 'number') {
        const n = Number(raw);
        if (Number.isFinite(n)) out[p.key] = n;
      } else if (typeof raw === 'string' && raw !== '') {
        out[p.key] = raw;
      }
    }
    return out;
  };

  const startSimulation = async () => {
    setError(null);
    if (!strategyId) {
      setError('请先选择策略');
      return;
    }
    const indexes = POOL_OPTIONS.filter((o) => config.indexes[o.id]).map((o) => o.id);
    if (indexes.length === 0 && config.custom.length === 0) {
      setError('请至少选择一个股票池或添加自定义标的');
      return;
    }
    if (config.rangeStart && config.rangeEnd && config.rangeStart > config.rangeEnd) {
      setError('开始日期不能晚于结束日期');
      return;
    }

    const input: PortfolioSimulationInput = {
      strategyId,
      indexes,
      custom: config.custom,
      excludeBoards: config.excludeBoards,
      adjust: config.adjust,
      initialCash: Number(config.initialCash) || 100_000,
      maxPositions: Number(config.maxPositions) || 10,
      positionPercent: Number(config.positionPercent) || 10,
      commissionRate: (Number(config.commissionWan) || 2.5) / 10_000,
      minCommission: Number(config.minCommission) || 5,
      benchmark: config.benchmark,
      force: config.forceRefresh,
      params: buildParams(),
    };
    if (config.stopLoss) input.stopLossPercent = Number(config.stopLoss);
    if (config.rangeStart) input.rangeStart = config.rangeStart;
    if (config.rangeEnd) input.rangeEnd = config.rangeEnd;
    if (config.rotationEnabled) {
      input.rotationEnabled = true;
      input.rotationMinScoreDelta = Number(config.rotationMinScoreDelta) || 1;
      input.rotationMaxPerDay = Number(config.rotationMaxPerDay) || 2;
    }

    setStarting(true);
    try {
      const resp = await fetch('/api/simulation/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await resp.json();
      if (!resp.ok) {
        if (resp.status === 409 && data?.jobId) {
          // 已有任务在跑: 直接挂到该任务上观察进度
          setJobId(data.jobId);
          setError(data.error ?? null);
          return;
        }
        throw new Error(data?.error || `发起失败 (${resp.status})`);
      }
      setResultTab('trades');
      setJobId(data.jobId);
      setJob(data.job ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '组合模拟发起失败');
    } finally {
      setStarting(false);
    }
  };

  const cancelSimulation = async () => {
    if (!jobId) return;
    try {
      await fetch(`/api/simulation/${jobId}/cancel`, { method: 'POST' });
    } catch {
      /* 轮询会同步最终状态 */
    }
  };

  const result = job?.state === 'done' ? job.result ?? null : null;
  const running = job?.state === 'running';
  const engineReady = health?.ready !== false;

  // 点击账本/排行里的标的 → 右侧 K 线抽屉 (与分析页同款图表, 叠加该股本次模拟成交)
  const tradesBySymbol = useMemo(() => {
    const map = new Map<string, BacktestTrade[]>();
    if (!result) return map;
    result.trades.forEach((t, i) => {
      const trade: BacktestTrade = {
        id: `${t.symbol}-${t.date}-${t.side}-${i}`,
        type: t.side,
        signalType: 'portfolio-simulation',
        reason: t.reason,
        price: t.price,
        date: t.date,
        shares: t.shares,
        value: t.value,
        fee: t.fee,
        pnl: t.pnl,
        pnlPercent: t.pnlPercent,
      };
      const list = map.get(t.symbol);
      if (list) list.push(trade);
      else map.set(t.symbol, [trade]);
    });
    return map;
  }, [result]);

  const openSymbolChart = useCallback<SelectSymbol>((symbol, name) => {
    setChartTarget({ symbol, name });
  }, []);

  return (
    <div className="mx-auto w-full max-w-[1560px]">
      {/* ================= 页头 ================= */}
      <section className="relative overflow-hidden rounded-2xl border border-zinc-800/80 bg-gradient-to-br from-zinc-900/90 via-zinc-900/40 to-zinc-950 px-4 py-3">
        <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-blue-500/10 blur-3xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-blue-500/25 bg-blue-500/15">
              <FlaskConical className="h-4 w-4 text-blue-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold tracking-tight text-zinc-100 md:text-base">策略模拟 · 组合资金</h2>
              <p className="truncate text-[10px] text-zinc-500 md:text-[11px]">
                共享资金逐日撮合 · 信号当日收盘价成交 · T+1 · 涨跌停拦截 · 佣金 + 印花税 + 过户费
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/70 px-2 py-1 text-[10px] font-mono text-zinc-500 md:flex">
              <Activity className="h-3 w-3 text-zinc-600" />
              {engineReady ? `backtrader ${health?.version ?? ''}` : '执行引擎未就绪'}
            </span>
            <div className="flex rounded-xl border border-zinc-800 bg-zinc-900/80 p-1">
              <button
                onClick={() => onModeChange?.('single')}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-zinc-400 transition hover:text-zinc-200 cursor-pointer"
              >
                <Target className="h-3.5 w-3.5" />
                单标的
              </button>
              <button
                className="flex items-center gap-1.5 rounded-lg bg-blue-500/20 px-3 py-1.5 text-xs font-semibold text-blue-300 cursor-pointer"
                onClick={() => onModeChange?.('pool')}
              >
                <Layers className="h-3.5 w-3.5" />
                组合模拟
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ================= 双栏 ================= */}
      <div className="mt-4 grid grid-cols-1 gap-4 md:mt-5 md:grid-cols-[300px_minmax(0,1fr)] md:items-start lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]">
        {/* ---------- 左栏: 配置 ---------- */}
        <aside className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-[64px] xl:max-h-[calc(100vh_-_180px)]">
          <div className="flex flex-col gap-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
            {/* 1. 股票池 */}
            <section className={`${cardCls} p-3.5`}>
              <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                <Layers className="h-3.5 w-3.5 text-blue-400" />
                股票池
                <span className="ml-auto font-normal normal-case tracking-normal text-zinc-600">一次资金账户</span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {POOL_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    onClick={() =>
                      setConfig((prev) => ({
                        ...prev,
                        indexes: { ...prev.indexes, [o.id]: !prev.indexes[o.id] },
                      }))
                    }
                    className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition cursor-pointer ${
                      config.indexes[o.id]
                        ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                        : 'border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {o.label}
                    <span className="font-mono text-[10px] opacity-70">{o.count}</span>
                  </button>
                ))}
                <button
                  onClick={() =>
                    setConfig((prev) => {
                      const all = prev.indexes.hs300 && prev.indexes.zz500;
                      return { ...prev, indexes: { hs300: !all, zz500: !all } };
                    })
                  }
                  className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition cursor-pointer ${
                    config.indexes.hs300 && config.indexes.zz500
                      ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                      : 'border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  全部
                  <span className="font-mono text-[10px] opacity-70">800</span>
                </button>
              </div>

              {/* 排除板块: 创业板 / 科创板 / 北交所 */}
              <div className="mt-2.5">
                <label className={labelCls}>排除板块</label>
                <div className="flex flex-wrap items-center gap-2">
                  {EXCLUDABLE_BOARDS.map((b) => {
                    const on = config.excludeBoards.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        onClick={() => toggleBoard(b.id)}
                        title={`排除 ${b.label} (${b.hint})`}
                        className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition cursor-pointer ${
                          on
                            ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                            : 'border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        {on ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                        {b.label}
                        <span className="font-mono text-[10px] opacity-70">{b.hint}</span>
                      </button>
                    );
                  })}
                  {config.excludeBoards.length > 0 && (
                    <button
                      onClick={() => setConfig((prev) => ({ ...prev, excludeBoards: [] }))}
                      className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-2 py-1.5 text-[10px] text-zinc-500 transition hover:text-zinc-200 cursor-pointer"
                    >
                      清空
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">
                  按代码前缀剔除, 在「取前 N 只」之前生效; 影响股票池、信号生成与撮合全链路。
                </p>
              </div>

              <div className="mt-2.5 flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3 py-2">
                <span className="text-[10px] text-zinc-500">本次模拟宇宙</span>
                <span className="font-mono text-xs font-bold text-zinc-200">
                  {config.excludeBoards.length > 0 ? `${poolPreview.exact ? '' : '≈'}${poolPreview.kept}` : poolCount} 只
                  <span className="ml-1.5 text-[10px] font-normal text-zinc-500">
                    {config.indexes.hs300 ? '沪深300' : ''}
                    {config.indexes.hs300 && config.indexes.zz500 ? ' + ' : ''}
                    {config.indexes.zz500 ? '中证500' : ''}
                    {config.custom.length > 0 ? ` + 自定义 ${config.custom.length}` : ''}
                    {config.excludeBoards.length > 0 && poolPreview.excluded > 0
                      ? ` · 已排除 ${poolPreview.excluded} 只`
                      : ''}
                  </span>
                </span>
              </div>

              <div className="mt-2.5">
                <label className={labelCls}>附加自定义标的</label>
                <div className="flex gap-2">
                  <input
                    value={customInput}
                    onChange={(e) => setCustomInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addCustom();
                      }
                    }}
                    placeholder="6 位代码, 逗号分隔, 回车添加"
                    className={inputCls}
                  />
                  <button
                    onClick={addCustom}
                    disabled={!customInput.trim()}
                    className="flex shrink-0 items-center gap-1 rounded-xl border border-zinc-700 bg-zinc-800 px-3 text-xs font-semibold text-zinc-200 transition hover:bg-zinc-700 disabled:opacity-40 cursor-pointer"
                  >
                    <Plus className="h-3 w-3" />
                    添加
                  </button>
                </div>
                {config.custom.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {config.custom.map((s) => (
                      <span
                        key={s}
                        className="flex items-center gap-1 rounded-lg border border-zinc-700/80 bg-zinc-900 px-2 py-1 font-mono text-[10px] text-zinc-300"
                      >
                        {s}
                        <button
                          onClick={() =>
                            setConfig((prev) => ({ ...prev, custom: prev.custom.filter((c) => c !== s) }))
                          }
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
            </section>

            {/* 2. 区间与复权 */}
            <section className={`${cardCls} p-3.5`}>
              <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                <Gauge className="h-3.5 w-3.5 text-blue-400" />
                区间与数据
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>开始</label>
                  <input
                    type="date"
                    value={config.rangeStart}
                    onChange={(e) => setConfig((prev) => ({ ...prev, rangeStart: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>结束</label>
                  <input
                    type="date"
                    value={config.rangeEnd}
                    onChange={(e) => setConfig((prev) => ({ ...prev, rangeEnd: e.target.value }))}
                    className={inputCls}
                  />
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>复权</label>
                  <select
                    value={config.adjust}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, adjust: e.target.value as PoolConfig['adjust'] }))
                    }
                    className={inputCls}
                  >
                    <option value="forward">前复权</option>
                    <option value="backward">后复权</option>
                    <option value="">不复权</option>
                  </select>
                </div>
                <label className="mt-4 flex items-center gap-2 text-[11px] text-zinc-400">
                  <input
                    type="checkbox"
                    checked={config.forceRefresh}
                    onChange={(e) => setConfig((prev) => ({ ...prev, forceRefresh: e.target.checked }))}
                    className="h-3.5 w-3.5 accent-blue-500"
                  />
                  强制刷新行情
                </label>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
                历史数据沿用服务端磁盘缓存与增量更新; 未勾选强制刷新时只补最新交易日。
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">
                逐日信号按「策略 + 参数 + K 线指纹 + 区间」落盘缓存: 只改资金/仓位/止损/费用/基准时直接复用,
                无需重算; 勾选强制刷新会连信号缓存一起跳过。
              </p>
            </section>

            {/* 3. 组合参数 */}
            <section className={`${cardCls} p-3.5`}>
              <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                <Wallet className="h-3.5 w-3.5 text-blue-400" />
                组合参数
                <span className="ml-auto font-normal normal-case tracking-normal text-zinc-600">共享现金</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelCls}>初始资金 (¥)</label>
                  <input
                    type="number"
                    min={1000}
                    step={1000}
                    value={config.initialCash}
                    onChange={(e) => setConfig((prev) => ({ ...prev, initialCash: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>最大持仓数</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={config.maxPositions}
                    onChange={(e) => setConfig((prev) => ({ ...prev, maxPositions: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>单只仓位 (%)</label>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={config.positionPercent}
                    onChange={(e) => setConfig((prev) => ({ ...prev, positionPercent: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>固定止损 (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={99}
                    step={1}
                    value={config.stopLoss}
                    onChange={(e) => setConfig((prev) => ({ ...prev, stopLoss: e.target.value }))}
                    placeholder="留空不启用"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>佣金 (万分之)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={config.commissionWan}
                    onChange={(e) => setConfig((prev) => ({ ...prev, commissionWan: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>最低佣金 (¥)</label>
                  <input
                    type="number"
                    min={0}
                    step={0.5}
                    value={config.minCommission}
                    onChange={(e) => setConfig((prev) => ({ ...prev, minCommission: e.target.value }))}
                    className={inputCls}
                  />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>组合基准</label>
                  <select
                    value={config.benchmark}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, benchmark: e.target.value as PortfolioBenchmarkId }))
                    }
                    className={inputCls}
                  >
                    {BENCHMARK_OPTIONS.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.label} — {b.hint}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <input
                      type="checkbox"
                      checked={config.rotationEnabled}
                      onChange={(e) => setConfig((prev) => ({ ...prev, rotationEnabled: e.target.checked }))}
                      className="h-3.5 w-3.5 accent-blue-500"
                    />
                    启用轮动换仓 (持仓满时卖弱买强)
                  </label>
                </div>
                {config.rotationEnabled && (
                  <>
                    <div>
                      <label className={labelCls}>轮动最小分数优势</label>
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={config.rotationMinScoreDelta}
                        onChange={(e) =>
                          setConfig((prev) => ({ ...prev, rotationMinScoreDelta: e.target.value }))
                        }
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className={labelCls}>每日最多轮动 (只)</label>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        step={1}
                        value={config.rotationMaxPerDay}
                        onChange={(e) => setConfig((prev) => ({ ...prev, rotationMaxPerDay: e.target.value }))}
                        className={inputCls}
                      />
                    </div>
                  </>
                )}
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
                买入按「单只仓位 × 组合权益」分配, 同日多信号按置信度排序竞争现金; 卖出释放资金。印花税 0.1% (仅卖出)、过户费 0.001%。
                <br />
                轮动仅对带「Rotation」字样的策略生效 (它们对每只标的给出横截面吸引力分数); 其他策略开启后无候选分数, 行为与未开启一致。
              </p>
            </section>

            {/* 4. 策略 */}
            <section className={`${cardCls} p-3.5`}>
              <div className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
                <ListChecks className="h-3.5 w-3.5 text-blue-400" />
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
                    title="重新加载策略"
                  >
                    <RefreshCw className="h-3 w-3" />
                  </button>
                </div>
              </div>

              {strategiesError && <p className="mb-2 text-[10px] text-red-400">{strategiesError}</p>}

              <select
                value={strategyId}
                onChange={(e) => {
                  const id = e.target.value;
                  setStrategyId(id);
                  // 轮动策略只有在组合层开启轮动时才不等于基线, 切换过去时默认打开
                  if (id.endsWith('-rotation')) {
                    setConfig((prev) => ({ ...prev, rotationEnabled: true }));
                  }
                }}
                className={inputCls}
              >
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {selectedStrategy?.description && (
                <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-600">{selectedStrategy.description}</p>
              )}
              {strategyId.endsWith('-rotation') && !config.rotationEnabled && (
                <p className="mt-1.5 text-[10px] text-amber-400">
                  该策略需在「组合参数」中勾选「启用轮动换仓」, 否则结果与基线策略相同。
                </p>
              )}

              {(selectedStrategy?.params?.length ?? 0) > 0 && (
                <div className="mt-2.5 grid grid-cols-2 gap-2">
                  {selectedStrategy!.params!.map((p) => (
                    <div key={p.key} className={p.type === 'boolean' ? 'col-span-2' : ''}>
                      {p.type === 'boolean' ? (
                        <label className="flex items-center gap-2 text-[11px] text-zinc-400">
                          <input
                            type="checkbox"
                            checked={Boolean(paramValues[p.key])}
                            onChange={(e) =>
                              setParamValues((prev) => ({ ...prev, [p.key]: e.target.checked }))
                            }
                            className="h-3.5 w-3.5 accent-blue-500"
                          />
                          {p.label}
                        </label>
                      ) : p.type === 'string' && (p.options?.length ?? 0) > 0 ? (
                        <>
                          <label className={labelCls}>{p.label}</label>
                          <select
                            value={String(paramValues[p.key] ?? p.defaultValue)}
                            onChange={(e) =>
                              setParamValues((prev) => ({ ...prev, [p.key]: e.target.value }))
                            }
                            className={inputCls}
                          >
                            {p.options!.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <>
                          <label className={labelCls}>{p.label}</label>
                          <input
                            type={p.type === 'number' ? 'number' : 'text'}
                            min={p.min}
                            max={p.max}
                            step={p.step}
                            value={String(paramValues[p.key] ?? '')}
                            onChange={(e) =>
                              setParamValues((prev) => ({ ...prev, [p.key]: e.target.value }))
                            }
                            className={inputCls}
                          />
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>

          {/* 运行 */}
          <div className="shrink-0 rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-3">
            {!engineReady && (
              <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-amber-300">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  组合执行引擎未就绪: {health?.error ?? '未知错误'}
                  <br />
                  终端执行 <code className="text-amber-200">npm run sim:setup</code> 安装 backtrader。
                </span>
              </div>
            )}
            {error && (
              <div className="mb-2 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-2 text-[10px] leading-relaxed text-red-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => void startSimulation()}
                disabled={starting || running || !engineReady || strategies.length === 0}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-500 px-3 py-2.5 text-xs font-bold text-white transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                {running ? '模拟进行中…' : '开始组合模拟'}
              </button>
              {running && (
                <button
                  onClick={() => void cancelSimulation()}
                  className="flex items-center gap-1 rounded-xl border border-zinc-700 bg-zinc-800/60 px-3 text-xs font-semibold text-zinc-300 transition hover:border-red-500/40 hover:text-red-300 cursor-pointer"
                >
                  <Square className="h-3.5 w-3.5" />
                  中断
                </button>
              )}
            </div>
            <p className="mt-2 text-center text-[10px] text-zinc-600">
              策略只读截至当日的行情; 买入当日不可卖 (T+1), 涨跌停不成交。
            </p>
          </div>
        </aside>

        {/* ---------- 右栏: 进度 / 报告 ---------- */}
        <main className="flex min-w-0 flex-col gap-3">
          {!jobId && !job && (
            <section className={`${cardCls} px-5 py-14 text-center`}>
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900/60">
                <LineChartIcon className="h-7 w-7 text-zinc-700" />
              </div>
              <h3 className="mt-4 text-sm font-bold text-zinc-300">共享资金 · 逐日组合模拟</h3>
              <p className="mx-auto mt-2 max-w-xl text-[11px] leading-relaxed text-zinc-500">
                先在左侧选股票池与策略。系统会用截至当日的行情逐日给出买入/卖出信号,
                再由 backtrader 在同一个资金账户里按当日收盘价撮合, 输出组合权益、基准对比、
                逐笔成交和完整信号账本。
              </p>
              <div className="mx-auto mt-5 grid max-w-2xl grid-cols-1 gap-2 text-left sm:grid-cols-3">
                {[
                  ['1. 拉取历史数据', '沿用服务端缓存与增量更新, 只补最新交易日'],
                  ['2. 逐日生成信号', 'TS 策略 + 缠论结构, 只用截至当日的数据'],
                  ['3. 组合撮合', '共享现金、仓位上限、T+1、涨跌停、费用'],
                ].map(([title, desc]) => (
                  <div key={title} className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3">
                    <p className="text-[11px] font-bold text-zinc-300">{title}</p>
                    <p className="mt-1 text-[10px] leading-relaxed text-zinc-600">{desc}</p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {job && running && <ProgressCard job={job} onCancel={() => void cancelSimulation()} />}

          {job?.state === 'cancelled' && (
            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-[11px] text-zinc-400">
              任务已中断。可调整参数后重新开始。
            </section>
          )}

          {job?.state === 'error' && (
            <section className="rounded-2xl border border-red-500/25 bg-red-500/5 px-4 py-3">
              <p className="flex items-center gap-2 text-xs font-bold text-red-300">
                <AlertTriangle className="h-3.5 w-3.5" />
                组合模拟失败
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-red-300/80">{job.error}</p>
            </section>
          )}

          {result && job && (
            <>
              {/* 报告头 */}
              <section className={`${cardCls} px-4 py-3`}>
                <div className="flex flex-wrap items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-blue-400" />
                  <h3 className="text-sm font-bold text-zinc-100">组合报告</h3>
                  <Badge tone="blue">{result.engine.name} {result.engine.version}</Badge>
                  <span className="text-[10px] font-mono text-zinc-500">
                    {result.dateRange.start} → {result.dateRange.end} · {result.stats.tradingDays} 个交易日
                  </span>
                  <span className="ml-auto text-[10px] font-mono text-zinc-600">
                    {result.tested}/{result.universeSize} 只标的 · {result.signalCount} 条信号
                    {result.excludedCount
                      ? ` · 板块排除 ${result.excludedCount} 只`
                      : ''}
                    {typeof result.signalCacheHits === 'number' && result.signalCacheHits > 0
                      ? ` · 信号缓存命中 ${result.signalCacheHits}`
                      : ''}
                    {typeof result.signalCacheIncremental === 'number' && result.signalCacheIncremental > 0
                      ? ` · 增量续算 ${result.signalCacheIncremental}`
                      : ''}
                  </span>
                </div>
                {(result.failures.length > 0 || result.tested < result.universeSize) && (
                  <p className="mt-2 text-[10px] text-amber-400/80">
                    {result.tested < result.universeSize
                      ? `有 ${result.universeSize - result.tested} 只标的无可用行情被排除; `
                      : ''}
                    {result.failures.length > 0
                      ? `${result.failures.length} 只标的处理失败, 详见「诊断」页。`
                      : ''}
                  </p>
                )}
              </section>

              {/* KPI */}
              <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Kpi
                  label="总收益"
                  value={pct(result.stats.totalReturnPercent)}
                  sub={`年化 ${pct(result.stats.annualizedReturnPercent)}`}
                  tone={result.stats.totalReturnPercent >= 0 ? 'up' : 'down'}
                  icon={<ArrowUpRight className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label={`基准 (${result.benchmark.name})`}
                  value={pct(result.stats.benchmarkReturnPercent)}
                  sub={`超额 ${pct(result.stats.excessReturnPercent)}`}
                  tone={result.stats.excessReturnPercent >= 0 ? 'up' : 'down'}
                  icon={<Activity className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="最大回撤"
                  value={`-${num(result.stats.maxDrawdownPercent)}%`}
                  sub={`夏普 ${num(result.stats.sharpeRatio)}`}
                  tone="warn"
                  icon={<Gauge className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="期末权益"
                  value={compactMoney(result.stats.finalEquity)}
                  sub={`初始 ${compactMoney(result.stats.initialCash)}`}
                  tone="accent"
                  icon={<Wallet className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="成交 / 平仓"
                  value={`${result.stats.fills} / ${result.stats.closedTrades}`}
                  sub={`胜率 ${num(result.stats.winRate, 1)}%`}
                  icon={<ListChecks className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="总费用"
                  value={compactMoney(result.stats.totalFees)}
                  sub={`平均持仓 ${num(result.stats.avgPositions, 2)} 只`}
                  tone="warn"
                  icon={<Activity className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="仓位暴露"
                  value={`${num(result.stats.exposurePercent, 1)}%`}
                  sub={`信号 ${result.signalCount} 条`}
                  icon={<Layers className="h-3.5 w-3.5 text-zinc-600" />}
                />
                <Kpi
                  label="平均持仓 / 日"
                  value={num(result.stats.avgPositions, 2)}
                  sub={`${result.stats.tradingDays} 个交易日`}
                  icon={<LineChartIcon className="h-3.5 w-3.5 text-zinc-600" />}
                />
              </section>

              {/* 市场环境: 默认随模拟拉取的基准数据 */}
              <MarketContextPanel items={result.marketContext ?? []} />

              {/* 权益曲线 */}
              <section className={cardCls}>
                <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800/80 px-4 py-2.5">
                  <h3 className="flex items-center gap-1.5 text-xs font-bold text-zinc-300">
                    <LineChartIcon className="h-3.5 w-3.5 text-blue-400" />
                    权益曲线
                  </h3>
                  <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <span className="h-0.5 w-4 bg-blue-500" />
                    组合
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <span className="h-0.5 w-4 border-t border-dashed border-zinc-400" />
                    {result.benchmark.name}
                  </span>
                  <span className="ml-auto text-[10px] font-mono text-zinc-600">
                    最终 {compactMoney(result.stats.finalEquity)}
                  </span>
                </div>
                <div className="px-2 pb-2 pt-3">
                  <PortfolioEquityChart equity={result.equity} initial={result.stats.initialCash} />
                </div>
              </section>

              {/* 明细 */}
              <section className={`${cardCls} overflow-hidden`}>
                <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800/80 px-2 py-2">
                  {(
                    [
                      ['trades', '成交账本', result.stats.fills],
                      ['signals', '信号账本', result.signalCount],
                      ['symbols', '标的排行', result.symbolStats.length],
                      ['positions', '当前持仓', result.openPositions.length],
                      ['diagnostics', '诊断', result.diagnostics.length + result.failures.length],
                    ] as const
                  ).map(([key, label, count]) => (
                    <button
                      key={key}
                      onClick={() => setResultTab(key)}
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold transition cursor-pointer ${
                        resultTab === key
                          ? 'bg-blue-500/15 text-blue-300'
                          : 'text-zinc-500 hover:bg-zinc-800/40 hover:text-zinc-300'
                      }`}
                    >
                      {label}
                      <span className="rounded bg-zinc-800/80 px-1 font-mono text-[9px] text-zinc-500">{count}</span>
                    </button>
                  ))}
                  <span className="ml-auto hidden items-center gap-1 pr-1 text-[10px] text-zinc-600 sm:flex">
                    <ChartCandlestick className="h-3 w-3" />
                    点击标的查看 K 线
                  </span>
                </div>

                {resultTab === 'trades' && (
                  <TradesTable
                    trades={result.trades}
                    fileBase={`portfolio_trades_${result.dateRange.start}_${result.dateRange.end}`}
                    onSelectSymbol={openSymbolChart}
                  />
                )}
                {resultTab === 'signals' && (
                  <SignalsTable
                    jobId={job.id}
                    total={result.signalCount}
                    fileBase={`portfolio_signals_${result.dateRange.start}_${result.dateRange.end}`}
                    onSelectSymbol={openSymbolChart}
                  />
                )}
                {resultTab === 'symbols' && (
                  <SymbolTable rows={result.symbolStats} onSelectSymbol={openSymbolChart} />
                )}
                {resultTab === 'positions' && (
                  <PositionsTable rows={result.openPositions} onSelectSymbol={openSymbolChart} />
                )}
                {resultTab === 'diagnostics' && (
                  <div className="space-y-3 px-4 py-4">
                    {result.diagnostics.length === 0 && result.failures.length === 0 && (
                      <p className="text-xs text-zinc-600">本次模拟没有诊断信息。</p>
                    )}
                    {result.diagnostics.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                          策略诊断
                        </p>
                        <ul className="space-y-1">
                          {result.diagnostics.map((d, i) => (
                            <li key={i} className="rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-2.5 py-1.5 text-[11px] text-zinc-400">
                              <span className={d.level === 'error' ? 'text-red-400' : 'text-amber-400'}>
                                [{d.level}]
                              </span>{' '}
                              {d.date ? `${d.date} · ` : ''}
                              {d.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {result.failures.length > 0 && (
                      <div>
                        <p className="mb-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
                          处理失败 ({result.failures.length})
                        </p>
                        <ul className="space-y-1">
                          {result.failures.map((f, i) => (
                            <li key={i} className="rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-1.5 text-[11px] text-red-300/80">
                              <span className="font-mono">{f.symbol}</span> · {f.error}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </main>
      </div>

      <StockKlineDrawer
        symbol={chartTarget?.symbol ?? null}
        name={chartTarget?.name}
        trades={chartTarget ? tradesBySymbol.get(chartTarget.symbol) : undefined}
        onClose={() => setChartTarget(null)}
      />

      <StrategySourceDialog
        strategyId={strategyId}
        strategyName={selectedStrategy?.name}
        isOpen={sourceOpen}
        onClose={() => setSourceOpen(false)}
      />
    </div>
  );
}
