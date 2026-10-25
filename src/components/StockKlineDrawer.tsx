/**
 * 模拟盘 K 线抽屉 (Stock Kline Drawer)
 *
 * 策略模拟页 (单标的 / 选股池) 的账本里点任意标的 → 从右侧滑出该股的 K 线,
 * 视觉与分析页 (ChanlunChart) 完全一致: K 线 + 成交量 + 缠论笔/线段/中枢/分型/
 * 三类买卖点 + MA/BOLL/MACD 指标开关 + 日线/周线切换, 并把该股在本次模拟中的
 * 成交标注在图上 (回测复盘用)。
 *
 * 数据链路:
 *   - K 线: fetchStockData(symbol, tf)  (腾讯行情, 与分析页同一数据源)
 *   - 缠论: analyzeChanlunWithFallback  (优先后端 /api/chanlun/analyze, 失败本地计算)
 *   - 基本面: fetchStockBasicInfo       (非阻塞, 失败时仅隐藏头部报价)
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChartCandlestick, Loader2, X } from 'lucide-react';
import ChanlunChart from './ChanlunChart';
import { fetchStockBasicInfo, fetchStockData, type KlineTimeframe } from '../utils/api';
import { analyzeChanlunWithFallback } from '../utils/analysisApi';
import type {
  BSPoint,
  BacktestTrade,
  Fraction,
  Hub,
  Kline,
  Segment,
  StockBasicInfo,
  Stroke,
} from '../types/stock';

interface ChanlunStructures {
  fractions: Fraction[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
  bsPoints: BSPoint[];
}

export interface StockKlineDrawerProps {
  /** 打开抽屉的标的; null 表示关闭 */
  symbol: string | null;
  /** 标的名称 (账本里已有的中文名, 基本面回来前先顶上) */
  name?: string;
  /** 该标的在本次模拟中的成交, 以买卖箭头标注在 K 线上 */
  trades?: BacktestTrade[];
  onClose: () => void;
}

export default function StockKlineDrawer({ symbol, name, trades, onClose }: StockKlineDrawerProps) {
  const [timeframe, setTimeframe] = useState<KlineTimeframe>('daily');
  const [klines, setKlines] = useState<Kline[]>([]);
  const [structures, setStructures] = useState<ChanlunStructures | null>(null);
  const [basicInfo, setBasicInfo] = useState<StockBasicInfo | null>(null);
  const [period, setPeriod] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // K 线 + 缠论结构: 换标的或切周期时重新拉取 (旧图保留, 只叠 loading 遮罩)
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;

    setLoading(true);
    setError('');

    void (async () => {
      try {
        const data = await fetchStockData(symbol, timeframe);
        if (cancelled) return;

        const raw = data.klines ?? [];
        if (raw.length < 5) {
          throw new Error('该标的行情数据不足, 无法绘制 K 线');
        }

        const computed = await analyzeChanlunWithFallback(raw);
        if (cancelled) return;

        setKlines(raw);
        setStructures(computed);
        setPeriod(data.period || '');
      } catch (err) {
        if (cancelled) return;
        setKlines([]);
        setStructures(null);
        setPeriod('');
        setError(err instanceof Error ? err.message : 'K 线加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe]);

  // 基本面报价: 不阻塞图表, 失败就只显示代码
  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setBasicInfo(null);
    fetchStockBasicInfo(symbol)
      .then((info) => {
        if (!cancelled) setBasicInfo(info);
      })
      .catch(() => {
        /* 非关键 */
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  // Esc 关闭 + 锁背景滚动
  useEffect(() => {
    if (!symbol) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [symbol, onClose]);

  // 只标注落在当前 K 线区间内的成交 (lightweight-charts 不接受区间外的时间)
  const visibleTrades = useMemo(() => {
    if (!trades || trades.length === 0 || klines.length === 0) return [];
    const first = klines[0].date;
    const last = klines[klines.length - 1].date;
    return trades.filter((t) => t.date >= first && t.date <= last);
  }, [trades, klines]);

  if (!symbol) return null;

  const displayName = basicInfo?.name || name || symbol;
  const buyCount = visibleTrades.filter((t) => t.type === 'BUY').length;
  const sellCount = visibleTrades.length - buyCount;
  const hasData = klines.length > 0 && structures !== null;

  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      {/* 遮罩: 点击空白处关闭 */}
      <div
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 抽屉主体 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${displayName} K 线`}
        className="drawer-in relative flex h-full w-full max-w-[1200px] flex-col border-l border-zinc-800 bg-zinc-950 shadow-[-24px_0_48px_-12px_rgba(0,0,0,0.8)]"
      >
        {/* 头部 */}
        <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800/80 px-4 py-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-blue-500/25 bg-blue-500/15">
            <ChartCandlestick className="h-4 w-4 text-blue-400" />
          </div>

          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h3 className="truncate text-sm font-bold text-zinc-100">{displayName}</h3>
              <span className="shrink-0 rounded bg-zinc-800/70 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                {symbol}
              </span>
            </div>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-zinc-500">
              <span>K线 · 缠论分析</span>
              {visibleTrades.length > 0 && (
                <>
                  <span className="text-red-400/80">买入 {buyCount}</span>
                  <span className="text-emerald-400/80">卖出 {sellCount}</span>
                </>
              )}
              {!loading && klines.length > 0 && (
                <span>
                  {klines.length} 根{period ? ` · ${period}` : ''}
                </span>
              )}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            title="关闭 (Esc)"
            className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-100 cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* 图表区 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3 md:p-4">
          {error && !hasData && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/5 px-3 py-3 text-xs text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              <div>
                <p className="font-semibold">K 线加载失败</p>
                <p className="mt-0.5 text-red-300/70">{error}</p>
              </div>
            </div>
          )}

          {!error && !hasData && loading && (
            <div className="flex h-72 flex-col items-center justify-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-blue-400" />
              <p className="text-xs text-zinc-400">正在加载 {symbol} 的 K 线与缠论结构…</p>
            </div>
          )}

          {hasData && (
            <ChanlunChart
              klines={klines}
              fractions={structures.fractions}
              strokes={structures.strokes}
              segments={structures.segments}
              hubs={structures.hubs}
              bsPoints={structures.bsPoints}
              symbol={symbol}
              stockBasicInfo={basicInfo}
              backtestTrades={visibleTrades}
              timeframe={timeframe}
              dataPeriod={period}
              isLoading={loading}
              onTimeframeChange={setTimeframe}
            />
          )}
        </div>
      </div>
    </div>
  );
}
