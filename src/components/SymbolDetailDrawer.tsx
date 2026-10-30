import { useEffect, useMemo, useState } from 'react';
import { X, AlertCircle } from 'lucide-react';
import ChanlunChart from './ChanlunChart';
import { runChanlunPipeline } from '../utils/chanlun';
import { fetchRustKline } from '../utils/rustSimApi';
import type { RustKlineBar, RustSymbolRow, RustTrade } from '../types/rustSim';
import type { BacktestTrade, Kline } from '../types/stock';

interface SymbolDetailDrawerProps {
  symbol: string;
  name?: string;
  /** 该标的在本次模拟里的统计（来自 result.symbols），没有就不显示 */
  row?: RustSymbolRow | null;
  /** 该标的的全部成交，画在 K 线上 */
  trades: RustTrade[];
  onClose: () => void;
}

const fmtMoney = (v: number) =>
  (Math.abs(v) < 0.5 ? 0 : v).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
const upDown = (v: number) => (v >= 0 ? 'text-red-400' : 'text-green-400');

/**
 * 从右侧滑出的个股抽屉：拉这只票的日线，本地重算缠论结构
 * （分型 / 笔 / 线段 / 中枢 / 买卖点），连同本次模拟的成交一起画出来。
 *
 * 故意不加遮罩层 —— 抽屉只占右边一部分，左边的参数栏和结果表仍然可看可点，
 * 这是「一边看回测一边翻个股」的用法。关闭走 X 或 Esc。
 */
export default function SymbolDetailDrawer({
  symbol,
  name,
  row,
  trades,
  onClose,
}: SymbolDetailDrawerProps) {
  const [bars, setBars] = useState<RustKlineBar[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setBars(null);
    setError('');
    fetchRustKline(symbol)
      .then((rows) => {
        if (!cancelled) setBars(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const klines = useMemo<Kline[]>(() => (bars ? (bars as Kline[]) : []), [bars]);

  // 缠论结构在浏览器里算：925 根日线大约几十毫秒
  const structures = useMemo(() => {
    if (klines.length < 5) return null;
    return runChanlunPipeline(klines);
  }, [klines]);

  const backtestTrades = useMemo<BacktestTrade[]>(
    () =>
      trades.map((t, i) => ({
        id: `${t.date}-${i}`,
        type: t.action,
        signalType: 'sim',
        reason: t.reason ?? undefined,
        price: t.price,
        date: t.date,
        shares: t.shares,
        value: t.value,
        fee: t.fee,
        pnl: t.pnl ?? undefined,
      })),
    [trades],
  );

  const buys = trades.filter((t) => t.action === 'BUY').length;
  const sells = trades.filter((t) => t.action === 'SELL').length;

  return (
    <aside
      role="dialog"
      aria-label={`${name || symbol} 的 K 线与缠论结构`}
      className="fixed inset-y-0 right-0 z-[60] w-full max-w-[1080px] flex flex-col bg-zinc-950 border-l border-zinc-700/70 shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.85)]"
      style={{ animation: 'drawer-in 0.22s ease-out' }}
    >
      {/* header */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/70 shrink-0">
        <span className="text-[15px] font-bold text-zinc-100">{name || symbol}</span>
        <span className="text-[12px] font-mono text-zinc-500">{symbol}</span>
        {row && (
          <>
            <span className="h-4 w-px bg-zinc-700/70" />
            <span className="text-[11px] text-zinc-500 font-mono whitespace-nowrap">
              买 {buys} / 卖 {sells}
            </span>
            <span className="text-[11px] text-zinc-500 font-mono whitespace-nowrap">
              已实现{' '}
              <span className={upDown(row.realized_pnl)}>
                {row.realized_pnl >= 0 ? '+' : ''}
                {fmtMoney(row.realized_pnl)}
              </span>
            </span>
            <span className="text-[11px] text-zinc-500 font-mono whitespace-nowrap">
              胜率 {row.win_rate > 0 ? `${row.win_rate.toFixed(0)}%` : '—'}
            </span>
            <span className="text-[11px] text-zinc-500 font-mono whitespace-nowrap">
              同期涨跌{' '}
              <span className={upDown(row.buy_hold_percent)}>
                {row.buy_hold_percent >= 0 ? '+' : ''}
                {row.buy_hold_percent.toFixed(2)}%
              </span>
            </span>
          </>
        )}
        <button
          onClick={onClose}
          className="ml-auto h-7 w-7 rounded-md border border-zinc-700 text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 flex items-center justify-center cursor-pointer shrink-0"
          title="关闭 (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* body */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 md:p-3">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-[12px] text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>加载 {symbol} 的日线失败：{error}</span>
          </div>
        )}
        {!error && !structures && (
          <div className="h-full min-h-[320px] flex flex-col items-center justify-center gap-2.5 text-zinc-500">
            <div className="h-7 w-7 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
            <p className="text-xs">正在加载日线并重算缠论结构…</p>
          </div>
        )}
        {structures && (
          <ChanlunChart
            klines={klines}
            fractions={structures.fractions}
            strokes={structures.strokes}
            segments={structures.segments}
            hubs={structures.hubs}
            bsPoints={structures.bsPoints}
            symbol={symbol}
            stockBasicInfo={null}
            backtestTrades={backtestTrades}
            timeframe="daily"
            dataPeriod="日线 · 本地缓存"
            initialVisibleBars={0}
            chartHeightClass="h-[calc(100vh-210px)] min-h-[360px]"
          />
        )}
      </div>
    </aside>
  );
}
