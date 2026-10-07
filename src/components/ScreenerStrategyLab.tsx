import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FlaskConical, Wand2, Zap, Play, Loader2,
  CheckCircle2, XCircle, ChevronDown,
} from 'lucide-react';
import type {
  StrategyParamValue,
  UserStrategyDefinition,
} from '../types/strategy';
import {
  SCREENER_LAB_SAMPLES,
  scoreScreenerStrategy,
  type ScreenerStrategyReport,
} from '../utils/screenerStrategyTest';
import { evaluateSignalWithFallback } from '../utils/analysisApi';
import { runBacktest } from '../utils/backtestRunner';
import { sliceKlinesByRange } from '../utils/screener';
import { fetchStockData } from '../utils/api';

// ---------------------------------------------------------------------------
// 策略实验室 (选股策略框架 Step 2-3: 验证 + 抽测)
//   Step 1 AI 创建 -> 由父组件的 StrategyDialog 完成 (generateScreenerStrategyCode)
//   Step 2 合成验证 -> scoreScreenerStrategy(), 5 套合成行情秒级干跑, 无需网络
//   Step 3 实盘抽测 -> 8 只代表性个股经多源链路拉取K线, 跑信号 + 单股回测
//   Step 4 全量扫描 -> 父组件 StockScreener 的运行选股按钮
// ---------------------------------------------------------------------------

interface ScreenerStrategyLabProps {
  strategy: UserStrategyDefinition | null;
  customParams: Record<string, StrategyParamValue>;
  /** 回测区间 (与选股扫描共用, 默认近3年; 空字符串 = 无界) */
  rangeStart: string;
  rangeEnd: string;
  onOpenAiDialog: () => void;
}

interface SampleRow {
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence?: number;
  reason?: string;
  close: number;
  changePct: number;
  btReturn?: number;
  btSharpe?: number;
  error?: string;
}

