import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Play, ShieldAlert, CheckCircle, Download, ChevronLeft, ChevronRight, SkipForward, RotateCcw, Wand2, ChevronDown } from 'lucide-react';
import { Kline, BacktestResult, BacktestTrade } from '../types/stock';
import { SupabaseUser } from '../utils/supabase';
import type { UserStrategyDefinition, BacktestStepState, IndicatorSelectionState, BacktestDiagnostic } from '../types/strategy';
import { userStrategies } from '../strategies/user';
import { loadStoredStrategies } from '../utils/strategyLoader';
import { runBacktest } from '../utils/backtestRunner';
import { createBacktestStepper } from '../utils/backtestStepper';
import StrategyDialog from './StrategyDialog';

interface BacktestManagerProps {
  klines: Kline[];
  symbol: string;
  currentUser: SupabaseUser | null;
  onBacktestResult?: (trades: BacktestTrade[]) => void;
}

export default function BacktestManager({ klines, symbol, currentUser, onBacktestResult }: BacktestManagerProps) {
  const [initialCapital, setInitialCapital] = useState(100000);
  const [commissionRateWan, setCommissionRateWan] = useState(2.5); // 万分之二点五
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');

  // Simulation outcome
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Strategy selection
  const [selectedStrategyId, setSelectedStrategyId] = useState<string>('');
  const [allStrategies, setAllStrategies] = useState<UserStrategyDefinition[]>([]);

  // Indicator selection
  const [indicatorSelection, setIndicatorSelection] = useState<IndicatorSelectionState>({
    strategyId: '',
    selectedIndicatorIds: [],
    indicatorParams: {},
  });

  // Day-by-day stepper
  const [stepperMode, setStepperMode] = useState(false);
  const [stepState, setStepState] = useState<BacktestStepState | null>(null);
  const [diagnostics, setDiagnostics] = useState<BacktestDiagnostic[]>([]);

  // Strategy dropdown
  const [strategyDropdownOpen, setStrategyDropdownOpen] = useState(false);
  const strategyDropdownRef = useRef<HTMLDivElement | null>(null);
  const strategyButtonRef = useRef<HTMLButtonElement | null>(null);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);

  // Close dropdown on outside click + reposition on scroll/resize
  useEffect(() => {
    if (!strategyDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      const el = document.getElementById('strategy-portal-dropdown');
      if (
        strategyButtonRef.current &&
        !strategyButtonRef.current.contains(e.target as Node) &&
        el &&
        !el.contains(e.target as Node)
      ) {
        setStrategyDropdownOpen(false);
      }
    };
    const reposition = () => {
      if (strategyButtonRef.current) {
        setButtonRect(strategyButtonRef.current.getBoundingClientRect());
      }
    };
    reposition();
    document.addEventListener('mousedown', handler);
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [strategyDropdownOpen]);

  // Strategy dialog
  const [strategyDialogOpen, setStrategyDialogOpen] = useState(false);

  // Jump-to index input
  const [jumpToIndex, setJumpToIndex] = useState<string>('');

  // Load strategies on mount
  useEffect(() => {
    const stored = loadStoredStrategies();
    const combined = [...userStrategies, ...stored];
    setAllStrategies(combined);

    // Default selection: first strategy with defaultSelected, or first strategy
    const defaultStrategy = combined.find((s) => s.defaultSelected) ?? combined[0];
    if (defaultStrategy) {
      setSelectedStrategyId(defaultStrategy.id);
    }
  }, []);

  // When strategy changes, reset indicator selection
  useEffect(() => {
    const strategy = allStrategies.find((s) => s.id === selectedStrategyId);
    if (!strategy) return;

    const available = strategy.availableIndicators ?? [];
    const defaultIds = available
      .filter((ind) => ind.defaultSelected)
      .map((ind) => ind.id);

    setIndicatorSelection({
      strategyId: strategy.id,
      selectedIndicatorIds: defaultIds,
      indicatorParams: {},
    });
  }, [selectedStrategyId, allStrategies]);

  const selectedStrategy = useMemo(
    () => allStrategies.find((s) => s.id === selectedStrategyId) ?? null,
    [allStrategies, selectedStrategyId]
  );

  // Set default date range: last 3 years
  useEffect(() => {
    if (klines.length > 0) {
      const end = klines[klines.length - 1].date;
      const endD = new Date(end);
      const startD = new Date(endD);
      startD.setFullYear(startD.getFullYear() - 3);
      const startStr = startD.toISOString().split('T')[0];
      const first = klines.find(k => k.date >= startStr);
      setRangeStart(first ? first.date : klines[0].date);
      setRangeEnd(end);
    }
  }, [klines]);

  const filteredKlines = useMemo(() => {
    if (!rangeStart || !rangeEnd) return klines;
    const startIdx = klines.findIndex(k => k.date >= rangeStart);
    let endIdx = -1;
    for (let i = klines.length - 1; i >= 0; i--) {
      if (klines[i].date <= rangeEnd) { endIdx = i; break; }
    }
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return klines;
    return klines.slice(startIdx, endIdx + 1);
  }, [klines, rangeStart, rangeEnd]);

  const availableIndicators = useMemo(() => {
    if (!selectedStrategy?.availableIndicators) return [];
    return selectedStrategy.availableIndicators;
  }, [selectedStrategy]);

  const toggleIndicator = useCallback((indicatorId: string) => {
    setIndicatorSelection((prev) => {
      const isSelected = prev.selectedIndicatorIds.includes(indicatorId);
      return {
        ...prev,
        selectedIndicatorIds: isSelected
          ? prev.selectedIndicatorIds.filter((id) => id !== indicatorId)
          : [...prev.selectedIndicatorIds, indicatorId],
      };
    });
  }, []);

  const handleRunBacktest = () => {
    if (!selectedStrategy) return;
    setLoading(true);
    setStepperMode(false);
    setStepState(null);

    try {
      const commissionRate = commissionRateWan / 10000;
      const { result, diagnostics: diags } = runBacktest({
        klines: filteredKlines,
        symbol,
        userId: currentUser?.id || 'anonymous',
        initialCash: initialCapital,
        currency: 'CNY',
        commissionRate,
        strategy: selectedStrategy,
        selectedIndicatorIds: indicatorSelection.selectedIndicatorIds,
      });

      setBacktest(result);
      setDiagnostics([...diags]);
      onBacktestResult?.(result.trades);
    } catch (err) {
      setDiagnostics([{
        level: 'error',
        message: `Backtest failed: ${err instanceof Error ? err.message : String(err)}`,
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleStartStepper = () => {
    if (!selectedStrategy) return;
    setStepperMode(true);
    setBacktest(null);
    setDiagnostics([]);

    const commissionRate = commissionRateWan / 10000;
    const stepper = createBacktestStepper({
      klines: filteredKlines,
      symbol,
      userId: currentUser?.id || 'anonymous',
      initialCash: initialCapital,
      currency: 'CNY',
      commissionRate,
      strategy: selectedStrategy,
      selectedIndicatorIds: indicatorSelection.selectedIndicatorIds,
    });

    const initialState = stepper.start();
    setStepState(initialState);
    setJumpToIndex('0');

    // Store stepper ref for later use
    stepperRef.current = stepper;
  };

  const stepperRef = useRef<ReturnType<typeof createBacktestStepper> | null>(null);

  const handleStepForward = () => {
    if (!stepperRef.current) return;
    const state = stepperRef.current.stepForward();
    setStepState(state);
    setJumpToIndex(String(state.currentStepIndex));
  };

  const handleStepBackward = () => {
    if (!stepperRef.current) return;
    const state = stepperRef.current.stepBackward();
    setStepState(state);
    setJumpToIndex(String(state.currentStepIndex));
  };

  const handleJumpTo = () => {
    if (!stepperRef.current) return;
    const index = parseInt(jumpToIndex, 10);
    if (isNaN(index)) return;
    const state = stepperRef.current.jumpTo(index);
    setStepState(state);
    setJumpToIndex(String(state.currentStepIndex));
  };

  const handleRunAll = () => {
    if (!stepperRef.current) return;
    const { result, diagnostics: diags } = stepperRef.current.runAll();
    setBacktest(result);
    setDiagnostics([...diags]);
    onBacktestResult?.(result.trades);
    setStepperMode(false);
    setStepState(null);
  };

  const handleResetStepper = () => {
    stepperRef.current = null;
    setStepperMode(false);
    setStepState(null);
    onBacktestResult?.([]);
    setJumpToIndex('0');
  };

  const handleExportCSV = () => {
    if (!backtest) return;
    const rows = [['日期', '类型', '信号来源', '执行价格', '交易股数', '交易金额', '盈亏', '盈亏率']];
    for (const t of backtest.trades) {
      rows.push([
        t.date,
        t.type,
        t.signalType,
        String(t.price),
        String(t.shares),
        String(t.value),
        t.pnl !== undefined ? String(t.pnl) : '',
        t.pnlPercent !== undefined ? String(t.pnlPercent) : '',
      ]);
    }
    const csv = rows.map((r) => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${symbol}_backtest_${backtest.startDate}_${backtest.endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleStrategyCreated = (strategy: UserStrategyDefinition) => {
    setAllStrategies((prev) => [...prev, strategy]);
    setSelectedStrategyId(strategy.id);
    setStrategyDialogOpen(false);
  };

  const handleStrategySaved = () => {
    const stored = loadStoredStrategies();
    const combined = [...userStrategies, ...stored];
    setAllStrategies(combined);
  };

  const handleStrategyDeleted = () => {
    const stored = loadStoredStrategies();
    const combined = [...userStrategies, ...stored];
    setAllStrategies(combined);
    setSelectedStrategyId((prev) => {
      if (combined.some((s) => s.id === prev)) return prev;
      return combined[0]?.id ?? '';
    });
  };

  const fmt = (n: number) => n.toFixed(2);

  const sectionCls = 'bg-zinc-950 md:rounded-xl md:border md:border-zinc-800/80 overflow-hidden';

  return (
    <div className="mobile-flat bg-zinc-900 md:rounded-2xl md:border md:border-zinc-800 md:p-3 md:shadow-sm text-zinc-100">
      <div className="space-y-6">

        {/* ====== MERGED CONFIGURATION PANEL ====== */}
        <div className={sectionCls}>
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2.5 md:px-5 md:py-3 bg-zinc-900/50 border-b border-zinc-800/50">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400 text-left">回测配置</h4>
            <button
              onClick={() => setStrategyDialogOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg border border-zinc-700 cursor-pointer transition-all"
              id="btn-create-strategy"
            >
              <Wand2 className="h-3.5 w-3.5 text-purple-400" />
              <span>管理策略</span>
            </button>
          </div>

          <div className="p-3 md:p-5 space-y-5">
            {/* Strategy */}
            <div>
              <label className="block text-xs font-semibold text-zinc-400 mb-2 font-sans">选择策略</label>
              <div className="relative" ref={strategyDropdownRef}>
                <button
                  ref={strategyButtonRef}
                  type="button"
                  onClick={() => setStrategyDropdownOpen((o) => !o)}
                  className="flex items-center gap-2 px-4 py-2.5 bg-zinc-800 border border-zinc-700 hover:border-cyan-500/50 rounded-lg text-sm text-zinc-200 transition-all cursor-pointer w-full"
                  id="select-strategy"
                >
                  <span className="flex-1 text-left">
                    {selectedStrategy ? selectedStrategy.name : '选择一个策略...'}
                  </span>
                  <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform ${strategyDropdownOpen ? 'rotate-180' : ''}`} />
                </button>

                {strategyDropdownOpen && buttonRect && createPortal(
                  <div
                    id="strategy-portal-dropdown"
                    style={{
                      position: 'fixed',
                      left: buttonRect.left,
                      top: buttonRect.bottom + 6,
                      width: buttonRect.width,
                    }}
                    className="z-[9999] bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl shadow-black/60 overflow-hidden"
                  >
                    <div className="max-h-[60vh] overflow-y-auto">
                      {allStrategies.map((s) => {
                        const active = s.id === selectedStrategyId;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => {
                              setSelectedStrategyId(s.id);
                              setStrategyDropdownOpen(false);
                            }}
                            className={`w-full text-left px-3 py-2 text-xs font-mono transition-colors cursor-pointer flex items-center gap-2 ${
                              active ? 'bg-cyan-500/10 text-cyan-400' : 'text-zinc-300 hover:bg-zinc-900'
                            }`}
                          >
                            <span className="flex-1 min-w-0">
                              <span className="block truncate">{s.name}</span>
                              {s.description && (
                                <span className="block text-[10px] text-zinc-600 truncate">{s.description}</span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>,
                  document.body
                )}
              </div>
              {selectedStrategy?.description && (
                <p className="text-[11px] text-zinc-500 font-sans mt-1.5">{selectedStrategy.description}</p>
              )}
            </div>

            {/* Indicator Selection */}
            {availableIndicators.length > 0 && (
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-2 font-sans">可选指标</label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {availableIndicators.map((ind) => {
                    const checked = indicatorSelection.selectedIndicatorIds.includes(ind.id);
                    return (
                      <label
                        key={ind.id}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer transition-all text-xs ${
                          checked
                            ? 'bg-blue-950/20 border-blue-800/40 text-blue-300'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleIndicator(ind.id)}
                          className="h-3.5 w-3.5 rounded border-zinc-600 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
                        />
                        <span className="font-semibold">{ind.name}</span>
                        {ind.description && (
                          <span className="text-zinc-500 text-[10px] ml-auto">{ind.description}</span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Divider */}
            <div className="border-t border-zinc-800/50" />

            {/* Capital + Commission + Date Range + Buttons */}
            <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-2 font-sans">初始资金</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-xs font-bold text-zinc-500 font-mono">¥</span>
                  <input
                    type="number"
                    value={initialCapital}
                    onChange={(e) => setInitialCapital(Math.max(100, parseInt(e.target.value) || 1000))}
                    className="w-full pl-7 pr-3 py-2 text-xs bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono appearance-none [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-2 font-sans">佣金费率 (‱)</label>
                <div className="relative">
                  <input
                    type="number"
                    value={commissionRateWan}
                    onChange={(e) => setCommissionRateWan(parseFloat(e.target.value) || 2.5)}
                    step="0.1"
                    min="0"
                    className="w-full px-3 py-2 text-xs bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono appearance-none [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <span className="absolute inset-y-0 right-0 pr-3 flex items-center text-xs font-bold text-zinc-500 font-mono">‱</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-2 font-sans">起始日</label>
                <input
                  type="date"
                  value={rangeStart}
                  onChange={(e) => setRangeStart(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-400 mb-2 font-sans">结束日</label>
                <input
                  type="date"
                  value={rangeEnd}
                  onChange={(e) => setRangeEnd(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono"
                />
              </div>

              <div className="md:col-span-2 flex items-end gap-2">
                <button
                  onClick={handleRunBacktest}
                  disabled={loading || filteredKlines.length === 0 || !selectedStrategy}
                  className="flex-1 py-2.5 bg-blue-500 hover:bg-blue-400 active:bg-blue-600 text-white font-bold text-xs rounded-xl shadow-lg shadow-blue-500/10 cursor-pointer transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                  id="btn-run-simulation"
                >
                  <Play className="h-4 w-4 fill-current" />
                  <span>{loading ? '模拟交易中...' : '运行自动回测'}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ====== DAY-BY-DAY STEPPER UI ====== */}
        {stepperMode && stepState && (
          <div className={`${sectionCls}`}>
            <div className="flex items-center justify-between px-3 py-2.5 md:px-5 md:py-3 bg-zinc-900/50 border-b border-zinc-800/50">
              <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">逐步回测</h4>
              <button
                onClick={handleResetStepper}
                className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-all"
                id="btn-reset-stepper"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>重置</span>
              </button>
            </div>

            <div className="p-3 md:p-5 space-y-4">
              {/* Progress bar */}
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span>步骤 {stepState.currentStepIndex + 1} / {stepState.totalSteps}</span>
                  <span>{((stepState.currentStepIndex + 1) / stepState.totalSteps * 100).toFixed(1)}%</span>
                </div>
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-200"
                    style={{ width: `${((stepState.currentStepIndex + 1) / stepState.totalSteps) * 100}%` }}
                  />
                </div>
              </div>

              {/* Stepper Controls */}
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={handleStepBackward}
                  disabled={stepState.currentStepIndex <= 0}
                  className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg border border-zinc-700 cursor-pointer transition-all disabled:opacity-30"
                  title="上一步"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>

                <button
                  onClick={handleStepForward}
                  disabled={stepState.isFinished}
                  className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg border border-zinc-700 cursor-pointer transition-all disabled:opacity-30"
                  title="下一步"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>

                <div className="flex items-center gap-1.5 ml-2">
                  <span className="text-[11px] text-zinc-500">跳至:</span>
                  <input
                    type="number"
                    value={jumpToIndex}
                    onChange={(e) => setJumpToIndex(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleJumpTo()}
                    min={0}
                    max={stepState.totalSteps - 1}
                    className="w-16 px-2 py-1 text-xs bg-zinc-900 text-zinc-100 border border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono appearance-none [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <button
                    onClick={handleJumpTo}
                    className="px-2 py-1 text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg border border-zinc-700 cursor-pointer transition-all"
                  >
                    跳转
                  </button>
                </div>

                <button
                  onClick={handleRunAll}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-blue-500 hover:bg-blue-400 text-white rounded-lg cursor-pointer transition-all"
                  id="btn-stepper-run-all"
                >
                  <SkipForward className="h-3.5 w-3.5" />
                  <span>运行全部</span>
                </button>
              </div>

              {/* Current Step Info */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <div className="p-3 bg-zinc-900 rounded-xl border border-zinc-800/80">
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">当前K线</span>
                    <div className="mt-1 space-y-0.5 text-xs font-mono">
                      <p className="text-zinc-300">{stepState.currentKline.date}</p>
                      <p className="text-zinc-400">
                        开 {fmt(stepState.currentKline.open)} | 高 {fmt(stepState.currentKline.high)} | 低 {fmt(stepState.currentKline.low)} | 收 {fmt(stepState.currentKline.close)}
                      </p>
                    </div>
                  </div>

                  <div className="p-3 bg-zinc-900 rounded-xl border border-zinc-800/80">
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">策略决策</span>
                    <div className="mt-1">
                      {stepState.decision ? (
                        <div className="space-y-1">
                          <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-extrabold ${
                            stepState.decision.action === 'BUY'
                              ? 'bg-blue-950/30 text-blue-400 border border-blue-900/20'
                              : stepState.decision.action === 'SELL'
                              ? 'bg-red-950/30 text-red-400 border border-red-900/20'
                              : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                          }`}>
                            {stepState.decision.action}
                          </span>
                          {stepState.decision.amount && (
                            <p className="text-[11px] text-zinc-400 font-mono">
                              {stepState.decision.amount.unit}: {stepState.decision.amount.value}
                            </p>
                          )}
                          {stepState.decision.reason && (
                            <p className="text-[11px] text-zinc-500 font-sans">{stepState.decision.reason}</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-zinc-500 text-xs">--</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="p-3 bg-zinc-900 rounded-xl border border-zinc-800/80">
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">账户状态</span>
                    <div className="mt-1 space-y-0.5 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-zinc-500">现金 (前→后)</span>
                        <span className="text-zinc-300">¥{fmt(stepState.accountBefore.cash)} → ¥{fmt(stepState.accountAfter.cash)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">权益 (前→后)</span>
                        <span className="text-zinc-300">¥{fmt(stepState.accountBefore.equity)} → ¥{fmt(stepState.accountAfter.equity)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 bg-zinc-900 rounded-xl border border-zinc-800/80">
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">持仓状态</span>
                    <div className="mt-1 space-y-0.5 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-zinc-500">股数 (前→后)</span>
                        <span className="text-zinc-300">{stepState.positionBefore.shares} → {stepState.positionAfter.shares}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500">市值 (前→后)</span>
                        <span className="text-zinc-300">¥{fmt(stepState.positionBefore.marketValue)} → ¥{fmt(stepState.positionAfter.marketValue)}</span>
                      </div>
                      {stepState.positionAfter.shares > 0 && (
                        <div className="flex justify-between">
                          <span className="text-zinc-500">浮动盈亏</span>
                          <span className={stepState.positionAfter.unrealizedPnl >= 0 ? 'text-blue-400' : 'text-red-400'}>
                            {stepState.positionAfter.unrealizedPnl >= 0 ? '+' : ''}¥{fmt(stepState.positionAfter.unrealizedPnl)} ({fmt(stepState.positionAfter.unrealizedPnlPercent)}%)
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {stepState.tradeExecuted && (
                <div className="p-3 bg-zinc-900 rounded-xl border border-zinc-800/80">
                  <span className="text-[10px] text-zinc-500 font-mono uppercase">成交记录</span>
                  <div className="mt-1 flex items-center gap-3 text-xs font-mono">
                    <span className={`px-2 py-0.5 rounded text-[11px] font-extrabold ${
                      stepState.tradeExecuted.action === 'BUY'
                        ? 'bg-blue-950/30 text-blue-400 border border-blue-900/20'
                        : 'bg-red-950/30 text-red-400 border border-red-900/20'
                    }`}>
                      {stepState.tradeExecuted.action}
                    </span>
                    <span className="text-zinc-400">{stepState.tradeExecuted.date}</span>
                    <span className="text-zinc-300">¥{fmt(stepState.tradeExecuted.price)} × {stepState.tradeExecuted.shares}</span>
                    <span className="text-zinc-500">= ¥{fmt(stepState.tradeExecuted.value)}</span>
                    {stepState.tradeExecuted.reason && (
                      <span className="text-zinc-500 font-sans text-[11px]">({stepState.tradeExecuted.reason})</span>
                    )}
                  </div>
                </div>
              )}

              {stepState.diagnostics.length > 0 && (
                <div className="space-y-1">
                  {stepState.diagnostics.map((d, i) => (
                    <div key={`step-diag-${i}`} className="flex items-start gap-2 text-[11px]">
                      <ShieldAlert className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
                      <span className="text-amber-400">{d.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {stepState.isFinished && (
                <div className="flex items-center gap-2 p-3 bg-blue-950/10 rounded-xl border border-blue-900/20">
                  <CheckCircle className="h-4 w-4 text-blue-400" />
                  <span className="text-xs font-semibold text-blue-300">回测已完成。点击"运行全部"生成完整报告，或"重置"重新开始。</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ====== REPORT OVERVIEW ====== */}
        {backtest && !stepperMode && (
          <div className="space-y-6 transition-all animate-fade-in text-zinc-100">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400 border-b border-zinc-800 pb-2 text-left">模拟器报告概览</h4>

            <div className={sectionCls}>
              <div className="p-3 md:p-5 space-y-4">
                {/* Row 1: Capital + returns */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-left">
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">起始资金</span>
                    <p className="text-sm font-extrabold font-mono text-zinc-200">¥{fmt(backtest.initialBalance)}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">结束余额</span>
                    <p className="text-sm font-extrabold font-mono text-zinc-200">¥{fmt(backtest.finalBalance)}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">总收益</span>
                    <p className={`text-sm font-extrabold font-mono mt-0.5 ${backtest.totalReturnPercent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                      {backtest.totalReturnPercent >= 0 ? '+' : ''}{fmt(backtest.totalReturnPercent)}%
                    </p>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">买入持有</span>
                    <p className={`text-sm font-extrabold font-mono mt-0.5 ${backtest.buyHoldReturnPercent >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                      {backtest.buyHoldReturnPercent >= 0 ? '+' : ''}{fmt(backtest.buyHoldReturnPercent)}%
                    </p>
                  </div>
                </div>

                {/* Row 2: Risk + cost metrics */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-left">
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">夏普比率</span>
                    <p className={`text-sm font-extrabold font-mono mt-0.5 ${backtest.sharpeRatio >= 1 ? 'text-blue-400' : backtest.sharpeRatio > 0 ? 'text-zinc-200' : 'text-zinc-500'}`}>
                      {fmt(backtest.sharpeRatio)}
                    </p>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">胜率</span>
                    <p className="text-sm font-extrabold font-mono mt-0.5 text-zinc-200">
                      {fmt(backtest.winRate)}% <span className="text-[10px] font-normal text-zinc-500 font-sans">({backtest.winningTrades}/{backtest.trades.filter(t => t.type === 'SELL').length})</span>
                    </p>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">总费用</span>
                    <p className="text-sm font-extrabold font-mono text-green-400">¥{fmt(backtest.totalFees)}</p>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 font-mono uppercase">交易次数</span>
                    <p className="text-sm font-extrabold font-mono text-zinc-200">{backtest.totalTrades}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Trades Ledger Table */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h5 className="text-xs font-bold text-zinc-400 uppercase tracking-wider text-left">交易账本</h5>
                <div className="flex items-center gap-2">
                  {!stepperMode && (
                    <button
                      onClick={handleStartStepper}
                      disabled={filteredKlines.length === 0 || !selectedStrategy}
                      className="shrink-0 px-3 py-1.5 font-semibold text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700 cursor-pointer transition-all flex items-center gap-1.5"
                      id="btn-start-stepper"
                      title="逐步回测"
                    >
                      <SkipForward className="h-3.5 w-3.5" />
                      <span>逐步回测</span>
                    </button>
                  )}
                  <button
                    onClick={handleExportCSV}
                    className="shrink-0 px-3 py-1.5 font-semibold text-xs rounded-lg bg-zinc-800 text-zinc-100 hover:bg-zinc-700 border border-zinc-700 cursor-pointer transition-all flex items-center gap-1.5"
                    id="btn-export-csv"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>导出 CSV</span>
                  </button>
                </div>
              </div>
              <div className="overflow-x-auto md:rounded-xl md:border md:border-zinc-800 bg-zinc-950">
                  <table className="w-full min-w-[560px] text-left text-xs text-zinc-300">
                    <thead className="bg-zinc-900 border-b border-zinc-800 text-zinc-500 font-mono font-semibold">
                      <tr>
                        <th className="px-4 py-2.5">日期</th>
                        <th className="px-4 py-2.5">类型</th>
                        <th className="px-4 py-2.5">执行价格</th>
                        <th className="px-4 py-2.5">交易分配</th>
                        <th className="px-4 py-2.5">交易费</th>
                        <th className="px-4 py-2.5 text-right">盈亏结果</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900 font-mono">
                      {backtest.trades.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="text-center py-6 text-zinc-500 font-sans">未触发任何交易。请尝试延长分析周期。</td>
                        </tr>
                      ) : (
                        backtest.trades.map((tr, i) => (
                          <tr key={`tr-led-${tr.id}-${i}`} className="hover:bg-zinc-900/40">
                            <td className="px-4 py-2 text-zinc-400 font-sans">{tr.date}</td>
                            <td className="px-4 py-2">
                              <span className={`px-2 py-0.5 rounded text-[10px] font-extrabold ${
                                tr.type === 'BUY' ? 'bg-red-950/30 text-red-400 border border-red-900/20' : 'bg-green-950/30 text-green-400 border border-green-900/20'
                              }`}>
                                {tr.type}
                              </span>
                            </td>
                            <td className="px-4 py-2 font-bold">¥{fmt(tr.price)}</td>
                            <td className="px-4 py-2 text-zinc-500">{tr.shares}股 (¥{fmt(tr.value)})</td>
                            <td className="px-4 py-2 text-zinc-500">¥{fmt(tr.fee ?? 0)}</td>
                            <td className={`px-4 py-2 text-right font-extrabold ${
                              tr.pnl !== undefined
                                ? (tr.pnl >= 0 ? 'text-red-400' : 'text-green-400')
                                : 'text-zinc-500 font-normal'
                            }`}>
                              {tr.pnl !== undefined ? `${tr.pnl >= 0 ? '+' : ''}¥${fmt(tr.pnl)} (${fmt(tr.pnlPercent ?? 0)}%)` : '--'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Strategy Dialog */}
      {strategyDialogOpen && (
        <StrategyDialog
          isOpen={strategyDialogOpen}
          onClose={() => setStrategyDialogOpen(false)}
          onStrategyCreated={handleStrategyCreated}
          onStrategySaved={handleStrategySaved}
          onStrategyDeleted={handleStrategyDeleted}
          existingStrategyIds={allStrategies.map((s) => s.id)}
          symbol={symbol}
        />
      )}
    </div>
  );
}
