import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Gauge,
  Layers,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  SkipBack,
  SkipForward,
  Sliders,
  Wallet,
  Zap,
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
import {
  fetchPoolCoverage,
  fetchRustHealth,
  fetchRustPools,
  fetchRustStrategies,
  runRustSim,
} from '../utils/rustSimApi';
import SymbolDetailDrawer from './SymbolDetailDrawer';
import Select from './ui/Select';
import DateField from './ui/DateField';
import TradeFilterBar from './TradeFilterBar';
import useTradeFilter from '../hooks/useTradeFilter';
import { describeTradeFilter, isTradeFilterActive } from '../utils/tradeFilter';
import type {
  RustDay,
  RustPool,
  RustPoolCoverage,
  RustSimResult,
  RustStrategy,
  RustTrade,
} from '../types/rustSim';

// ---------------------------------------------------------------------------
// formatting helpers
// ---------------------------------------------------------------------------

// `-0` 会原样打印成 "-0"（引擎算市值时会产出 -0.0），统一归零
const fmtMoney = (v: number) =>
  (Math.abs(v) < 0.5 ? 0 : v).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const fmtPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
const fmtCompact = (v: number) =>
  Math.abs(v) >= 1e8
    ? `${(v / 1e8).toFixed(2)}亿`
    : Math.abs(v) >= 1e4
      ? `${(v / 1e4).toFixed(1)}万`
      : v.toFixed(0);

/** A-share convention: up = red, down = green. */
const upDown = (v: number) => (v >= 0 ? 'text-red-400' : 'text-green-400');