export default function ScreenerStrategyLab({ strategy, customParams, rangeStart, rangeEnd, onOpenAiDialog }: ScreenerStrategyLabProps) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<ScreenerStrategyReport | null>(null);
  const [samples, setSamples] = useState<SampleRow[]>([]);
  const [sampling, setSampling] = useState(false);
  const [sampleDone, setSampleDone] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 切换策略/参数时自动跑合成验证 (纯计算, 即时反馈)
  const paramsKey = useMemo(() => JSON.stringify(customParams), [customParams]);
  useEffect(() => {
    if (!strategy) {
      setReport(null);
      setSamples([]);
      return;
    }
    try {
      const parsed = JSON.parse(paramsKey) as Record<string, StrategyParamValue>;
      setReport(scoreScreenerStrategy(strategy, parsed));
    } catch {
      setReport(scoreScreenerStrategy(strategy, customParams));
    }
    setSamples([]);
    setSampleDone(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy?.id, paramsKey]);

  const runQuick = () => {
    if (!strategy) return;
    setReport(scoreScreenerStrategy(strategy, customParams));
    setOpen(true);
  };

  const runSample = async () => {
    if (!strategy) return;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setSampling(true);
    setSamples([]);
    setSampleDone(0);
    setOpen(true);
    try {
      const rows: SampleRow[] = [];
      const paramsSnapshot = { ...customParams };
      const stratSnapshot = strategy;
      const rangeSnapshot = { start: rangeStart, end: rangeEnd };
      for (const sym of SCREENER_LAB_SAMPLES) {
        if (controller.signal.aborted) break;
        try {
          // 与个股分析/回测同链路的多源K线 (A股/美股/港股/加密/期货外汇自动路由),
          // 再按选股页回测区间切片 (默认近3年)
          const { klines: full } = await fetchStockData(sym, 'daily');
          const klines = sliceKlinesByRange(full, rangeSnapshot.start, rangeSnapshot.end);
          if (klines.length === 0) throw new Error('区间内无K线数据');
          const sig = await evaluateSignalWithFallback(stratSnapshot, klines, sym, paramsSnapshot);
          let btReturn: number | undefined;
          let btSharpe: number | undefined;
          try {
            const { result } = runBacktest({
              klines,
              symbol: sym,
              userId: 'screener-lab',
              initialCash: 100000,
              currency: 'CNY',
              strategy: stratSnapshot,
              params: paramsSnapshot,
            });
            btReturn = Math.round(result.totalReturnPercent * 100) / 100;
            btSharpe = Math.round(result.sharpeRatio * 100) / 100;
          } catch { /* 回测失败保留信号 */ }
          rows.push({
            symbol: sym,
            action: sig.action,
            confidence: sig.confidence,
            reason: sig.reason,
            close: sig.close,
            changePct: Math.round(sig.changePct * 100) / 100,
            btReturn,
            btSharpe,
          });
        } catch (err: unknown) {
          if ((err as Error)?.name === 'AbortError') break;
          rows.push({
            symbol: sym,
            action: 'HOLD',
            close: 0,
            changePct: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          setSamples([...rows]);
          setSampleDone(rows.length);
        }
      }
    } finally {
      setSampling(false);
      abortRef.current = null;
    }
  };

  const buyCount = samples.filter((r) => r.action === 'BUY').length;
  const avgBt = (() => {
    const vals = samples.map((r) => r.btReturn).filter((v): v is number => typeof v === 'number');
    if (vals.length === 0) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  })();

  const statusBadge = !strategy
    ? <span className="text-[10px] font-mono text-zinc-500">未选策略</span>
    : !report
      ? <span className="text-[10px] font-mono text-zinc-500">待验证</span>
      : report.allPass
        ? <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-1.5 py-0.5 rounded">合成验证通过</span>
        : <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 px-1.5 py-0.5 rounded">有风险项</span>;

  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/40 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-zinc-900/40 transition-colors cursor-pointer text-left"
      >
        <FlaskConical className="h-3.5 w-3.5 text-violet-400 shrink-0" />
        <span className="text-xs font-bold text-zinc-200">策略实验室</span>
        <span className="text-[10px] text-zinc-500 hidden sm:inline">AI 创建 → 合成验证 → 实盘抽测 → 全量扫描</span>
        <span className="ml-auto flex items-center gap-2">
          {statusBadge}
          <ChevronDown className={`h-3.5 w-3.5 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-zinc-800/60 pt-3">
          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={onOpenAiDialog}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-violet-500 hover:bg-violet-400 active:bg-violet-600 text-white text-[11px] font-bold cursor-pointer shadow-sm shadow-violet-500/20"
            >
              <Wand2 className="h-3 w-3" />
              AI 创建策略
            </button>
            <button
              onClick={runQuick}
              disabled={!strategy}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-semibold cursor-pointer disabled:opacity-40"
            >
              <Zap className="h-3 w-3 text-amber-400" />
              合成验证 (秒级)
            </button>
            <button
              onClick={runSample}
              disabled={!strategy || sampling}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] font-semibold cursor-pointer disabled:opacity-40"
            >
              {sampling ? <Loader2 className="h-3 w-3 animate-spin text-blue-400" /> : <Play className="h-3 w-3 fill-current text-emerald-400" />}
              {sampling ? `抽测中 ${sampleDone}/${SCREENER_LAB_SAMPLES.length}` : `实盘抽测 ${SCREENER_LAB_SAMPLES.length} 只`}
            </button>
            {strategy && (
              <span className="text-[10px] font-mono text-zinc-500 ml-auto">
                当前 <span className="text-zinc-300">{strategy.name}</span> ({strategy.id})
              </span>
            )}
          </div>

          {!strategy && (
            <p className="text-[11px] text-zinc-500">暂无策略, 点击「AI 创建策略」用自然语言生成选股策略, 保存后自动进入验证流程。</p>
          )}

          {/* 合成验证报告 */}
          {report && (
            <div className="space-y-2">
              <p className={`text-[11px] leading-relaxed ${report.allPass ? 'text-emerald-300/90' : 'text-amber-300/90'}`}>
                {report.summary}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap">
                {report.checks.map((c) => (
                  <span
                    key={c.id}
                    title={c.detail}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${
                      c.pass
                        ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
                        : 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                    }`}
                  >
                    {c.pass ? <CheckCircle2 className="h-2.5 w-2.5" /> : <XCircle className="h-2.5 w-2.5" />}
                    {c.label}
                  </span>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-1.5">
                {report.regimes.map((r) => (
                  <div key={r.regimeId} className="rounded-lg bg-zinc-900/60 border border-zinc-800/70 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`px-1 py-px rounded border text-[10px] font-bold ${
                        r.action === 'BUY'
                          ? 'bg-red-500/15 text-red-400 border-red-500/30'
                          : r.action === 'SELL'
                            ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                            : 'bg-zinc-500/10 text-zinc-500 border-zinc-700/50'
                      }`}>{r.action}</span>
                      <span className="text-[10px] text-zinc-400 truncate">{r.label}</span>
                    </div>
                    <p className="text-[10px] text-zinc-500 truncate mt-1" title={r.reason || r.error}>
                      {r.error ? `失败: ${r.error}` : (r.reason || '—')}
                    </p>
                    <p className={`text-[10px] font-mono mt-0.5 ${r.btReturn == null ? 'text-zinc-600' : r.btReturn > 0 ? 'text-red-400' : 'text-green-400'}`}>
                      {r.btReturn != null ? `回测 ${r.btReturn > 0 ? '+' : ''}${r.btReturn.toFixed(1)}%` : '回测 —'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 实盘抽测 */}
          {(samples.length > 0 || sampling) && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-semibold text-zinc-300">实盘抽测</span>
                <span className="font-mono text-zinc-600">
                  {rangeStart || rangeEnd ? `${rangeStart || '…'}→${rangeEnd || '…'}` : '全部历史'}
                </span>
                {samples.length > 0 && (
                  <span className="font-mono text-zinc-500">
                    买入 <span className="text-red-400 font-semibold">{buyCount}</span>/{samples.length}
                    {avgBt != null && (
                      <span className={avgBt > 0 ? 'text-red-400' : 'text-green-400'}> · 平均回测 {avgBt > 0 ? '+' : ''}{avgBt.toFixed(1)}%</span>
                    )}
                  </span>
                )}
                {buyCount === samples.length && samples.length > 0 && (
                  <span className="text-[10px] text-amber-400">⚠ 全买入: 策略可能过松, 建议收紧条件</span>
                )}
                {buyCount === 0 && samples.length === SCREENER_LAB_SAMPLES.length && !sampling && (
                  <span className="text-[10px] text-zinc-500">0 买入: 策略偏严, 可放宽确认窗口</span>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-1.5">
                {samples.map((r) => (
                  <div key={r.symbol} className="rounded-lg bg-zinc-900/60 border border-zinc-800/70 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className={`px-1 py-px rounded border text-[10px] font-bold shrink-0 ${
                        r.action === 'BUY' ? 'bg-red-500/15 text-red-400 border-red-500/30' : 'bg-zinc-500/10 text-zinc-500 border-zinc-700/50'
                      }`}>{r.action}</span>
                      <span className="text-[10px] font-mono font-semibold text-zinc-200">{r.symbol.split('.')[0]}</span>
                      <span className={`ml-auto text-[10px] font-mono ${r.btReturn == null ? 'text-zinc-600' : r.btReturn > 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {r.error ? '失败' : r.btReturn != null ? `${r.btReturn > 0 ? '+' : ''}${r.btReturn.toFixed(1)}%` : '—'}
                      </span>
                    </div>
                    <p className="text-[10px] text-zinc-500 truncate mt-1" title={r.reason || r.error}>
                      {r.error || r.reason || '—'}
                    </p>
                  </div>
                ))}
              </div>
              {samples.length > 0 && !sampling && (
                <p className="text-[10px] text-zinc-600">抽测通过后再点下方「运行选股」做全量扫描, 买入信号会自动附带单股回测验证。</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
