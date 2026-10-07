import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Filter, Play, Square, Plus, X, Loader2, AlertTriangle, Search,
  ExternalLink, RefreshCw, Download, FlaskConical, ChevronDown, Wand2,
} from 'lucide-react';
import type {
  StrategyParamValue,
  UserStrategyDefinition,
} from '../types/strategy';
import { userStrategies } from '../strategies/user';
import { loadStoredStrategies } from '../utils/strategyLoader';
import { buildStrategyParams } from '../utils/strategyAdapter';
import { runBacktest } from '../utils/backtestRunner';
import {
  filterScreenerSignals,
  sortScreenerSignals,
  sliceKlinesByRange,
  yearsAgoStr,
  todayStr,
  SCREENER_DEFAULT_STRATEGY_IDS,
  type ScreenerSignal,
  type ScreenerSortKey,
} from '../utils/screener';
import { evaluateSignalWithFallback } from '../utils/analysisApi';
import {
  IndexId, INDEX_META, ParsedSymbol, parseSymbol, symbolKey,
  fetchIndexMembers, loadStockMeta, type StockMeta,
} from '../utils/indexAnalysisApi';
import { fetchStockData, clearStockDataMemoryCache, getStockDataMemoryCacheSize } from '../utils/api';
import ScreenerStrategyLab from './ScreenerStrategyLab';
import StrategyDialog from './StrategyDialog';

// ---------------------------------------------------------------------------
// 选股 pad: 策略框架 (AI 创建 -> 合成验证 -> 实盘抽测 -> 全量扫描 + 回测验证)
//   1. AI 创建: 策略实验室 -> StrategyDialog (screenerMode, generateScreenerStrategyCode)
//   2. 合成验证: ScreenerStrategyLab + screenerStrategyTest (5 套合成行情秒级干跑)
//   3. 实盘抽测: 8 只代表性个股信号 + 单股回测
//   4. 全量扫描: 对每只经多源链路拉取K线, 用策略 decide() 评估最新信号
//   5. 回测验证: 对 BUY 信号跑 runBacktest, 给出收益/夏普/胜率, 点击直达个股分析
// ---------------------------------------------------------------------------

const PREFS_KEY = 'chanlun_screener_prefs';
const CUSTOM_KEY = 'chanlun_screener_custom';
const STRATEGY_KEY = 'chanlun_screener_strategy';
const RANGE_KEY = 'chanlun_screener_range';
const CONCURRENCY = 6;

export interface ScreenerRow extends ScreenerSignal {
  code: string;
  name?: string;
  industryPath?: string;
  // 回测验证 (仅 BUY 且开启验证时填充)
  btReturn?: number;
  btSharpe?: number;
  btWinRate?: number;
  btTrades?: number;
  btTested?: boolean;
}

interface ScanProgress {
  running: boolean;
  total: number;
  done: number;
  ok: number;
  failed: number;
  buys: number;
}

function defaultPrefs(): Record<IndexId, boolean> {
  try {
    const saved = localStorage.getItem(PREFS_KEY);
    if (saved) return { hs300: true, zz500: true, ...JSON.parse(saved) };
  } catch { /* ignore */ }
  return { hs300: true, zz500: true };
}