const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const shiftDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + days);
  return toIso(d);
};

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export default function RustSimulation() {
  const [strategies, setStrategies] = useState<RustStrategy[]>([]);
  const [pools, setPools] = useState<RustPool[]>([]);
  const [coverage, setCoverage] = useState<RustPoolCoverage[]>([]);
  const [framework, setFramework] = useState('barter-rs');
  const [online, setOnline] = useState<boolean | null>(null);

  const [strategyId, setStrategyId] = useState('ma-cross');
  const [selectedPools, setSelectedPools] = useState<string[]>(['hs300']);
  // 可交易范围 (与扫描页共用同一份 localStorage 设置)
  const [tradeFilter] = useTradeFilter();
  const filterActive = isTradeFilterActive(tradeFilter);
  const [params, setParams] = useState<Record<string, number>>({});
  const [initialCash, setInitialCash] = useState(20_000);
  const [minPosition, setMinPosition] = useState(5_000);
  const [stopLoss, setStopLoss] = useState(0);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RustSimResult | null>(null);

  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [tab, setTab] = useState<'decisions' | 'trades' | 'all'>('decisions');
  // 点开个股 K 线的标的（null = 弹窗关闭）
  const [detailSymbol, setDetailSymbol] = useState<string | null>(null);
  // 个股总体情况里展开买卖明细的标的
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  // The full ledger can be 15k+ fills; render it in windows instead of all at once.
  const [ledgerLimit, setLedgerLimit] = useState(200);

  // 股票名称表：引擎只给代码，名称从仓库自带的元数据里取（6 位代码 -> 名称）
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let cancelled = false;
    fetch('/merged_stock_data.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, { stock_name?: string }> | null) => {
        if (cancelled || !data) return;
        const m = new Map<string, string>();
        for (const [code, v] of Object.entries(data)) {
          if (v?.stock_name) m.set(code, v.stock_name);
        }
        setNames(m);
      })
      .catch(() => {
        /* 名称只是展示增强，取不到就不显示 */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const nameOf = (symbol: string) => names.get(symbol.split('.')[0]) ?? '';

  const activeStrategy = useMemo(
    () => strategies.find((s) => s.id === strategyId),
    [strategies, strategyId],
  );

  // Usable date span = min(first) .. max(last) across the selected pools.
  const range = useMemo(() => {
    const rows = coverage.filter((c) => selectedPools.includes(c.id));
    const firsts = rows.map((r) => r.first).filter((v): v is string => !!v).sort();
    const lasts = rows.map((r) => r.last).filter((v): v is string => !!v).sort();
    return { first: firsts[0] ?? '', last: lasts[lasts.length - 1] ?? '' };
  }, [coverage, selectedPools]);

  // --- boot ---------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [h, st, pl] = await Promise.all([
          fetchRustHealth(),
          fetchRustStrategies(),
          fetchRustPools(),
        ]);
        if (cancelled) return;
        setFramework(h.framework);
        setOnline(true);
        setStrategies(st);
        setPools(pl);
        if (st.length > 0 && !st.some((s) => s.id === strategyId)) {
          setStrategyId(st[0].id);
        }
      } catch {
        if (cancelled) return;
        // 页面只在引擎在线时才挂载（见 App.tsx），走到这里说明探测之后引擎掉了。
        setOnline(false);
        setError('回测引擎连接已断开，重启引擎后刷新页面即可恢复。');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshCoverage = useCallback(async (_ids?: string[]) => {
    try {
      const data = await fetchPoolCoverage(['hs300', 'zz500']);
      setCoverage(data.pools);
      return data.pools;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    if (!online) return;
    refreshCoverage(selectedPools);
  }, [online, selectedPools, refreshCoverage]);

  // Default the window to the full cached span once coverage is known.
  useEffect(() => {
    if (!range.first || !range.last) return;
    // The cache may reach back further than the project's fixed analysis window;
    // default to that window (2023-01-01) and let the user widen it by hand.
    const preferred = range.first < '2023-01-01' ? '2023-01-01' : range.first;
    setStartDate((prev) => (prev && prev >= range.first && prev <= range.last ? prev : preferred));
    setEndDate((prev) => (prev && prev >= range.first && prev <= range.last ? prev : range.last));
  }, [range.first, range.last]);

  // Reset parameter values to the selected strategy's defaults.
  useEffect(() => {
    if (!activeStrategy) return;
    const next: Record<string, number> = {};
    for (const p of activeStrategy.params) {
      if (typeof p.default === 'number') next[p.key] = p.default;
    }
    setParams(next);
  }, [activeStrategy]);

  // Tick a second counter while a run is in flight — a single POST can take a
  // while (data refresh + recording), and a frozen screen reads as a hang.
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [running]);

  // --- playback -----------------------------------------------------------
  const total = result?.days.length ?? 0;
  const day: RustDay | null = result ? (result.days[Math.min(cursor, total - 1)] ?? null) : null;

  // 当日变化 / 累计收益 / 持仓浮动: 全部从录制的权益曲线与持仓快照直接算, 不重跑策略
  const prevEquity = result
    ? cursor > 0
      ? result.equity[Math.min(cursor, total) - 1]
      : result.metrics.initial_cash
    : 0;
  const dayEquity = day?.equity ?? 0;
  const dayChange = {
    value: dayEquity - prevEquity,
    pct: prevEquity > 0 ? (dayEquity / prevEquity - 1) * 100 : 0,
  };
  const cumReturn =
    result && result.metrics.initial_cash > 0
      ? (dayEquity / result.metrics.initial_cash - 1) * 100
      : 0;
  const dayHoldingsPnl = day ? day.holdings.reduce((s, h) => s + h.pnl, 0) : 0;

  useEffect(() => {
    if (!playing || !result) return;
    const interval = Math.max(40, 1000 / Math.max(1, speed));
    const timer = window.setInterval(() => {
      setCursor((c) => {
        if (c >= result.days.length - 1) {
          setPlaying(false);
          return c;
        }
        return c + 1;
      });
    }, interval);
    return () => window.clearInterval(timer);
  }, [playing, result, speed]);

  // --- run ----------------------------------------------------------------
  const handleRun = useCallback(async () => {
    setRunning(true);
    setError('');
    setPlaying(false);
    try {
      const res = await runRustSim({
        strategyId,
        params,
        pools: selectedPools,
        start: startDate || undefined,
        end: endDate || undefined,
        initialCash,
        minPositionValue: minPosition,
        stopLossPercent: stopLoss > 0 ? stopLoss : undefined,
        excludeBoards: tradeFilter.boards,
      });
      setResult(res);
      setCursor(0);
    } catch (err: any) {
      setError(err?.message || '回测失败');
    } finally {
      setRunning(false);
    }
  }, [strategyId, params, selectedPools, startDate, endDate, initialCash, minPosition, stopLoss, tradeFilter]);

  // --- derived ------------------------------------------------------------
  const chartData = useMemo(() => {
    if (!result) return [];
    return result.equity_dates.map((date, i) => ({
      date,
      equity: result.equity[i],
      bh: result.bh_equity[i],
    }));
  }, [result]);

  const tradesByDate = useMemo(() => {
    const map = new Map<string, RustTrade[]>();
    if (!result) return map;
    for (const t of result.trades) {
      const list = map.get(t.date);
      if (list) list.push(t);
      else map.set(t.date, [t]);
    }
    return map;
  }, [result]);

  const dayTrades = day ? (tradesByDate.get(day.date) ?? []) : [];

  // Every fill in the run, grouped by trading day. `result.trades` is already
  // date-ascending, so a single pass builds the date headers.
  type LedgerRow =
    | { kind: 'date'; date: string; index: number; count: number; value: number }
    | { kind: 'trade'; t: RustTrade };
  const ledgerRows = useMemo<LedgerRow[]>(() => {
    if (!result) return [];
    const dayIndex = new Map(result.days.map((d) => [d.date, d.index]));
    const rows: LedgerRow[] = [];
    let i = 0;
    while (i < result.trades.length) {
      const date = result.trades[i].date;
      let j = i;
      let value = 0;
      while (j < result.trades.length && result.trades[j].date === date) {
        value += result.trades[j].value;
        j += 1;
      }
      rows.push({
        kind: 'date',
        date,
        index: dayIndex.get(date) ?? -1,
        count: j - i,
        value,
      });
      for (let k = i; k < j; k += 1) rows.push({ kind: 'trade', t: result.trades[k] });
      i = j;
    }
    return rows;
  }, [result]);

  useEffect(() => {
    setLedgerLimit(200);
    setExpandedSymbol(null);
  }, [result]);

  // 个股总体情况：引擎给了每只标的的已实现盈亏/胜率/同期涨跌，
  // 买卖笔数、期末股数、首次买入日、买入/卖出金额都从成交流水推出来
  // （framework_shares 不填）。
  const symbolRows = useMemo(() => {
    if (!result) return [];
    type Agg = {
      buys: number;
      sells: number;
      shares: number;
      firstBuy: string | null;
      lastTrade: string | null;
      buyAmount: number;
      sellAmount: number;
      tradeList: RustTrade[];
    };
    const agg = new Map<string, Agg>();
    for (const t of result.trades) {
      const a =
        agg.get(t.symbol) ??
        { buys: 0, sells: 0, shares: 0, firstBuy: null, lastTrade: null, buyAmount: 0, sellAmount: 0, tradeList: [] };
      if (t.action === 'BUY') {
        a.buys += 1;
        a.shares += t.shares;
        a.buyAmount += t.value;
        if (!a.firstBuy) a.firstBuy = t.date;
      } else {
        a.sells += 1;
        a.shares -= t.shares;
        a.sellAmount += t.value;
      }
      // result.trades 本身按日期升序, 所以最后 push 进来的就是最近一笔
      a.lastTrade = t.date;
      a.tradeList.push(t);
      agg.set(t.symbol, a);
    }
    return result.symbols
      .filter((s) => s.trades > 0)
      .map((s) => {
        const a = agg.get(s.symbol);
        return {
          ...s,
          buys: a?.buys ?? 0,
          sells: a?.sells ?? 0,
          shares: Math.max(0, Math.round(a?.shares ?? 0)),
          firstBuy: a?.firstBuy ?? null,
          lastTrade: a?.lastTrade ?? null,
          buyAmount: a?.buyAmount ?? 0,
          sellAmount: a?.sellAmount ?? 0,
          tradeList: a?.tradeList ?? [],
        };
      })
      .sort((x, y) => y.realized_pnl - x.realized_pnl);
  }, [result]);

  const symbolTotals = useMemo(() => {
    let pnl = 0;
    let fees = 0;
    let win = 0;
    let lose = 0;
    for (const r of symbolRows) {
      pnl += r.realized_pnl;
      fees += r.fees;
      if (r.realized_pnl > 0) win += 1;
      else if (r.realized_pnl < 0) lose += 1;
    }
    return { pnl, fees, win, lose };
  }, [symbolRows]);
  // 游标竖线交给 Recharts 的 ReferenceLine 画：它用的是图表自己的 x 轴刻度，
  // 不会像手算百分比那样忽略 Y 轴宽度和右侧留白（那正是之前竖线偏左的原因）。
  const cursorDate = day?.date ?? null;

  const chartNode = useMemo(() => {
    if (chartData.length === 0) return null;
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 8, right: 10, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: '#71717a', fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: '#27272a' }}
            minTickGap={60}
          />
          <YAxis
            tick={{ fill: '#71717a', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={62}
            tickFormatter={(v: number) => fmtCompact(v)}
            domain={['auto', 'auto']}
          />
          <Tooltip
            contentStyle={{
              background: '#18181b',
              border: '1px solid #3f3f46',
              borderRadius: 8,
              fontSize: 13,
            }}
            labelStyle={{ color: '#a1a1aa' }}
            formatter={(value: number, name: string) => [
              fmtMoney(value),
              name === 'equity' ? '策略权益' : '等权买入持有',
            ]}
          />
          <Area
            type="monotone"
            dataKey="bh"
            stroke="#52525b"
            strokeDasharray="4 3"
            strokeWidth={1}
            fill="none"
            dot={false}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="equity"
            stroke="#3b82f6"
            strokeWidth={1.6}
            fill="url(#eqFill)"
            dot={false}
            isAnimationActive={false}
          />
          {cursorDate && (
            <ReferenceLine
              x={cursorDate}
              stroke="#60a5fa"
              strokeWidth={1.5}
              strokeOpacity={0.85}
              ifOverflow="discard"
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    );
  }, [chartData, cursorDate]);

  const kpis = result
    ? [
        {
          label: '策略收益',
          value: fmtPct(result.metrics.total_return_percent),
          tone: upDown(result.metrics.total_return_percent),
          sub: `年化 ${fmtPct(result.metrics.annualized_percent)}`,
        },
        {
          label: '等权买入持有',
          value: fmtPct(result.metrics.buy_hold_return_percent),
          tone: upDown(result.metrics.buy_hold_return_percent),
          sub: `超额 ${fmtPct(result.metrics.excess_return_percent)}`,
        },
        {
          label: '最大回撤',
          value: `${result.metrics.max_drawdown_percent.toFixed(2)}%`,
          tone: 'text-amber-400',
          sub: `波动 ${result.metrics.volatility_percent.toFixed(1)}%`,
        },
        {
          label: '夏普比率',
          value: result.metrics.sharpe.toFixed(2),
          tone: 'text-blue-400',
          sub: `仓位暴露 ${result.metrics.exposure_percent.toFixed(0)}%`,
        },
        {
          label: '期末权益',
          value: fmtCompact(result.metrics.final_equity),
          tone: 'text-zinc-100',
          sub: `初始 ${fmtCompact(result.metrics.initial_cash)}`,
        },
        {
          label: '平仓胜率',
          value: `${result.metrics.win_rate_percent.toFixed(1)}%`,
          tone: 'text-zinc-100',
          sub: `${result.metrics.trades} 笔 · 费用 ${fmtCompact(result.metrics.total_fees)}`,
        },
      ]
    : [];

  const selectedCoverage = coverage.filter((c) => selectedPools.includes(c.id));
  const cacheReady = selectedCoverage.length > 0 && selectedCoverage.every((c) => c.cached > 0);

  return (
    <div className="flex flex-col gap-4 xl:h-full xl:min-h-0">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3 px-1">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500/25 to-amber-600/10 border border-orange-500/30 flex items-center justify-center">
            <Cpu className="h-4 w-4 text-orange-400" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-zinc-100 leading-none">策略回测</h2>
            <p className="text-[13px] text-zinc-500 mt-1.5 font-mono">
              {framework} · 选股池 → 策略 → 信号 → A 股撮合
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {result && (
            <span className="hidden lg:inline text-[13px] text-zinc-500 font-mono">
              录制 {result.elapsed_ms} ms · {result.universe} 只 · {result.days.length} 个交易日
              {result.filtered_out ? ` · 剔除 ${result.filtered_out}` : ''}
            </span>
          )}
          <span
            className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[12px] font-mono ${
              online
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                : 'border-red-500/30 bg-red-500/10 text-red-400'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                online ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'
              }`}
            />
            {online ? 'engine online' : 'engine offline'}
          </span>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-[13px] text-red-300">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span className="leading-relaxed">{error}</span>
        </div>
      )}

      {/* left / right split：两栏各自滚动，左侧「开始回测」钉在栏底 */}
      <div className="grid grid-cols-1 xl:grid-cols-[384px_minmax(0,1fr)] gap-4 items-stretch xl:flex-1 xl:min-h-0">
        {/* ---------------- LEFT: configuration ---------------- */}
        <aside className="flex flex-col gap-3 xl:min-h-0">
          <div
            className={`flex flex-col gap-3 transition-opacity xl:flex-1 xl:min-h-0 xl:overflow-y-auto xl:pr-1 [&>*]:shrink-0 ${
              running ? 'opacity-50 pointer-events-none' : ''
            }`}
          >
          {/* pool */}
          <Card title="股票池" icon={<Layers className="h-3.5 w-3.5 text-blue-400" />}>
            <div className="grid grid-cols-2 gap-2">
              {pools.map((p) => {
                const active = selectedPools.includes(p.id);
                const cov = coverage.find((c) => c.id === p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() =>
                      setSelectedPools((prev) =>
                        prev.includes(p.id)
                          ? prev.length > 1
                            ? prev.filter((x) => x !== p.id)
                            : prev
                          : [...prev, p.id],
                      )
                    }
                    className={`rounded-lg border px-3 py-2.5 text-left transition-all cursor-pointer ${
                      active
                        ? 'border-blue-500/60 bg-blue-500/10'
                        : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className={`text-[14px] font-semibold ${
                          active ? 'text-blue-300' : 'text-zinc-300'
                        }`}
                      >
                        {p.label}
                      </span>
                      <span className="text-[12px] font-mono text-zinc-500">{p.size}</span>
                    </div>
                    <div className="text-[12px] font-mono text-zinc-600 mt-1">
                      {cov ? `已缓存 ${cov.cached}` : '—'}
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>

          {/* 可交易范围: 与扫描页共用同一份设置, 被排除的标的不会进入回测池 */}
          <Card title="可交易范围" icon={<ShieldCheck className="h-3.5 w-3.5 text-amber-400" />}>
            <TradeFilterBar size="md" hiddenUnit="只" />
            <p className="mt-2 text-[12px] text-zinc-600 leading-relaxed">
              {filterActive
                ? `回测池会剔除 ${describeTradeFilter(tradeFilter)}, 与「缠论扫描」共用同一设置。`
                : '回测池不按板块过滤: 创业板 / 科创板 / 北交所都会参与回测。'}
            </p>
          </Card>

          {/* range */}
          <Card title="回测区间" icon={<CalendarRange className="h-4 w-4 text-violet-400" />}>
            <div className="grid grid-cols-2 gap-2">
              <Field label="开始">
                <DateField
                  value={startDate}
                  onChange={setStartDate}
                  min={range.first || undefined}
                  max={endDate || range.last || undefined}
                  ariaLabel="回测开始日期"
                />
              </Field>
              <Field label="结束">
                <DateField
                  value={endDate}
                  onChange={setEndDate}
                  min={startDate || range.first || undefined}
                  max={range.last || undefined}
                  ariaLabel="回测结束日期"
                />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                { label: '近 1 年', days: -365 },
                { label: '近 2 年', days: -730 },
                { label: '近 3 年', days: -1095 },
                { label: '全部', days: 0 },
              ].map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => {
                    const base = endDate || range.last;
                    if (!base || !range.first) return;
                    const floor = range.first < '2023-01-01' ? '2023-01-01' : range.first;
                    const next = preset.days === 0 ? floor : shiftDays(base, preset.days);
                    setStartDate(next < floor ? floor : next);
                  }}
                  className="px-2 h-7 rounded-md border border-zinc-800 text-[12px] text-zinc-400 hover:border-violet-500/50 hover:text-violet-300 hover:bg-violet-500/5 transition-colors cursor-pointer"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </Card>

          {/* strategy */}
          <Card title="策略" icon={<Sliders className="h-4 w-4 text-blue-400" />}>
            <Select
              value={strategyId}
              onChange={setStrategyId}
              ariaLabel="选择回测策略"
              options={strategies.map((s) => ({ value: s.id, label: s.name }))}
            />
            {activeStrategy?.description && (
              <p className="mt-2 text-[12px] text-zinc-500 leading-relaxed">
                {activeStrategy.description}
              </p>
            )}
            {activeStrategy && activeStrategy.params.length > 0 && (
              <div className="mt-2.5 grid grid-cols-2 gap-2">
                {activeStrategy.params.map((p) => (
                  <Field key={p.key} label={p.label}>
                    <input
                      type="number"
                      value={params[p.key] ?? ''}
                      min={p.min}
                      max={p.max}
                      step={p.step ?? 1}
                      onChange={(e) =>
                        setParams((prev) => ({ ...prev, [p.key]: Number(e.target.value) }))
                      }
                      className="w-full h-9 px-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[14px] text-zinc-100 font-mono focus:outline-none focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/15 transition-colors"
                    />
                  </Field>
                ))}
              </div>
            )}
          </Card>

          {/* capital */}
          <Card title="资金与风控" icon={<Wallet className="h-3.5 w-3.5 text-emerald-400" />}>
            <div className="grid grid-cols-2 gap-2">
              <Field label="初始资金">
                <input
                  type="number"
                  value={initialCash}
                  step={10000}
                  onChange={(e) => setInitialCash(Number(e.target.value))}
                  className="w-full h-9 px-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[14px] text-zinc-100 font-mono focus:outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/15 transition-colors"
                />
              </Field>
              <Field label="最小开仓 ¥">
                <input
                  type="number"
                  value={minPosition}
                  min={0}
                  step={1000}
                  onChange={(e) => setMinPosition(Number(e.target.value))}
                  className="w-full h-9 px-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[14px] text-zinc-100 font-mono focus:outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/15 transition-colors"
                />
              </Field>
              <Field label="固定止损 %">
                <input
                  type="number"
                  value={stopLoss}
                  min={0}
                  step={1}
                  onChange={(e) => setStopLoss(Number(e.target.value))}
                  className="w-full h-9 px-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[14px] text-zinc-100 font-mono focus:outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/15 transition-colors"
                />
              </Field>
            </div>
            {result ? (
              <div className="mt-1.5 space-y-1">
                <div className="flex items-baseline justify-between text-[12px]">
                  <span className="text-zinc-500">可持有</span>
                  <span className="font-mono text-zinc-300">
                    {result.max_positions} 只
                    {result.max_positions < result.universe && (
                      <span className="text-zinc-600"> / {result.universe}</span>
                    )}
                  </span>
                </div>
                <div className="flex items-baseline justify-between text-[12px]">
                  <span className="text-zinc-500">每只上限</span>
                  <span className="font-mono text-zinc-300">¥{fmtMoney(result.slot_cash)}</span>
                </div>
                <div className="flex items-baseline justify-between text-[12px]">
                  <span className="text-zinc-500">最小开仓</span>
                  <span className="font-mono text-amber-400/90">
                    {result.min_position_value > 0
                      ? `¥${fmtMoney(result.min_position_value)}`
                      : '不限'}
                  </span>
                </div>
                <p className="text-[12px] text-zinc-600 leading-relaxed">
                  按「一手成本中位数」反推资金能同时持有几只, 再等权分配。开仓金额低于下限的会被直接跳过,
                  不会开小仓; 一手都超过上限的高价股同样跳过。
                </p>
              </div>
            ) : (
              <p className="mt-2 text-[12px] text-zinc-600 leading-relaxed">
                每只标的按等权仓位上限建仓, 上限由资金能同时持有几只决定; 组合共用同一现金账户。
              </p>
            )}
          </Card>

          </div>

          {/* 钉在左栏底部：配置区滚动时按钮不动 */}
          <div className="shrink-0 pt-3 border-t border-zinc-800/60">
            <button
              onClick={handleRun}
              disabled={running || !online || !cacheReady}
              className="w-full h-10 rounded-lg bg-blue-500 hover:bg-blue-400 active:bg-blue-600 disabled:opacity-40 text-white text-[14px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm shadow-blue-500/20"
            >
              {running ? (
                <>
                  <RotateCcw className="h-4 w-4 animate-spin" />
                  更新数据 · 录制中…
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4" />
                  开始回测
                </>
              )}
            </button>
            {!cacheReady && (
              <p className="text-[12px] text-amber-500/90 text-center mt-1.5">
                该池还没有缓存数据, 先点「增量更新」拉取
              </p>
            )}
          </div>
        </aside>

        {/* ---------------- RIGHT: results ---------------- */}
        <section className="min-w-0 xl:min-h-0 xl:overflow-y-auto xl:pr-1">
          <div className="flex flex-col gap-3 min-h-full">
          {running && (
            <div className="flex items-center gap-3 rounded-xl border border-blue-500/30 bg-blue-500/5 px-4 py-3">
              <div className="h-4 w-4 shrink-0 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
              <div className="min-w-0">
                <p className="text-[14px] font-semibold text-blue-300">
                  正在回测…
                  <span className="ml-2 font-mono text-[13px] text-blue-400/80">{elapsed}s</span>
                </p>
                <p className="text-[12px] text-zinc-500 mt-0.5">
                  自动补齐缺失数据 → 逐日录制 {result ? '· 下方为上一次结果' : ''}
                </p>
              </div>
            </div>
          )}

          {running && !result && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4 animate-pulse">
              <div className="grid grid-cols-3 xl:grid-cols-6 gap-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-14 rounded-lg bg-zinc-800/50" />
                ))}
              </div>
              <div className="mt-3 h-[300px] rounded-lg bg-zinc-800/40" />
              <div className="mt-3 h-40 rounded-lg bg-zinc-800/40" />
            </div>
          )}

          {!result && !running && (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/20 py-20 flex flex-col items-center justify-center text-center">
              <Layers className="h-8 w-8 text-zinc-700 mb-3" />
              <p className="text-[13px] text-zinc-400 font-medium">还没有回测记录</p>
              <p className="text-[12px] text-zinc-600 mt-1 max-w-sm leading-relaxed">
                Rust 引擎会用缓存的日线把整段历史<b>一次录完</b> —— 每个交易日一份快照
                (决策 / 成交 / 现金持仓 / 盯市权益), 之后拖动进度条只是索引查找。
              </p>
            </div>
          )}


          {result && (
            <div
              className={`flex flex-col gap-3 min-w-0 flex-1 transition-opacity ${
                running ? 'opacity-40 pointer-events-none' : ''
              }`}
            >
              {result.refresh && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5 text-[13px] text-zinc-500">
                  <span className="font-semibold text-zinc-400">数据自动更新</span>
                  {result.refresh.skipped ? (
                    <span className="text-zinc-500">{result.refresh.reason ?? '已是最新'}</span>
                  ) : (
                    <>
                      <span>
                        检查 {result.refresh.checked} 只 · 拉取 {result.refresh.refreshed} 只
                      </span>
                      {result.refresh.appended > 0 && (
                        <span className="text-blue-400">追加 {result.refresh.appended}</span>
                      )}
                      {result.refresh.rebased > 0 && (
                        <span className="text-amber-400">
                          除权重拉 {result.refresh.rebased}
                          {result.refresh.rebased_symbols.length > 0 && (
                            <span className="text-amber-500/80 font-mono">
                              {' '}
                              ({result.refresh.rebased_symbols.slice(0, 4).join(', ')})
                            </span>
                          )}
                        </span>
                      )}
                      {result.refresh.failed > 0 && (
                        <span className="text-red-400">失败 {result.refresh.failed}</span>
                      )}
                      <span className="font-mono text-zinc-600">
                        {(result.refresh.elapsed_ms / 1000).toFixed(1)}s
                      </span>
                    </>
                  )}
                </div>
              )}

              <div className="grid grid-cols-3 xl:grid-cols-6 gap-2">
                {kpis.map((k) => (
                  <div
                    key={k.label}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2.5"
                  >
                    <div className="text-[12px] text-zinc-500 uppercase tracking-wider font-semibold truncate">
                      {k.label}
                    </div>
                    <div className={`text-[18px] font-bold font-mono mt-0.5 ${k.tone}`}>
                      {k.value}
                    </div>
                    <div className="text-[12px] text-zinc-600 font-mono mt-0.5 truncate">{k.sub}</div>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
                <div className="flex items-center gap-3 px-3 py-2.5 border-b border-zinc-800/80">
                  <Gauge className="h-4 w-4 text-blue-400" />
                  <span className="text-[14px] font-semibold text-zinc-300">组合权益</span>
                  <span className="text-[13px] text-zinc-600 font-mono">
                    {result.start} → {result.end} · {result.days.length} 日
                  </span>
                  <div className="ml-auto flex items-center gap-3 text-[12px] font-mono">
                    <span className="flex items-center gap-1 text-blue-400">
                      <span className="h-0.5 w-4 bg-blue-500 rounded" />
                      策略
                    </span>
                    <span className="flex items-center gap-1 text-zinc-500">
                      <span className="h-0.5 w-4 border-t border-dashed border-zinc-500" />
                      等权买入持有
                    </span>
                  </div>
                </div>

                <div className="relative h-[300px] px-1 pt-1">
                  {chartNode}
                </div>

                <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-800/80 bg-zinc-950/40">
                  <TransportBtn
                    title="回到第一天"
                    onClick={() => {
                      setPlaying(false);
                      setCursor(0);
                    }}
                  >
                    <SkipBack className="h-3.5 w-3.5" />
                  </TransportBtn>
                  <TransportBtn
                    title="前一天"
                    onClick={() => {
                      setPlaying(false);
                      setCursor((c) => Math.max(0, c - 1));
                    }}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </TransportBtn>
                  <button
                    onClick={() => setPlaying((p) => !p)}
                    className="h-8 w-8 rounded-md bg-blue-500 hover:bg-blue-400 text-white flex items-center justify-center cursor-pointer shadow-sm shadow-blue-500/25"
                    title={playing ? '暂停' : '逐日播放'}
                  >
                    {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  </button>
                  <TransportBtn
                    title="后一天"
                    onClick={() => {
                      setPlaying(false);
                      setCursor((c) => Math.min(total - 1, c + 1));
                    }}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </TransportBtn>
                  <TransportBtn
                    title="跳到最后一天"
                    onClick={() => {
                      setPlaying(false);
                      setCursor(total - 1);
                    }}
                  >
                    <SkipForward className="h-3.5 w-3.5" />
                  </TransportBtn>

                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, total - 1)}
                    value={cursor}
                    onChange={(e) => {
                      setPlaying(false);
                      setCursor(Number(e.target.value));
                    }}
                    className="flex-1 accent-blue-500 cursor-pointer"
                  />

                  <div className="w-[108px] shrink-0">
                    <Select
                      size="sm"
                      value={String(speed)}
                      onChange={(v) => setSpeed(Number(v))}
                      ariaLabel="播放速度"
                      options={[2, 5, 10, 20, 40].map((s) => ({
                        value: String(s),
                        label: `${s} 日/秒`,
                      }))}
                    />
                  </div>
                </div>
              </div>

              {day && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden flex flex-col min-w-0">
                  {/* 当日概览: 左日期 / 右权益三连 / 下方等宽统计, 整体是一块而不是散落的标签 */}
                  <div className="px-3 py-2.5 border-b border-zinc-800/80 space-y-2">
                    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[12px] text-zinc-500 uppercase tracking-wider font-semibold">
                            第 {day.index + 1} / {total} 日
                          </span>
                          <span className="text-[18px] font-bold text-zinc-100 font-mono leading-none">
                            {day.date}
                          </span>
                        </div>
                        <div className="mt-1 text-[12px] text-zinc-600 font-mono">
                          评估 {day.evaluated} 只 · 持有 {day.holds} · 成交 {day.trades}
                        </div>
                      </div>

                      <div className="flex items-end gap-4">
                        <div className="text-right">
                          <div className="text-[12px] text-zinc-600">盯市权益</div>
                          <div className="text-[20px] font-bold font-mono text-zinc-100 leading-tight">
                            {fmtMoney(day.equity)}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[12px] text-zinc-600">当日变化</div>
                          <div className={`text-[14px] font-mono font-semibold leading-tight ${upDown(dayChange.value)}`}>
                            {dayChange.value >= 0 ? '+' : ''}
                            {fmtMoney(dayChange.value)}
                            <span className="ml-1 text-[12px] opacity-75">{fmtPct(dayChange.pct)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[12px] text-zinc-600">累计收益</div>
                          <div className={`text-[14px] font-mono font-semibold leading-tight ${upDown(cumReturn)}`}>
                            {fmtPct(cumReturn)}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5">
                      <Stat label="现金" value={fmtMoney(day.cash)} />
                      <Stat label="持仓市值" value={fmtMoney(day.position_value)} />
                      <Stat label="持仓" value={`${day.positions} 只`} />
                      <Stat label="今日买入信号" value={String(day.buys)} tone="text-red-400" />
                      <Stat label="今日卖出信号" value={String(day.sells)} tone="text-green-400" />
                      <Stat
                        label="仓位"
                        value={`${day.equity > 0 ? ((day.position_value / day.equity) * 100).toFixed(0) : 0}%`}
                      />
                    </div>
                  </div>

                  {/* 当日持仓明细: 逐日快照来自引擎, 拖动进度条时直接跟着变 */}
                  {day.holdings.length > 0 && (
                    <div className="border-b border-zinc-800/80">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2 pb-1">
                        <Wallet className="h-3.5 w-3.5 text-emerald-400" />
                        <span className="text-[12px] font-semibold text-zinc-400">当日持仓</span>
                        <span className="text-[12px] text-zinc-600 font-mono">
                          {day.holdings.length} 只 · 市值 {fmtMoney(day.position_value)}
                        </span>
                        <span className="ml-auto text-[12px] font-mono text-zinc-600">
                          浮动{' '}
                          <span className={upDown(dayHoldingsPnl)}>
                            {dayHoldingsPnl >= 0 ? '+' : ''}
                            {fmtMoney(dayHoldingsPnl)}
                          </span>
                        </span>
                      </div>
                      <div className="max-h-[136px] overflow-auto">
                        <table className="w-full min-w-[620px] text-[13px]">
                          <thead className="sticky top-0 bg-zinc-900/95 backdrop-blur text-zinc-500">
                            <tr>
                              <Th>标的</Th>
                              <Th right>股数</Th>
                              <Th right>成本</Th>
                              <Th right>现价</Th>
                              <Th right>市值</Th>
                              <Th right>浮动盈亏</Th>
                              <Th>建仓日</Th>
                            </tr>
                          </thead>
                          <tbody>
                            {day.holdings.map((h) => (
                              <tr key={h.symbol} className="border-t border-zinc-800/40">
                                <Td>
                                  <SymbolCell
                                    symbol={h.symbol}
                                    name={nameOf(h.symbol)}
                                    onOpen={() => setDetailSymbol(h.symbol)}
                                  />
                                </Td>
                                <Td right mono>{h.shares.toLocaleString()}</Td>
                                <Td right mono>{h.avg_cost.toFixed(2)}</Td>
                                <Td right mono>{h.close.toFixed(2)}</Td>
                                <Td right mono>{fmtMoney(h.value)}</Td>
                                <Td right mono className={upDown(h.pnl)}>
                                  {h.pnl >= 0 ? '+' : ''}
                                  {fmtMoney(h.pnl)}
                                  <span className="ml-1 text-[11px] opacity-70">
                                    {fmtPct(h.pnl_percent)}
                                  </span>
                                </Td>
                                <Td mono>{h.opened_on ?? '—'}</Td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-1 px-2 py-1.5 border-b border-zinc-800/80">
                    {(
                      [
                        ['decisions', `当日信号 (${day.decisions.length})`],
                        ['trades', `当日成交 (${dayTrades.length})`],
                        ['all', `全部成交 (${result.trades.length})`],
                      ] as const
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        onClick={() => setTab(key)}
                        className={`px-3 h-7 rounded-md text-[13px] font-medium transition-colors cursor-pointer whitespace-nowrap ${
                          tab === key
                            ? 'bg-blue-500/15 text-blue-300'
                            : 'text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                    <span className="ml-auto text-[12px] text-zinc-600 font-mono pr-1 hidden md:inline">
                      {tab === 'all' ? '按日期分组 · 点日期跳转' : '信号含策略理由'}
                    </span>
                    </div>

                    <div className="max-h-[min(58vh,560px)] min-h-[180px] overflow-y-auto">
                      {tab === 'decisions' &&
                        (day.decisions.length === 0 ? (
                          <Empty text="这一天没有产生买卖信号" />
                        ) : (
                          <table className="w-full text-[13px]">
                            <thead className="sticky top-0 bg-zinc-900/95 backdrop-blur text-zinc-500">
                              <tr>
                                <Th>标的</Th>
                                <Th>信号</Th>
                                <Th right>收盘</Th>
                                <Th right>数量</Th>
                                <Th right>费用</Th>
                                <Th>理由 / 结果</Th>
                              </tr>
                            </thead>
                            <tbody>
                              {day.decisions.map((d, i) => (
                                <tr key={`${d.symbol}-${i}`} className="border-t border-zinc-800/50">
                                  <Td>
                                    <SymbolCell
                                      symbol={d.symbol}
                                      name={nameOf(d.symbol)}
                                      onOpen={() => setDetailSymbol(d.symbol)}
                                    />
                                  </Td>
                                  <Td>
                                    <span
                                      className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[12px] font-bold ${
                                        d.action === 'BUY'
                                          ? 'bg-red-500/15 text-red-400'
                                          : 'bg-green-500/15 text-green-400'
                                      }`}
                                    >
                                      {d.action === 'BUY' ? (
                                        <ArrowUpRight className="h-2.5 w-2.5" />
                                      ) : (
                                        <ArrowDownRight className="h-2.5 w-2.5" />
                                      )}
                                      {d.action === 'BUY' ? '买入' : '卖出'}
                                    </span>
                                  </Td>
                                  <Td right mono>
                                    {d.close.toFixed(2)}
                                  </Td>
                                  <Td right mono>
                                    {d.filled_shares > 0 ? d.filled_shares.toLocaleString() : '—'}
                                  </Td>
                                  <Td right mono>
                                    {d.fee > 0 ? d.fee.toFixed(2) : '—'}
                                  </Td>
                                  <Td>
                                    <div
                                      className="max-w-[520px] truncate"
                                      title={`${d.reason ?? ''}${
                                        d.rejected ? ` · 未成交: ${d.rejected}` : ''
                                      }`}
                                    >
                                      <span className="text-zinc-400">{d.reason ?? ''}</span>
                                      {d.rejected && (
                                        <span className="ml-1 text-amber-400">
                                          · 未成交: {d.rejected}
                                        </span>
                                      )}
                                    </div>
                                  </Td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ))}

                      {tab === 'trades' &&
                        (dayTrades.length === 0 ? (
                          <Empty text="这一天没有成交" />
                        ) : (
                          <table className="w-full text-[13px]">
                            <thead className="sticky top-0 bg-zinc-900/95 backdrop-blur text-zinc-500">
                              <tr>
                                <Th>标的</Th>
                                <Th>方向</Th>
                                <Th right>价格</Th>
                                <Th right>股数</Th>
                                <Th right>金额</Th>
                                <Th right>费用</Th>
                              </tr>
                            </thead>
                            <tbody>
                              {dayTrades.map((t, i) => (
                                <tr key={`${t.symbol}-${i}`} className="border-t border-zinc-800/50">
                                  <Td>
                                    <SymbolCell
                                      symbol={t.symbol}
                                      name={nameOf(t.symbol)}
                                      onOpen={() => setDetailSymbol(t.symbol)}
                                    />
                                  </Td>
                                  <Td>
                                    <span
                                      className={
                                        t.action === 'BUY' ? 'text-red-400' : 'text-green-400'
                                      }
                                    >
                                      {t.action === 'BUY' ? '买入' : '卖出'}
                                    </span>
                                  </Td>
                                  <Td right mono>
                                    {t.price.toFixed(2)}
                                  </Td>
                                  <Td right mono>
                                    {t.shares.toLocaleString()}
                                  </Td>
                                  <Td right mono>
                                    {fmtMoney(t.value)}
                                  </Td>
                                  <Td right mono>
                                    {t.fee.toFixed(2)}
                                  </Td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ))}

                      {tab === 'all' && (
                        <>
                          <table className="w-full text-[13px]">
                            <thead className="sticky top-0 bg-zinc-900/95 backdrop-blur text-zinc-500">
                              <tr>
                                <Th>标的</Th>
                                <Th>方向</Th>
                                <Th right>价格</Th>
                                <Th right>股数</Th>
                                <Th right>金额</Th>
                                <Th right>费用</Th>
                              </tr>
                            </thead>
                            <tbody>
                              {ledgerRows.slice(0, ledgerLimit).map((row, i) =>
                                row.kind === 'date' ? (
                                  <tr
                                    key={`d-${row.date}`}
                                    onClick={() => {
                                      if (row.index < 0) return;
                                      setPlaying(false);
                                      setCursor(row.index);
                                    }}
                                    className="cursor-pointer bg-zinc-950/80 hover:bg-zinc-900/80"
                                    title="跳到这一天"
                                  >
                                    <td
                                      colSpan={6}
                                      className="px-3 py-2 border-t border-zinc-800/70"
                                    >
                                      <span className="font-mono text-[13px] font-semibold text-zinc-300">
                                        {row.date}
                                      </span>
                                      <span className="ml-2 text-[12px] text-zinc-600">
                                        {row.count} 笔 · ¥{fmtMoney(row.value)}
                                      </span>
                                      {row.date === day?.date && (
                                        <span className="ml-2 text-[12px] text-blue-400">
                                          当前
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                ) : (
                                  <tr
                                    key={`t-${i}`}
                                    className={`border-t border-zinc-800/40 ${
                                      row.t.date === day?.date ? 'bg-blue-500/5' : ''
                                    }`}
                                  >
                                    <Td>
                                      <SymbolCell
                                        symbol={row.t.symbol}
                                        name={nameOf(row.t.symbol)}
                                        onOpen={() => setDetailSymbol(row.t.symbol)}
                                      />
                                    </Td>
                                    <Td>
                                      <span
                                        className={
                                          row.t.action === 'BUY'
                                            ? 'text-red-400'
                                            : 'text-green-400'
                                        }
                                      >
                                        {row.t.action === 'BUY' ? '买入' : '卖出'}
                                      </span>
                                    </Td>
                                    <Td right mono>
                                      {row.t.price.toFixed(2)}
                                    </Td>
                                    <Td right mono>
                                      {row.t.shares.toLocaleString()}
                                    </Td>
                                    <Td right mono>
                                      {fmtMoney(row.t.value)}
                                    </Td>
                                    <Td right mono>
                                      {row.t.fee.toFixed(2)}
                                    </Td>
                                  </tr>
                                ),
                              )}
                            </tbody>
                          </table>
                          {ledgerRows.length > ledgerLimit && (
                            <div className="p-2 border-t border-zinc-800/60">
                              <button
                                onClick={() => setLedgerLimit((n) => n + 400)}
                                className="w-full h-9 rounded-md border border-zinc-800 text-[13px] text-zinc-400 hover:border-blue-500/50 hover:text-blue-300 transition-colors cursor-pointer"
                              >
                                加载更多 ({ledgerLimit} / {ledgerRows.length})
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                </div>
              )}

              {/* 个股总体情况：撑满剩余高度，和左侧设置栏底部对齐 */}
              {result && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden flex flex-col flex-1 min-h-[200px] max-h-[340px]">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 border-b border-zinc-800/80">
                    <Layers className="h-4 w-4 text-blue-400" />
                    <span className="text-[14px] font-semibold text-zinc-300">个股总体情况</span>
                    <span className="text-[12px] text-zinc-600">全区间</span>
                    <span className="text-[12px] text-zinc-600 font-mono">
                      {symbolRows.length} / {result.universe} 只有交易
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] font-mono">
                      <span className="text-zinc-600">
                        已实现{' '}
                        <span className={upDown(symbolTotals.pnl)}>
                          {symbolTotals.pnl >= 0 ? '+' : ''}
                          {fmtMoney(symbolTotals.pnl)}
                        </span>
                      </span>
                      <span className="text-zinc-600">
                        手续费 <span className="text-zinc-400">{fmtMoney(symbolTotals.fees)}</span>
                      </span>
                      <span className="text-zinc-600">
                        盈利 <span className="text-red-400">{symbolTotals.win}</span> / 亏损{' '}
                        <span className="text-green-400">{symbolTotals.lose}</span>
                      </span>
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-auto">
                    {symbolRows.length === 0 ? (
                      <Empty text="这段区间没有任何标的成交" />
                    ) : (
                      <table className="w-full min-w-[880px] text-[13px]">
                        <thead className="sticky top-0 bg-zinc-900/95 backdrop-blur text-zinc-500">
                          <tr>
                            <Th>标的</Th>
                            <Th right>买 / 卖</Th>
                            <Th right>买入额</Th>
                            <Th right>卖出额</Th>
                            <Th right>已实现盈亏</Th>
                            <Th right>持仓</Th>
                            <Th>首次买入</Th>
                            <Th>最近交易</Th>
                            <Th right>胜率</Th>
                            <Th right>同期涨跌</Th>
                          </tr>
                        </thead>
                        <tbody>
                          {symbolRows.map((r) => {
                            const expanded = expandedSymbol === r.symbol;
                            return (
                              <Fragment key={r.symbol}>
                                <tr
                                  onClick={() =>
                                    setExpandedSymbol((prev) => (prev === r.symbol ? null : r.symbol))
                                  }
                                  className={`border-t border-zinc-800/40 hover:bg-zinc-900/70 cursor-pointer ${
                                    expanded ? 'bg-zinc-900/60' : ''
                                  }`}
                                  title="点击展开这只票的每一笔买卖 (时间 / 金额); 点代码看 K 线"
                                >
                                  <Td>
                                    <span className="inline-flex items-center gap-1.5">
                                      <ChevronRight
                                        className={`h-3 w-3 shrink-0 text-zinc-600 transition-transform ${
                                          expanded ? 'rotate-90' : ''
                                        }`}
                                      />
                                      <SymbolCell
                                        symbol={r.symbol}
                                        name={nameOf(r.symbol)}
                                        onOpen={() => setDetailSymbol(r.symbol)}
                                      />
                                    </span>
                                  </Td>
                                  <Td right mono>
                                    <span className="text-red-400">{r.buys}</span>
                                    <span className="text-zinc-600"> / </span>
                                    <span className="text-green-400">{r.sells}</span>
                                  </Td>
                                  <Td right mono>{r.buyAmount > 0 ? fmtMoney(r.buyAmount) : '—'}</Td>
                                  <Td right mono>{r.sellAmount > 0 ? fmtMoney(r.sellAmount) : '—'}</Td>
                                  <Td right mono className={upDown(r.realized_pnl)}>
                                    {r.realized_pnl >= 0 ? '+' : ''}
                                    {fmtMoney(r.realized_pnl)}
                                  </Td>
                                  <Td right mono>
                                    {r.shares > 0 ? r.shares.toLocaleString() : '—'}
                                  </Td>
                                  <Td mono>{r.firstBuy ?? '—'}</Td>
                                  <Td mono>{r.lastTrade ?? '—'}</Td>
                                  <Td right mono>
                                    {r.win_rate > 0 ? `${r.win_rate.toFixed(0)}%` : '—'}
                                  </Td>
                                  <Td right mono className={upDown(r.buy_hold_percent)}>
                                    {fmtPct(r.buy_hold_percent)}
                                  </Td>
                                </tr>

                                {expanded && (
                                  <tr className="bg-zinc-950/50">
                                    <td colSpan={10} className="px-3 py-2">
                                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1.5 text-[12px] text-zinc-600 font-mono">
                                        <span className="text-zinc-400 font-sans font-semibold">
                                          买卖明细
                                        </span>
                                        <span>{r.tradeList.length} 笔</span>
                                        <span>
                                          买入 {r.buys} 笔 ·{' '}
                                          <span className="text-red-400/90">
                                            ¥{fmtMoney(r.buyAmount)}
                                          </span>
                                        </span>
                                        <span>
                                          卖出 {r.sells} 笔 ·{' '}
                                          <span className="text-green-400/90">
                                            ¥{fmtMoney(r.sellAmount)}
                                          </span>
                                        </span>
                                        {r.shares > 0 && (
                                          <span className="text-amber-500/80">
                                            期末仍持有 {r.shares.toLocaleString()} 股
                                          </span>
                                        )}
                                      </div>
                                      <table className="w-full max-w-[720px] text-[12px]">
                                        <thead className="text-zinc-600">
                                          <tr>
                                            <th className="text-left font-medium px-2 py-1">日期</th>
                                            <th className="text-left font-medium px-2 py-1">方向</th>
                                            <th className="text-right font-medium px-2 py-1">价格</th>
                                            <th className="text-right font-medium px-2 py-1">股数</th>
                                            <th className="text-right font-medium px-2 py-1">金额</th>
                                            <th className="text-right font-medium px-2 py-1">费用</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {r.tradeList.map((t, i) => (
                                            <tr key={`${t.date}-${i}`} className="border-t border-zinc-800/40">
                                              <td className="px-2 py-1 font-mono text-zinc-400">{t.date}</td>
                                              <td
                                                className={`px-2 py-1 font-semibold ${
                                                  t.action === 'BUY' ? 'text-red-400' : 'text-green-400'
                                                }`}
                                              >
                                                {t.action === 'BUY' ? '买入' : '卖出'}
                                              </td>
                                              <td className="px-2 py-1 text-right font-mono text-zinc-300">
                                                {t.price.toFixed(2)}
                                              </td>
                                              <td className="px-2 py-1 text-right font-mono text-zinc-300">
                                                {t.shares.toLocaleString()}
                                              </td>
                                              <td className="px-2 py-1 text-right font-mono text-zinc-300">
                                                ¥{fmtMoney(t.value)}
                                              </td>
                                              <td className="px-2 py-1 text-right font-mono text-zinc-500">
                                                {t.fee.toFixed(2)}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </td>
                                  </tr>
                                )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              )}

              <p className="text-[12px] text-zinc-600 leading-relaxed px-1">
                成交口径: 信号当根收盘价 · 100 股整手 · T+1 · 涨跌停拦截 (主板 10% / 创业板·科创板
                20% / 北交所 30%) · 佣金万 2.5 (最低 5 元) + 卖出印花税千 0.5 + 过户费万 0.1。
              </p>
            </div>
          )}
          </div>
        </section>
      </div>

      {detailSymbol && (
        <SymbolDetailDrawer
          symbol={detailSymbol}
          name={nameOf(detailSymbol)}
          row={symbolRows.find((r) => r.symbol === detailSymbol) ?? null}
          trades={result ? result.trades.filter((t) => t.symbol === detailSymbol) : []}
          onClose={() => setDetailSymbol(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// presentational helpers
// ---------------------------------------------------------------------------

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="flex items-center gap-1.5 mb-2.5">
        {icon}
        <span className="text-[13px] font-semibold text-zinc-300 uppercase tracking-wider">
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-zinc-500 truncate">{label}</span>
      {children}
    </label>
  );
}

function TransportBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="h-8 w-8 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-100 hover:border-zinc-700 flex items-center justify-center cursor-pointer"
    >
      {children}
    </button>
  );
}

/** 当日概览里的等宽统计格 (标签在上, 数值在下, 统一高度) */
function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-md bg-zinc-950/50 border border-zinc-800/60 px-2.5 py-1.5 min-w-0">
      <div className="text-[11px] text-zinc-600 truncate">{label}</div>
      <div className={`text-[14px] font-mono font-semibold mt-0.5 truncate ${tone ?? 'text-zinc-300'}`}>
        {value}
      </div>
    </div>
  );
}

function TinyStat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded bg-zinc-950/60 border border-zinc-800/60 py-1">
      <div className={`text-[13px] font-mono font-bold ${tone}`}>{value}</div>
      <div className="text-[10px] text-zinc-600">{label}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="py-10 text-center text-[13px] text-zinc-600">{text}</div>;
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <th
      className={`font-semibold uppercase tracking-wider text-[12px] px-3 py-2 whitespace-nowrap ${
        right ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  mono,
  className = '',
}: {
  children: ReactNode;
  right?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-2 whitespace-nowrap ${right ? 'text-right' : 'text-left'} ${
        mono ? 'font-mono' : ''
      } text-zinc-300 ${className}`}
    >
      {children}
    </td>
  );
}

/**
 * 标的单元格：代码可点开该股的 K 线 + 缠论结构，名称跟在后面。
 * 外层 tr 通常还绑了别的点击行为，所以这里必须 stopPropagation。
 */
function SymbolCell({
  symbol,
  name,
  onOpen,
}: {
  symbol: string;
  name?: string;
  onOpen: () => void;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        className="font-mono text-blue-300 hover:text-blue-200 hover:underline cursor-pointer"
        title="查看 K 线与缠论结构"
      >
        {symbol}
      </button>
      {name ? <span className="text-[12px] text-zinc-500">{name}</span> : null}
    </span>
  );
}