export default function StockScreener({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
  // --- 策略 ---
  const [allStrategies, setAllStrategies] = useState<UserStrategyDefinition[]>([]);
  const [strategyId, setStrategyId] = useState<string>(() => {
    try { return localStorage.getItem(STRATEGY_KEY) || ''; } catch { return ''; }
  });
  const [customParams, setCustomParams] = useState<Record<string, StrategyParamValue>>({});

  // --- 范围 ---
  const [selectedIndexes, setSelectedIndexes] = useState<Record<IndexId, boolean>>(defaultPrefs);
  const [customSymbols, setCustomSymbols] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_KEY);
      if (saved) {
        const arr = JSON.parse(saved);
        if (Array.isArray(arr)) return arr.filter((s: unknown) => typeof s === 'string' && parseSymbol(s));
      }
    } catch { /* ignore */ }
    return [];
  });
  const [customInput, setCustomInput] = useState('');
  const [customError, setCustomError] = useState('');

  // --- 过滤/排序 ---
  const [onlyBuy, setOnlyBuy] = useState(true);
  const [verifyBacktest, setVerifyBacktest] = useState(true);
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<ScreenerSortKey>('confidenceDesc');

  // --- 回测区间 (默认近3年, 与个股回测页一致; 信号评估与回测验证共用) ---
  const [rangeStart, setRangeStart] = useState<string>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
      if (saved && typeof saved.start === 'string') return saved.start;
    } catch { /* ignore */ }
    return yearsAgoStr(3);
  });
  const [rangeEnd, setRangeEnd] = useState<string>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(RANGE_KEY) || 'null');
      if (saved && typeof saved.end === 'string') return saved.end;
    } catch { /* ignore */ }
    return todayStr();
  });

  const setRange = useCallback((start: string, end: string) => {
    setRangeStart(start);
    setRangeEnd(end);
    try { localStorage.setItem(RANGE_KEY, JSON.stringify({ start, end })); } catch { /* ignore */ }
  }, []);

  const applyPreset = useCallback((preset: '1y' | '3y' | 'all') => {
    if (preset === 'all') setRange('', '');
    else if (preset === '1y') setRange(yearsAgoStr(1), todayStr());
    else setRange(yearsAgoStr(3), todayStr());
  }, [setRange]);

  // --- 运行状态 ---
  const [progress, setProgress] = useState<ScanProgress>({ running: false, total: 0, done: 0, ok: 0, failed: 0, buys: 0 });
  const [rows, setRows] = useState<ScreenerRow[]>([]);
  const [meta, setMeta] = useState<StockMeta>({ names: {}, industries: {} });
  const [strategyDialogOpen, setStrategyDialogOpen] = useState(false);
  const [cacheSize, setCacheSize] = useState(() => getStockDataMemoryCacheSize());
  const abortRef = useRef<AbortController | null>(null);
  const scanningRef = useRef(false);
  const membersRef = useRef<Partial<Record<IndexId, string[]>>>({});

  const handleClearCache = useCallback(() => {
    clearStockDataMemoryCache();
    setCacheSize(0);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 加载策略列表, 默认选中选股推荐策略
  const reloadStrategies = useCallback((selectId?: string) => {
    const stored = loadStoredStrategies();
    const combined = [...userStrategies, ...stored];
    setAllStrategies(combined);
    setStrategyId((prev) => {
      const target = selectId || prev;
      if (target && combined.some((s) => s.id === target)) return target;
      if (prev && combined.some((s) => s.id === prev)) return prev;
      for (const id of SCREENER_DEFAULT_STRATEGY_IDS) {
        if (combined.some((s) => s.id === id)) return id;
      }
      return combined[0]?.id ?? '';
    });
  }, []);

  useEffect(() => {
    reloadStrategies();
    loadStockMeta().then(setMeta).catch(() => {});
  }, [reloadStrategies]);

  const strategy = useMemo(
    () => allStrategies.find((s) => s.id === strategyId) ?? null,
    [allStrategies, strategyId],
  );

  const stopScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    scanningRef.current = false;
    setProgress((p) => ({ ...p, running: false }));
  }, []);

  // 切换策略时重置参数为默认值并终止上一轮未完成的扫描
  useEffect(() => {
    if (!strategy) return;
    if (scanningRef.current) {
      stopScan();
    }
    setCustomParams(buildStrategyParams(strategy));
    try { localStorage.setItem(STRATEGY_KEY, strategy.id); } catch { /* ignore */ }
  }, [strategy?.id, stopScan]);

  const setParam = useCallback((key: string, value: StrategyParamValue) => {
    setCustomParams((prev) => ({ ...prev, [key]: value }));
  }, []);

  const toggleIndex = (id: IndexId) => {
    setSelectedIndexes((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const addCustom = () => {
    const parsed: ParsedSymbol | null = parseSymbol(customInput);
    if (!parsed) {
      setCustomError('无法识别代码, 支持 6 位数字或后缀形式 (如 600519.SH / sh600519)');
      return;
    }
    const key = symbolKey(parsed);
    setCustomError('');
    setCustomInput('');
    setCustomSymbols((prev) => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const removeCustom = (key: string) => {
    setCustomSymbols((prev) => {
      const next = prev.filter((k) => k !== key);
      try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const startScan = useCallback(async () => {
    if (!strategy) return;

    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    scanningRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    const paramsSnapshot = { ...customParams };
    const verifySnapshot = verifyBacktest;
    const stratSnapshot = strategy;
    const rangeSnapshot = { start: rangeStart, end: rangeEnd };

    try {
      // 1. 组装宇宙
      const universe: string[] = [];
      const pushUnique = (list: string[]) => {
        for (const s of list) if (!universe.includes(s)) universe.push(s);
      };
      const ids = (Object.keys(selectedIndexes) as IndexId[]).filter((id) => selectedIndexes[id]);
      await Promise.all(ids.map(async (id) => {
        if (!membersRef.current[id]) membersRef.current[id] = await fetchIndexMembers(id);
        pushUnique(membersRef.current[id]!);
      }));
      pushUnique(customSymbols);

      setRows([]);
      setCustomError('');
      setProgress({ running: true, total: universe.length, done: 0, ok: 0, failed: 0, buys: 0 });

      let cursor = 0;
      let done = 0;
      let ok = 0;
      let failed = 0;
      let buys = 0;

      const worker = async () => {
        while (cursor < universe.length && !controller.signal.aborted) {
          const sym = universe[cursor++];
          try {
            // 多源K线 (与个股分析/回测同链路):
            // A股 腾讯/TickFlow · 美股 TwelveData · 港股/指数 腾讯 · 加密 Binance · 期货外汇 新浪
            const { klines: full } = await fetchStockData(sym, 'daily');
            // 回测区间切片: 信号评估与回测验证共用同一区间 (默认近3年)
            const klines = sliceKlinesByRange(full, rangeSnapshot.start, rangeSnapshot.end);
            if (klines.length === 0) throw new Error('区间内无K线数据');
            const sig = await evaluateSignalWithFallback(stratSnapshot, klines, sym, paramsSnapshot);
            const code = sym.split('.')[0];
            const row: ScreenerRow = {
              ...sig,
              code,
              name: meta.names[code] ?? metaRef.current.names[code],
              industryPath: meta.industries[code] ?? metaRef.current.industries[code],
              btTested: false,
            };
            // 回测验证: 仅对 BUY 信号跑单股回测, 给出收益/夏普/胜率
            if (verifySnapshot && sig.action === 'BUY') {
              try {
                const { result } = runBacktest({
                  klines,
                  symbol: sym,
                  userId: 'screener',
                  initialCash: 100000,
                  currency: 'CNY',
                  strategy: stratSnapshot,
                  params: paramsSnapshot,
                });
                row.btReturn = Math.round(result.totalReturnPercent * 100) / 100;
                row.btSharpe = Math.round(result.sharpeRatio * 100) / 100;
                row.btWinRate = Math.round(result.winRate * 10) / 10;
                row.btTrades = result.totalTrades;
                row.btTested = true;
              } catch { /* 回测失败不阻塞, 保留信号本身 */ }
            }
            ok++;
            if (sig.action === 'BUY') {
              buys++;
              setRows((prev) => [...prev, row]);
            } else if (!onlyBuyRef.current) {
              setRows((prev) => [...prev, row]);
            }
          } catch (err: unknown) {
            if ((err as Error)?.name === 'AbortError') return;
            failed++;
          } finally {
            done++;
            setProgress({ running: true, total: universe.length, done, ok, failed, buys });
          }
        }
      };

      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } catch (err: unknown) {
      console.error('Screener scan error:', err);
      setCustomError('选股运行失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      scanningRef.current = false;
      abortRef.current = null;
      setProgress((p) => ({ ...p, running: false }));
      setCacheSize(getStockDataMemoryCacheSize());
    }
  }, [strategy, selectedIndexes, customSymbols, customParams, verifyBacktest, meta, rangeStart, rangeEnd]);

  // refs for worker closure (avoid stale filter/meta)
  const onlyBuyRef = useRef(onlyBuy);
  onlyBuyRef.current = onlyBuy;
  const metaRef = useRef(meta);
  metaRef.current = meta;

  // --- 展示: 查询/排序 ---
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = filterScreenerSignals(rows, { onlyBuy });
    const searched = q
      ? filtered.filter((r) => r.code.includes(q) || (r.name || '').toLowerCase().includes(q))
      : filtered;
    return sortScreenerSignals(searched, sortBy);
  }, [rows, onlyBuy, query, sortBy]);

  const buyCount = useMemo(() => rows.filter((r) => r.action === 'BUY').length, [rows]);
  const anyUniverse = selectedIndexes.hs300 || selectedIndexes.zz500 || customSymbols.length > 0;

  const openInAnalyzer = (row: ScreenerRow) => {
    onSelectStock?.(row.symbol.replace('.SH', '.SS'));
  };

  const exportCSV = () => {
    const head = ['代码', '名称', '信号', '置信度', '现价', '涨跌%', '量比', '理由', '回测收益%', '夏普', '胜率%', '交易数', '数据日期'];
    const lines = visibleRows.map((r) => [
      r.code, r.name || '', r.action, r.confidence ?? '',
      r.close.toFixed(2), r.changePct.toFixed(2), r.volRatio ?? '',
      `"${(r.reason || '').replace(/"/g, '""')}"`,
      r.btReturn ?? '', r.btSharpe ?? '', r.btWinRate ?? '', r.btTrades ?? '', r.dataDate,
    ].join(','));
    const csv = [head.join(','), ...lines].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `screener_${strategyId}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-9 w-9 rounded-xl bg-blue-500/10 border border-blue-500/20 shrink-0">
          <Filter className="h-4 w-4 text-blue-400" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-zinc-50 leading-tight">策略选股</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            选择策略一键扫描成分股最新信号, 买入信号自动附带单股回测验证 (收益/夏普/胜率)
          </p>
        </div>
      </div>

      {/* 策略选择 + 参数 */}
      <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 md:p-5 space-y-4">
        <div className="space-y-2">
          {/* 选择行: 下拉框 + AI 创建 (同高) */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <select
                value={strategyId}
                onChange={(e) => setStrategyId(e.target.value)}
                disabled={progress.running}
                aria-label="默认策略"
                className="w-full h-9 pl-2.5 pr-8 rounded-lg bg-zinc-950/60 border border-zinc-800 text-xs text-zinc-100 focus:outline-none focus:border-blue-500/60 cursor-pointer disabled:opacity-50 appearance-none"
              >
                {allStrategies.length === 0 && (
                  <option value="">暂无可用策略, 请点击「AI 创建」生成</option>
                )}
                {allStrategies.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
            </div>
            <button
              onClick={() => setStrategyDialogOpen(true)}
              className="shrink-0 inline-flex items-center gap-1 h-9 px-2.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-violet-300 text-[11px] font-bold hover:bg-violet-500/20 active:bg-violet-500/30 transition-colors cursor-pointer"
              title="用 AI 创建选股策略, 保存后自动可选"
            >
              <Wand2 className="h-3 w-3" />
              AI 创建
            </button>
          </div>
          {/* 信息 + 开关单行: 标签 + 简介(截断) + 开关 */}
          {strategy && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {(SCREENER_DEFAULT_STRATEGY_IDS as readonly string[]).includes(strategy.id) && (
                <span className="px-1 py-px rounded border border-blue-500/30 bg-blue-500/10 text-[10px] font-bold text-blue-300 shrink-0">推荐</span>
              )}
              {strategy.requiresChanLun && (
                <span className="px-1 py-px rounded border border-violet-500/30 bg-violet-500/10 text-[10px] font-bold text-violet-300 shrink-0">缠论</span>
              )}
              {!userStrategies.some((s) => s.id === strategy.id) && (
                <span className="px-1 py-px rounded border border-emerald-500/30 bg-emerald-500/10 text-[10px] font-bold text-emerald-300 shrink-0">自定</span>
              )}
              {strategy.description && (
                <span className="text-[11px] text-zinc-500 truncate flex-1 min-w-[100px]" title={strategy.description}>{strategy.description}</span>
              )}
              <button
                onClick={() => setOnlyBuy((v) => !v)}
                title="仅展示买入信号"
                className={`shrink-0 inline-flex items-center gap-1.5 h-6 pl-1 pr-2 rounded-full border text-[10px] font-medium transition-all cursor-pointer ${onlyBuy ? 'border-blue-500/50 bg-blue-500/10 text-blue-300' : 'border-zinc-800 bg-zinc-950/60 text-zinc-500 hover:text-zinc-300'}`}
              >
                <span className={`relative h-3.5 w-6 rounded-full transition-colors ${onlyBuy ? 'bg-blue-500' : 'bg-zinc-700'}`}>
                  <span className={`absolute top-px h-2.5 w-2.5 rounded-full bg-white transition-all ${onlyBuy ? 'left-3' : 'left-px'}`} />
                </span>
                只看买入
              </button>
              <button
                onClick={() => setVerifyBacktest((v) => !v)}
                title="对每个买入信号跑一次单股回测 (回测区间K线, 10万本金), 给出收益/夏普/胜率"
                className={`shrink-0 inline-flex items-center gap-1.5 h-6 pl-1 pr-2 rounded-full border text-[10px] font-medium transition-all cursor-pointer ${verifyBacktest ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-zinc-800 bg-zinc-950/60 text-zinc-500 hover:text-zinc-300'}`}
              >
                <span className={`relative h-3.5 w-6 rounded-full transition-colors ${verifyBacktest ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                  <span className={`absolute top-px h-2.5 w-2.5 rounded-full bg-white transition-all ${verifyBacktest ? 'left-3' : 'left-px'}`} />
                </span>
                <FlaskConical className="h-2.5 w-2.5" />
                回测验证
              </button>
            </div>
          )}
        </div>

        {/* 策略参数 */}
        {strategy?.params && strategy.params.length > 0 && (
          <div>
            <label className="block text-xs font-semibold text-zinc-400 mb-2">策略参数</label>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {strategy.params.map((p) => (
                <label key={p.key} className="block rounded-lg bg-zinc-950/60 border border-zinc-800/70 px-2.5 py-2">
                  <span className="block text-[10px] text-zinc-500 truncate" title={p.key}>{p.label}</span>
                  {p.type === 'boolean' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(customParams[p.key] ?? p.defaultValue)}
                      disabled={progress.running}
                      onChange={(e) => setParam(p.key, e.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-zinc-600 text-blue-500 disabled:opacity-50"
                    />
                  ) : (
                    <input
                      type="number"
                      value={Number(customParams[p.key] ?? p.defaultValue)}
                      min={p.min}
                      max={p.max}
                      step={p.step ?? 1}
                      disabled={progress.running}
                      onChange={(e) => setParam(p.key, parseFloat(e.target.value))}
                      className="mt-1 w-full bg-transparent text-xs font-mono text-zinc-100 focus:outline-none disabled:opacity-50"
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* 策略实验室: AI 创建 -> 合成验证 -> 实盘抽测 */}
        <ScreenerStrategyLab
          strategy={strategy}
          customParams={customParams}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          onOpenAiDialog={() => setStrategyDialogOpen(true)}
        />

        {/* 回测区间 (信号评估与回测验证共用, 默认近3年) */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-zinc-600 font-semibold uppercase tracking-wider mr-0.5">回测区间</span>
          {(['1y', '3y', 'all'] as const).map((p) => {
            const active = p === 'all'
              ? !rangeStart && !rangeEnd
              : p === '1y'
                ? rangeStart === yearsAgoStr(1) && rangeEnd === todayStr()
                : rangeStart === yearsAgoStr(3) && rangeEnd === todayStr();
            return (
              <button
                key={p}
                onClick={() => applyPreset(p)}
                disabled={progress.running}
                className={`px-2 py-1 rounded-md border text-[10px] font-medium transition-all cursor-pointer disabled:opacity-50 ${
                  active
                    ? 'border-blue-500/60 bg-blue-500/10 text-blue-400'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {p === '1y' ? '近1年' : p === '3y' ? '近3年' : '全部'}
              </button>
            );
          })}
          <input
            type="date"
            value={rangeStart}
            max={rangeEnd || undefined}
            onChange={(e) => setRange(e.target.value, rangeEnd)}
            disabled={progress.running}
            className="h-7 px-1.5 rounded-md bg-zinc-950/60 border border-zinc-800 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-blue-500/60 disabled:opacity-50 [color-scheme:dark]"
          />
          <span className="text-zinc-600 text-[10px]">→</span>
          <input
            type="date"
            value={rangeEnd}
            min={rangeStart || undefined}
            onChange={(e) => setRange(rangeStart, e.target.value)}
            disabled={progress.running}
            className="h-7 px-1.5 rounded-md bg-zinc-950/60 border border-zinc-800 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-blue-500/60 disabled:opacity-50 [color-scheme:dark]"
          />
        </div>

        {/* 范围 */}
        <div className="flex flex-col lg:flex-row lg:items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-zinc-600 font-semibold uppercase tracking-wider mr-0.5">范围</span>
            {(Object.keys(INDEX_META) as IndexId[]).map((id) => (
              <button
                key={id}
                onClick={() => toggleIndex(id)}
                disabled={progress.running}
                className={`px-2.5 py-1.5 rounded-md border text-[11px] font-medium transition-all cursor-pointer disabled:opacity-50 ${
                  selectedIndexes[id]
                    ? 'border-blue-500/60 bg-blue-500/10 text-blue-400'
                    : 'border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {INDEX_META[id].label}成分
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); addCustom(); }}
            className="flex items-center gap-1 h-9 px-1 pl-2.5 rounded-md bg-zinc-950/60 border border-zinc-800 focus-within:border-blue-500/60 transition-colors w-full sm:w-auto"
          >
            <Plus className="h-3 w-3 text-zinc-500 shrink-0" />
            <input
              value={customInput}
              onChange={(e) => { setCustomInput(e.target.value); setCustomError(''); }}
              placeholder="添加股票/指数/ETF"
              enterKeyHint="done"
              className="flex-1 sm:flex-none sm:w-40 min-w-0 bg-transparent text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
            />
            <button
              type="submit"
              disabled={progress.running}
              className="h-7 px-3 rounded bg-zinc-800 hover:bg-blue-500 active:bg-blue-600 hover:text-white text-zinc-300 text-[10px] font-semibold transition-all cursor-pointer disabled:opacity-40 shrink-0"
            >
              加入
            </button>
          </form>
          <div className="flex items-center gap-2 w-full sm:w-auto sm:ml-auto lg:ml-auto">
            {cacheSize > 0 && !progress.running && (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400 font-mono">
                <span>内存已缓存 {cacheSize} 只股票</span>
                <button
                  onClick={handleClearCache}
                  className="text-emerald-400 hover:text-emerald-200 underline cursor-pointer"
                  title="清除内存中已缓存的股票K线数据"
                >
                  清除
                </button>
              </span>
            )}
            {progress.running ? (
              <button
                onClick={stopScan}
                className="flex flex-1 sm:flex-none items-center justify-center gap-1.5 h-8 px-3 rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 text-[11px] font-semibold cursor-pointer hover:bg-red-500/20"
              >
                <Square className="h-3 w-3 fill-current" />
                停止
              </button>
            ) : (
              <button
                onClick={startScan}
                disabled={!anyUniverse || !strategy}
                className="flex flex-1 sm:flex-none items-center justify-center gap-1.5 h-8 px-3.5 rounded-lg bg-blue-500 hover:bg-blue-400 active:bg-blue-600 text-white text-[11px] font-bold cursor-pointer shadow-sm shadow-blue-500/20 disabled:opacity-40"
              >
                <Play className="h-3 w-3 fill-current" />
                运行选股
              </button>
            )}
          </div>
        </div>

        {customSymbols.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {customSymbols.map((key) => (
              <span key={key} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-violet-500/25 bg-violet-500/10 text-[10px] font-mono text-violet-300">
                {key.split('.')[0]}
                <button onClick={() => removeCustom(key)} disabled={progress.running} className="hover:text-red-400 cursor-pointer disabled:opacity-40">
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        {customError && (
          <div className="px-3 py-2 rounded-lg bg-amber-950/20 border border-amber-900/30 text-amber-400 text-xs flex items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            {customError}
          </div>
        )}

        {/* 进度 */}
        {(progress.running || progress.total > 0) && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500">
              <span className="flex items-center gap-1.5">
                {progress.running && <Loader2 className="h-3 w-3 animate-spin text-blue-400" />}
                {progress.running ? `扫描中 ${progress.done}/${progress.total}` : `完成 ${progress.done}/${progress.total}`}
              </span>
              <span>
                买入 <span className="text-red-400 font-semibold">{progress.buys}</span>
                {progress.failed > 0 && <span className="text-amber-500"> · 失败 {progress.failed}</span>}
              </span>
            </div>
            <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 transition-all duration-200"
                style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 过滤条 */}
      {rows.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-zinc-900/70 border border-zinc-800/60 focus-within:border-blue-500/60 transition-colors">
            <Search className="h-3 w-3 text-zinc-500" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索代码/名称"
              className="w-28 bg-transparent text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <div className="relative">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as ScreenerSortKey)}
              className="h-7 pl-2 pr-7 rounded-md bg-zinc-900/70 border border-zinc-800/60 text-[11px] text-zinc-300 focus:outline-none focus:border-blue-500/60 cursor-pointer appearance-none"
            >
              <option value="confidenceDesc">信号优先</option>
              <option value="changeDesc">涨幅优先</option>
              <option value="changeAsc">跌幅优先</option>
              <option value="symbolAsc">按代码</option>
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-zinc-500 pointer-events-none" />
          </div>
          <span className="text-[10px] font-mono text-zinc-600 ml-auto">
            显示 {visibleRows.length} 只 · 买入 <span className="text-red-400">{buyCount}</span>
          </span>
          {visibleRows.length > 0 && (
            <button
              onClick={exportCSV}
              className="flex items-center gap-1 h-7 px-2.5 rounded-md bg-zinc-900/70 border border-zinc-800 text-[11px] text-zinc-400 hover:text-blue-400 hover:border-blue-500/40 cursor-pointer"
            >
              <Download className="h-3 w-3" />
              导出
            </button>
          )}
        </div>
      )}

      {/* 结果表 */}
      <div className="rounded-xl border border-zinc-800/80 overflow-hidden">
        {visibleRows.length === 0 ? (
          <div className="min-h-[200px] flex flex-col items-center justify-center gap-2 py-12 text-center px-6">
            {progress.running ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-400" />
                <p className="text-xs text-zinc-500">正在扫描, 买入信号将实时出现...</p>
              </>
            ) : (
              <>
                <Filter className="h-6 w-6 text-zinc-700" />
                <p className="text-xs text-zinc-500">选择策略与范围后点击「运行选股」, 将逐只评估最新策略信号{verifyBacktest ? '并做回测验证' : ''}</p>
                <button
                  onClick={startScan}
                  disabled={!anyUniverse || !strategy}
                  className="mt-2 flex items-center gap-1.5 h-8 px-4 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-xs font-bold cursor-pointer disabled:opacity-40"
                >
                  <Play className="h-3 w-3 fill-current" />
                  运行选股
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="hidden md:block overflow-auto max-h-[calc(100vh-320px)]">
              <table className="w-full min-w-[860px] text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800">
                  <tr className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                    <th className="px-3 py-2.5 font-mono">信号</th>
                    <th className="px-3 py-2.5 font-mono">代码</th>
                    <th className="px-3 py-2.5">名称</th>
                    <th className="px-3 py-2.5">板块</th>
                    <th className="px-3 py-2.5 text-right font-mono">现价</th>
                    <th className="px-3 py-2.5 text-right font-mono">涨跌</th>
                    <th className="px-3 py-2.5 text-right font-mono">量比</th>
                    <th className="px-3 py-2.5 text-right font-mono">回测收益</th>
                    <th className="px-3 py-2.5 text-right font-mono">夏普/胜率</th>
                    <th className="px-3 py-2.5 text-right font-mono">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map((r) => (
                    <tr
                      key={r.symbol}
                      onClick={() => openInAnalyzer(r)}
                      className="border-b border-zinc-900 hover:bg-zinc-900/40 cursor-pointer group"
                      title={`${r.code}${r.name ? ` ${r.name}` : ''} · ${r.reason || ''} · 点击在个股分析中打开`}
                    >
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold ${
                          r.action === 'BUY'
                            ? 'bg-red-500/15 text-red-400 border-red-500/30'
                            : r.action === 'SELL'
                              ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                              : 'bg-zinc-500/10 text-zinc-500 border-zinc-700/50'
                        }`}>
                          {r.action}
                          {r.confidence != null && <span className="ml-1 font-mono opacity-70">{r.confidence.toFixed(2)}</span>}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[11px] font-mono font-semibold text-zinc-200">{r.code}</td>
                      <td className="px-3 py-2 text-[11px] text-zinc-400 max-w-[110px] truncate">{r.name || '—'}</td>
                      <td className="px-3 py-2 text-[11px] text-zinc-400 max-w-[100px] truncate" title={r.industryPath}>
                        {r.industryPath ? r.industryPath.split(' > ').pop() : '—'}
                      </td>
                      <td className="px-3 py-2 text-[11px] font-mono text-zinc-200 text-right tabular-nums">{r.close.toFixed(2)}</td>
                      <td className={`px-3 py-2 text-[11px] font-mono text-right tabular-nums ${r.changePct > 0 ? 'text-red-400' : r.changePct < 0 ? 'text-green-400' : 'text-zinc-500'}`}>
                        {r.changePct > 0 ? '+' : ''}{r.changePct.toFixed(2)}%
                      </td>
                      <td className={`px-3 py-2 text-[11px] font-mono text-right tabular-nums ${(r.volRatio ?? 0) >= 1.5 ? 'text-red-400' : 'text-zinc-400'}`}>
                        {r.volRatio != null ? r.volRatio.toFixed(2) : '—'}
                      </td>
                      <td className={`px-3 py-2 text-[11px] font-mono font-semibold text-right tabular-nums ${
                        r.btReturn == null ? 'text-zinc-700' : r.btReturn > 0 ? 'text-red-400' : r.btReturn < 0 ? 'text-green-400' : 'text-zinc-400'
                      }`}>
                        {r.btTested && r.btReturn != null ? `${r.btReturn > 0 ? '+' : ''}${r.btReturn.toFixed(2)}%` : '—'}
                      </td>
                      <td className="px-3 py-2 text-[11px] font-mono text-zinc-400 text-right tabular-nums whitespace-nowrap">
                        {r.btTested ? `${r.btSharpe?.toFixed(2) ?? '—'} / ${r.btWinRate?.toFixed(1) ?? '—'}%` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={(e) => { e.stopPropagation(); openInAnalyzer(r); }}
                          className="inline-flex items-center gap-1 text-[10px] text-blue-400/70 hover:text-blue-300 cursor-pointer opacity-60 group-hover:opacity-100"
                        >
                          <ExternalLink className="h-3 w-3" />
                          分析
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Mobile cards */}
            <div className="md:hidden overflow-y-auto max-h-[calc(100vh-320px)] divide-y divide-zinc-900">
              {visibleRows.map((r) => (
                <article key={r.symbol} onClick={() => openInAnalyzer(r)} className="px-3 py-2.5 active:bg-zinc-900/60 cursor-pointer">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`px-1.5 py-0.5 rounded border text-[10px] font-bold shrink-0 ${
                      r.action === 'BUY' ? 'bg-red-500/15 text-red-400 border-red-500/30' : 'bg-zinc-500/10 text-zinc-500 border-zinc-700/50'
                    }`}>{r.action}</span>
                    <span className="text-[11px] font-mono font-semibold text-zinc-100">{r.code}</span>
                    <span className="text-[11px] text-zinc-400 truncate flex-1 min-w-0">{r.name || '—'}</span>
                    <span className="text-[11px] font-mono text-zinc-200 tabular-nums shrink-0">{r.close.toFixed(2)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] font-mono text-zinc-500">
                    <span className={r.changePct > 0 ? 'text-red-400' : r.changePct < 0 ? 'text-green-400' : ''}>
                      {r.changePct > 0 ? '+' : ''}{r.changePct.toFixed(2)}%
                    </span>
                    {r.btTested && r.btReturn != null && (
                      <span className={r.btReturn > 0 ? 'text-red-400' : 'text-green-400'}>
                        回测 {r.btReturn > 0 ? '+' : ''}{r.btReturn.toFixed(1)}%
                      </span>
                    )}
                    <span className="ml-auto truncate">{r.reason || ''}</span>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </div>

      <p className="text-[10px] text-zinc-600 leading-relaxed">
        数据: 多源K线 (A股 TickFlow · 美股 TwelveData · 港股/指数 腾讯 · 加密 Binance · 期货外汇 新浪, 前复权) · 信号为策略 decide() 在最新一根 K 线的空仓评估结果 ·
        回测验证为单股 10 万本金全历史回测, 仅供研究参考, 不构成投资建议。
      </p>

      {/* 隐藏的刷新按钮占位 (保持与其它 pad 一致的工具栏语义) */}
      <span className="hidden">
        <RefreshCw className="h-3 w-3" />
      </span>

      {/* AI 策略创建 (选股专用 prompt) */}
      <StrategyDialog
        isOpen={strategyDialogOpen}
        onClose={() => setStrategyDialogOpen(false)}
        onStrategyCreated={(def) => {
          setStrategyDialogOpen(false);
          reloadStrategies(def.id);
        }}
        onStrategySaved={() => {
          reloadStrategies();
        }}
        onStrategyDeleted={() => {
          reloadStrategies();
        }}
        existingStrategyIds={allStrategies.map((s) => s.id)}
        screenerMode
      />
    </div>
  );
}
