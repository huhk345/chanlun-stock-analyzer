import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Radar, Play, Square, Plus, X, Loader2, AlertTriangle, Search, ExternalLink,
  ArrowUpRight, ArrowDownRight, RefreshCw, Database, Star,
} from 'lucide-react';
import { formatSignedYi } from '../utils/marketApi';
import { WatchItem, loadWatchlist, upsertWatchlist, removeFromWatchlist } from '../utils/watchlistStorage';
import { ScanSocket, type ScanConnectionState } from '../utils/scanSocket';
import { parseSymbol, symbolKey, kindLabel, type ParsedSymbol } from '../utils/indexAnalysisApi';
import {
  ALL_BS_TYPES, INDEX_META, SIGNAL_WINDOW_DAYS,
  type IndexId, type ScanCacheInfo, type ScanClientMessage, type ScanProgress,
  type ScanServerMessage, type ScanSignalRow, type ScanTimeframe, type StockFlow,
} from '../types/scan';
import type { BSPointType } from '../types/stock';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

const CUSTOM_KEY = 'chanlun_scan_custom';
const PREFS_KEY = 'chanlun_scan_prefs';
const SCAN_TF_KEY = 'chanlun_scan_timeframe';

const ALL_TYPES = ALL_BS_TYPES;

const EMPTY_PROGRESS: ScanProgress = { total: 0, done: 0, ok: 0, failed: 0, cached: 0, signalCount: 0 };

export const TYPE_STYLE: Record<BSPointType, string> = {
  B1: 'bg-red-500/15 text-red-400 border-red-500/30',
  B2: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  B3: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
  S1: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  S2: 'bg-teal-500/15 text-teal-400 border-teal-500/30',
  S3: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
};

// ---------------------------------------------------------------------------
// 主组件
//
// 扫描全部由后端完成: 浏览器只通过 WebSocket 下发扫描请求, 服务端负责
// 拉 K 线、算缠论买卖点、按 90 天窗口出信号行, 再把进度与结果增量推回来。
// 这里只做: 组装扫描范围 -> 收发消息 -> 筛选/排序/自选/展示。
// ---------------------------------------------------------------------------

export default function IndexAnalysis({ onSelectStock }: { onSelectStock?: (symbol: string, tf?: ScanTimeframe) => void }) {
  // 宇宙选择 (默认沪深300 + 中证500)
  const [selectedIndexes, setSelectedIndexes] = useState<Record<IndexId, boolean>>(() => {
    try {
      const saved = localStorage.getItem(PREFS_KEY);
      if (saved) return { hs300: true, zz500: true, ...JSON.parse(saved) };
    } catch { /* ignore */ }
    return { hs300: true, zz500: true };
  });

  // 自定义添加的标的
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

  // 扫描周期: 日线 / 周线 (所有指数/成分股/自定义标的统一按该周期扫描)
  const [scanTimeframe, setScanTimeframe] = useState<ScanTimeframe>(() => {
    try {
      if (localStorage.getItem(SCAN_TF_KEY) === 'weekly') return 'weekly';
    } catch { /* ignore */ }
    return 'daily';
  });
  const scanTimeframeRef = useRef<ScanTimeframe>(scanTimeframe);
  scanTimeframeRef.current = scanTimeframe;

  // 与后端的扫描通道 (WebSocket)
  const socketRef = useRef<ScanSocket | null>(null);
  const [conn, setConn] = useState<ScanConnectionState>('connecting');
  const [serverError, setServerError] = useState('');

  // 扫描状态与结果 (全部来自后端推送)
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const [progress, setProgress] = useState<ScanProgress>(EMPTY_PROGRESS);
  const [rows, setRows] = useState<ScanSignalRow[]>([]);
  const [cacheInfo, setCacheInfo] = useState<ScanCacheInfo>(() => ({
    timeframe: scanTimeframe, count: 0, latestDate: '', stale: false,
  }));
  /** 首次进入: 后端缓存快照是否已加载完成 */
  const [hydrated, setHydrated] = useState(false);
  /** 最近一次扫描请求: 断线重连后据此挂回同一个后端任务 */
  const lastScanRef = useRef<ScanClientMessage | null>(null);

  // 个股当日主力资金流向 (后端随扫描结果一起推送)
  const [flowMap, setFlowMap] = useState<Record<string, StockFlow>>({});

  // 过滤与排序
  const [typeFilter, setTypeFilter] = useState<Set<BSPointType>>(new Set(ALL_TYPES));
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'dateDesc' | 'dateAsc' | 'code'>('dateDesc');
  const [hideNoName, setHideNoName] = useState(false);

  // 自选股: 从信号行加入 (可填理由), 在市场总览页跟踪加入以来涨跌
  const [watchlist, setWatchlist] = useState<WatchItem[]>(() => loadWatchlist());
  const [watchDialogRow, setWatchDialogRow] = useState<ScanSignalRow | null>(null);
  const [watchReason, setWatchReason] = useState('');
  const watchedKeys = useMemo(() => new Set(watchlist.map(w => w.symbolKey)), [watchlist]);

  // -------------------------------------------------------------------------
  // 扫描控制
  // -------------------------------------------------------------------------

  /** 供消息处理器回调 (缓存过期时自动增量刷新), 避免 useCallback 相互依赖 */
  const startScanRef = useRef<(force?: boolean) => void>(() => {});

  const startScan = useCallback((force = false) => {
    if (runningRef.current) return;
    const ids = (Object.keys(selectedIndexes) as IndexId[]).filter(id => selectedIndexes[id]);
    const request: ScanClientMessage = {
      type: 'scan',
      timeframe: scanTimeframeRef.current,
      indexes: ids,
      custom: customSymbols,
      force,
    };
    lastScanRef.current = request;
    runningRef.current = true;
    setRunning(true);
    setServerError('');
    setRows([]);
    setProgress(EMPTY_PROGRESS);
    socketRef.current?.send(request);
  }, [customSymbols, selectedIndexes]);
  startScanRef.current = startScan;

  const stopScan = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || socket.state !== 'open') {
      // 通道已断: 服务端收不到 cancel, 本地直接结束 (缓存已由服务端落盘)
      runningRef.current = false;
      setRunning(false);
      return;
    }
    socket.send({ type: 'cancel' });
  }, []);

  /** 切换日线/周线: 换用对应周期的后端缓存并秒开 */
  const handleScanTimeframeChange = useCallback((next: ScanTimeframe) => {
    if (next === scanTimeframeRef.current || runningRef.current) return;
    try { localStorage.setItem(SCAN_TF_KEY, next); } catch { /* ignore */ }
    setScanTimeframe(next);
    scanTimeframeRef.current = next;
    lastScanRef.current = null;
    setRows([]);
    setProgress(EMPTY_PROGRESS);
    setFlowMap({});
    setCacheInfo({ timeframe: next, count: 0, latestDate: '', stale: false });
    setHydrated(false);
    socketRef.current?.send({ type: 'cache', timeframe: next });
  }, []);

  // -------------------------------------------------------------------------
  // 通道生命周期 + 消息分发
  // -------------------------------------------------------------------------

  const handleServerMessage = useCallback((msg: ScanServerMessage) => {
    switch (msg.type) {
      case 'cache':
        // 扫描进行中忽略过期快照, 避免覆盖正在推送的结果
        if (runningRef.current || msg.timeframe !== scanTimeframeRef.current) break;
        setRows(msg.rows);
        setCacheInfo(msg.info);
        setFlowMap(prev => ({ ...prev, ...msg.flows }));
        setServerError('');
        setHydrated(true);
        // 缓存整体落后于预期交易日: 自动增量刷新 (零请求复用已最新条目)
        if (msg.info.count > 0 && msg.info.stale) startScanRef.current(false);
        break;

      case 'scan-start':
        if (msg.timeframe !== scanTimeframeRef.current) break;
        runningRef.current = true;
        setRunning(true);
        setServerError('');
        setProgress(msg.progress);
        // 新一轮扫描 (含断线重连重放): 以服务端进度为准, 重置已收到的结果
        setRows([]);
        break;

      case 'progress':
        if (!runningRef.current) break;
        setProgress(msg.progress);
        break;

      case 'rows':
        if (!runningRef.current) break;
        setRows(prev => [...prev, ...msg.rows]);
        break;

      case 'flows':
        setFlowMap(prev => ({ ...prev, ...msg.flows }));
        break;

      case 'done':
        runningRef.current = false;
        setRunning(false);
        setCacheInfo(msg.info);
        setHydrated(true);
        break;

      case 'error':
        runningRef.current = false;
        setRunning(false);
        setServerError(msg.message);
        setHydrated(true);
        break;

      case 'pong':
        break;
    }
  }, []);

  useEffect(() => {
    const socket = new ScanSocket(
      msg => handleServerMessage(msg),
      state => {
        setConn(state);
        if (state === 'closed') setHydrated(true); // 后端不可用时也要结束加载态
      },
    );
    socketRef.current = socket;
    socket.connect();
    return () => {
      socket.dispose();
      socketRef.current = null;
    };
  }, [handleServerMessage]);

  // 连上 (含断线重连) 后: 挂回正在跑的扫描, 否则拉一次缓存快照秒开
  useEffect(() => {
    if (conn !== 'open') return;
    const socket = socketRef.current;
    if (!socket) return;
    // 重连只做「挂回」: 去掉 force, 让服务端把当前任务进度与已产出结果重放一遍
    const last = lastScanRef.current;
    const resume = runningRef.current && last?.type === 'scan' ? { ...last, force: false } : null;
    socket.send(resume ?? { type: 'cache', timeframe: scanTimeframeRef.current });
  }, [conn]);

  // -------------------------------------------------------------------------
  // 自选股操作
  // -------------------------------------------------------------------------

  const openWatchDialog = (row: ScanSignalRow) => {
    setWatchReason(`缠论${row.label} · 信号价 ${row.price.toFixed(2)} · ${row.date}`);
    setWatchDialogRow(row);
  };

  const confirmAddWatch = () => {
    if (!watchDialogRow) return;
    const row = watchDialogRow;
    const item: WatchItem = {
      symbolKey: row.symbolKey,
      code: row.code,
      name: row.name || '',
      signalType: row.type,
      signalLabel: row.label,
      signalDate: row.date,
      signalPrice: row.price,
      basePrice: row.lastClose,
      baseDate: row.dataDate,
      reason: watchReason.trim(),
      addedAt: Date.now(),
    };
    setWatchlist(prev => upsertWatchlist(prev, item));
    setWatchDialogRow(null);
  };

  const toggleWatch = (row: ScanSignalRow) => {
    if (watchedKeys.has(row.symbolKey)) {
      setWatchlist(prev => removeFromWatchlist(prev, row.symbolKey));
    } else {
      openWatchDialog(row);
    }
  };

  useEffect(() => {
    if (!watchDialogRow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setWatchDialogRow(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [watchDialogRow]);

  // -------------------------------------------------------------------------
  // 扫描范围设置
  // -------------------------------------------------------------------------

  const persistPrefs = useCallback((next: Record<IndexId, boolean>) => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }, []);

  const toggleIndex = (id: IndexId) => {
    setSelectedIndexes(prev => {
      const next = { ...prev, [id]: !prev[id] };
      persistPrefs(next);
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
    setCustomSymbols(prev => {
      if (prev.includes(key)) return prev;
      const next = [...prev, key];
      try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const removeCustom = (key: string) => {
    setCustomSymbols(prev => {
      const next = prev.filter(k => k !== key);
      try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // -------------------------------------------------------------------------
  // 过滤 / 排序 / 统计
  // -------------------------------------------------------------------------

  const typeCounts = useMemo(() => {
    const counts: Record<BSPointType, number> = { B1: 0, B2: 0, B3: 0, S1: 0, S2: 0, S3: 0 };
    for (const r of rows) counts[r.type]++;
    return counts;
  }, [rows]);

  /** 按标的合并: 同一股票的多个买卖点合并为一行, 行内信号按日期倒序 */
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const bySymbol = new Map<string, ScanSignalRow[]>();
    for (const r of rows) {
      if (!typeFilter.has(r.type)) continue;
      if (hideNoName && !r.name) continue;
      if (q && !(r.code.includes(q) || (r.name || '').toLowerCase().includes(q))) continue;
      const list = bySymbol.get(r.symbolKey);
      if (list) list.push(r); else bySymbol.set(r.symbolKey, [r]);
    }
    const groups = Array.from(bySymbol.values());
    for (const g of groups) g.sort((a, b) => b.date.localeCompare(a.date));
    if (sortBy === 'dateDesc') groups.sort((a, b) => b[0].date.localeCompare(a[0].date));
    else if (sortBy === 'dateAsc') groups.sort((a, b) => a[a.length - 1].date.localeCompare(b[b.length - 1].date));
    else groups.sort((a, b) => a[0].symbolKey.localeCompare(b[0].symbolKey));
    return groups;
  }, [rows, typeFilter, hideNoName, query, sortBy]);

  const totalSignals = useMemo(() => visibleGroups.reduce((n, g) => n + g.length, 0), [visibleGroups]);
  const buyCount = useMemo(() => visibleGroups.reduce((n, g) => n + g.filter(r => r.type.startsWith('B')).length, 0), [visibleGroups]);
  const sellCount = totalSignals - buyCount;
  const pctClass = (v: number) => (v > 0 ? 'text-red-400' : v < 0 ? 'text-green-400' : 'text-zinc-400');

  const openInAnalyzer = (row: ScanSignalRow) => {
    onSelectStock?.(row.symbolKey.replace('.SH', '.SS'), scanTimeframe);
  };

  const anyUniverseSelected = selectedIndexes.hs300 || selectedIndexes.zz500 || customSymbols.length > 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center h-9 w-9 rounded-xl bg-blue-500/10 border border-blue-500/20 shrink-0">
          <Radar className="h-4 w-4 text-blue-400" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-zinc-50 leading-tight">缠论买卖点扫描</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            扫描经 WebSocket 交由后端执行 ({scanTimeframe === 'weekly' ? '周线 TickFlow 1w, 中长线趋势' : '近1年日线API数据'}), 列出最近 {SIGNAL_WINDOW_DAYS} 天内的三类买卖点
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 flex-wrap">
        {/* Universe toggles */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-zinc-600 font-semibold uppercase tracking-wider mr-0.5">范围</span>
          {(Object.keys(INDEX_META) as IndexId[]).map(id => (
            <button
              key={id}
              onClick={() => toggleIndex(id)}
              disabled={running}
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

        {/* Timeframe toggle: 日线 / 周线 (applies to every index universe) */}
        <div className="flex items-center gap-1 h-8 px-1 rounded-md bg-zinc-900/70 border border-zinc-800/60">
          <span className="text-[10px] text-zinc-600 font-semibold uppercase tracking-wider ml-1.5 mr-0.5">周期</span>
          {(['daily', 'weekly'] as ScanTimeframe[]).map(tf => (
            <button
              key={tf}
              type="button"
              onClick={() => handleScanTimeframeChange(tf)}
              disabled={running}
              className={`h-6 px-2.5 rounded text-[11px] font-medium transition-all cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
                scanTimeframe === tf
                  ? 'bg-blue-500/90 text-white shadow-sm shadow-blue-500/20'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
              title={tf === 'daily' ? '日线级别扫描 (近1年日K)' : '周线级别扫描 (TickFlow 1w, 所有指数/成分股通用)'}
            >
              {tf === 'daily' ? '日线' : '周线'}
            </button>
          ))}
        </div>

        {/* Custom adds */}
        <form
          onSubmit={e => { e.preventDefault(); addCustom(); }}
          className="flex items-center gap-1 h-9 px-1 pl-2.5 rounded-md bg-zinc-900/70 border border-zinc-800/60 focus-within:border-blue-500/60 transition-colors w-full sm:w-auto"
        >
          <Plus className="h-3 w-3 text-zinc-500 shrink-0" />
          <input
            value={customInput}
            onChange={e => { setCustomInput(e.target.value); setCustomError(''); }}
            placeholder="添加指数/ETF/股票"
            enterKeyHint="done"
            className="flex-1 sm:flex-none sm:w-44 min-w-0 bg-transparent text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={running}
            className="h-7 px-3 rounded bg-zinc-800 hover:bg-blue-500 active:bg-blue-600 hover:text-white text-zinc-300 text-[10px] font-semibold transition-all cursor-pointer disabled:opacity-40 shrink-0"
          >
            加入
          </button>
        </form>

        {/* Start / Stop / Force refresh */}
        <div className="flex items-center gap-2 ml-auto">
          <span
            className={`hidden md:flex items-center gap-1.5 text-[10px] font-mono ${conn === 'open' ? 'text-zinc-600' : 'text-amber-500/90'}`}
            title="扫描实时通道: 浏览器只发请求, K 线拉取与缠论计算全部在服务端完成"
          >
            <span className={`w-1.5 h-1.5 rounded-full ${conn === 'open' ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
            {conn === 'open' ? 'WS 已连接' : conn === 'connecting' ? 'WS 连接中' : 'WS 断开'}
          </span>
          {cacheInfo.count > 0 && !running && (
            <span
              className={`hidden md:flex items-center gap-1.5 text-[10px] font-mono ${cacheInfo.stale ? 'text-amber-500/90' : 'text-zinc-600'}`}
              title="后端扫描缓存 (.cache/scan); 增量扫描只复用数据已达最新交易日的标的, 过期标的自动重新拉取计算"
            >
              <Database className="h-3 w-3" />
              缓存 {cacheInfo.count} 只{cacheInfo.latestDate ? ` · 数据至 ${cacheInfo.latestDate}` : ''}
              {cacheInfo.stale && ' · 已过期'}
            </span>
          )}
          {running ? (
            <button
              onClick={stopScan}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-red-500/10 border border-red-500/40 text-red-400 text-[11px] font-semibold transition-all cursor-pointer hover:bg-red-500/20"
            >
              <Square className="h-3 w-3 fill-current" />
              停止
            </button>
          ) : (
            <>
              {cacheInfo.count > 0 && (
                <button
                  onClick={() => startScan(true)}
                  className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-zinc-900/70 border border-zinc-800/60 text-zinc-400 hover:text-blue-400 hover:border-blue-500/40 text-[11px] font-medium transition-all cursor-pointer"
                  title="忽略缓存, 让后端重新拉取全部数据并计算"
                >
                  <RefreshCw className="h-3 w-3" />
                  强制重扫
                </button>
              )}
              <button
                onClick={() => startScan(false)}
                disabled={!anyUniverseSelected || conn !== 'open'}
                className="flex items-center gap-1.5 h-8 px-3.5 rounded-lg bg-blue-500 hover:bg-blue-400 active:bg-blue-600 text-white text-[11px] font-bold transition-all cursor-pointer shadow-sm shadow-blue-500/20 disabled:opacity-40"
              >
                <Play className="h-3 w-3 fill-current" />
                {cacheInfo.count > 0 ? '增量扫描' : '开始扫描'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Custom symbol chips */}
      {customSymbols.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap -mt-1">
          {customSymbols.map(key => (
            <span key={key} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-violet-500/25 bg-violet-500/10 text-[10px] font-mono text-violet-300">
              {key.split('.')[0]}
              <span className="text-violet-400/50">{kindLabel(parseSymbol(key)?.kind || 'stock')}</span>
              <button
                onClick={() => removeCustom(key)}
                disabled={running}
                className="hover:text-red-400 transition-colors cursor-pointer disabled:opacity-40"
              >
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

      {conn === 'closed' && (
        <div className="px-3 py-2 rounded-lg bg-amber-950/20 border border-amber-900/30 text-amber-400 text-xs flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          扫描后端连接已断开, 正在重连… 扫描功能需要分析服务在运行 (pnpm server)
        </div>
      )}

      {serverError && (
        <div className="px-3 py-2 rounded-lg bg-red-950/20 border border-red-900/30 text-red-300 text-xs flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {serverError}
        </div>
      )}

      {/* Progress bar */}
      {(running || (progress.total > 0 && progress.done < progress.total)) && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500">
            <span className="flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin text-blue-400" />
              扫描中 {progress.done}/{progress.total}
            </span>
            <span>
              命中 <span className="text-zinc-300">{rows.length}</span> 条信号
              {progress.cached > 0 && <span className="text-blue-400/70"> · 缓存复用 {progress.cached}</span>}
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

      {/* Filters */}
      {rows.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {/* Type filter */}
          <div className="flex items-center gap-1 flex-wrap">
            {ALL_TYPES.map(t => {
              const active = typeFilter.has(t);
              return (
                <button
                  key={t}
                  onClick={() => setTypeFilter(prev => {
                    const next = new Set(prev);
                    if (next.has(t)) next.delete(t); else next.add(t);
                    return next;
                  })}
                  className={`px-2 py-1 rounded-md border text-[10px] font-mono font-bold transition-all cursor-pointer ${active ? TYPE_STYLE[t] : 'border-zinc-800 bg-zinc-900 text-zinc-600'}`}
                >
                  {t === 'B1' ? '一买' : t === 'B2' ? '二买' : t === 'B3' ? '三买' : t === 'S1' ? '一卖' : t === 'S2' ? '二卖' : '三卖'}
                  <span className="ml-1 opacity-70">{typeCounts[t]}</span>
                </button>
              );
            })}
          </div>

          {/* Search */}
          <div className="flex items-center gap-1.5 h-7 px-2 rounded-md bg-zinc-900/70 border border-zinc-800/60 focus-within:border-blue-500/60 transition-colors">
            <Search className="h-3 w-3 text-zinc-500" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索代码/名称"
              className="w-28 bg-transparent text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Sort */}
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as typeof sortBy)}
            className="h-7 px-1.5 rounded-md bg-zinc-900/70 border border-zinc-800/60 text-[11px] text-zinc-300 focus:outline-none focus:border-blue-500/60 cursor-pointer"
          >
            <option value="dateDesc">最新优先</option>
            <option value="dateAsc">最早优先</option>
            <option value="code">按代码</option>
          </select>

          <span className="text-[10px] font-mono text-zinc-600 ml-auto">
            显示 {visibleGroups.length} 只 · {totalSignals} 个信号 · 买 <span className="text-red-400">{buyCount}</span> / 卖 <span className="text-emerald-400">{sellCount}</span>
          </span>
        </div>
      )}

      {/* Results table */}
      <div className={`rounded-xl border border-zinc-800/80 overflow-hidden ${visibleGroups.length > 0 ? '' : 'min-h-[200px]'}`}>
        {visibleGroups.length === 0 ? (
          <div className="h-full min-h-[200px] flex flex-col items-center justify-center gap-2 py-12 text-center px-6">
            {running || progress.total > 0 ? (
              <>
                <Radar className="h-6 w-6 text-zinc-700" />
                <p className="text-xs text-zinc-500">
                  {running ? '正在扫描, 结果将实时出现在表格中...' : `最近 ${SIGNAL_WINDOW_DAYS} 天内无符合条件的买卖点`}
                </p>
              </>
            ) : !hydrated ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-zinc-600" />
                <p className="text-xs text-zinc-500">正在加载后端缓存结果...</p>
              </>
            ) : (
              <>
                <Radar className="h-6 w-6 text-zinc-700" />
                <p className="text-xs text-zinc-500">选择扫描范围与周期后点击「开始扫描」, 后端将逐只获取{scanTimeframe === 'weekly' ? '周线 (TickFlow 1w)' : '近1年日线'}并计算缠论三类买卖点</p>
                <button
                  onClick={() => startScan(false)}
                  disabled={!anyUniverseSelected || conn !== 'open'}
                  className="mt-2 flex items-center gap-1.5 h-8 px-4 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-xs font-bold cursor-pointer shadow-sm shadow-blue-500/20 disabled:opacity-40"
                >
                  <Play className="h-3 w-3 fill-current" />
                  扫描
                </button>
              </>
            )}
          </div>
        ) : (
          <>
          {/* Desktop: full 9-column table */}
          <div className="hidden md:block overflow-auto max-h-[calc(100vh-320px)]">
            <table className="w-full min-w-[760px] text-left border-collapse">
              <thead className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur border-b border-zinc-800">
                <tr className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                  <th className="px-3 py-2.5 font-mono">最新信号</th>
                  <th className="px-3 py-2.5 font-mono">代码</th>
                  <th className="px-3 py-2.5">名称</th>
                  <th className="px-3 py-2.5">板块</th>
                  <th className="px-3 py-2.5">缠论买卖点 (近{SIGNAL_WINDOW_DAYS}天)</th>
                  <th className="px-3 py-2.5 text-right font-mono">现价</th>
                  <th className="px-3 py-2.5 text-right font-mono">量比</th>
                  <th className="px-3 py-2.5 text-right font-mono">主力净流入</th>
                  <th className="px-3 py-2.5 text-right font-mono">操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleGroups.map(g => {
                  const head = g[0]; // 代表信号: 该股最新的一个
                  return (
                    <tr
                      key={head.symbolKey}
                      onClick={() => openInAnalyzer(head)}
                      title={`${head.code}${head.name ? ` ${head.name}` : ''} · 点击在个股分析中打开`}
                      className="border-b border-zinc-900 hover:bg-zinc-900/40 transition-colors group cursor-pointer"
                    >
                      <td className="px-3 py-2 text-[11px] font-mono text-zinc-300 whitespace-nowrap">{head.date}</td>
                      <td className="px-3 py-2 text-[11px] font-mono font-semibold text-zinc-200">{head.code}</td>
                      <td className="px-3 py-2 text-[11px] text-zinc-400 max-w-[120px] truncate" title={head.name}>
                        {head.name || <span className="text-zinc-700">—</span>}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-zinc-400 max-w-[110px] truncate" title={head.industryPath}>
                        {head.industryPath ? head.industryPath.split(' > ').pop() : <span className="text-zinc-700">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1">
                          {g.map(s => (
                            <span
                              key={s.id}
                              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold whitespace-nowrap ${TYPE_STYLE[s.type]}`}
                              title={`${s.date} ${s.label} · 信号价 ${s.price.toFixed(2)} · 现价 ${s.lastClose.toFixed(2)} · 信号后 ${s.changeSincePct > 0 ? '+' : ''}${s.changeSincePct.toFixed(2)}%`}
                            >
                              {s.label}
                              {s.strokeUp
                                ? <ArrowUpRight className="h-2.5 w-2.5 opacity-60" />
                                : <ArrowDownRight className="h-2.5 w-2.5 opacity-60" />}
                              <span className="font-mono font-semibold opacity-80">{s.date.slice(5)}</span>
                              <span className={`font-mono font-semibold ${pctClass(s.changeSincePct)}`}>
                                {s.changeSincePct > 0 ? '+' : ''}{s.changeSincePct.toFixed(1)}%
                              </span>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-[11px] font-mono text-zinc-200 text-right tabular-nums">{head.lastClose.toFixed(2)}</td>
                      <td
                        className={`px-3 py-2 text-[11px] font-mono text-right tabular-nums ${
                          (head.volRatio ?? 0) >= 1.5 ? 'text-red-400' : (head.volRatio ?? 0) > 0 ? 'text-zinc-300' : 'text-zinc-700'
                        }`}
                        title={`量比 = 最新收盘成交量 / 前5日均量${head.amount5 != null ? `\n近5日日均成交额 ${head.amount5.toFixed(2)}亿` : ''}`}
                      >
                        {head.volRatio != null && head.volRatio > 0 ? `${head.volRatio.toFixed(2)}` : '—'}
                      </td>
                      <td
                        className={`px-3 py-2 text-[11px] font-mono font-semibold text-right tabular-nums whitespace-nowrap ${(() => {
                          const f = flowMap[head.symbolKey];
                          if (!f) return 'text-zinc-700';
                          return f.mainInflow > 0 ? 'text-red-400' : f.mainInflow < 0 ? 'text-green-400' : 'text-zinc-400';
                        })()}`}
                        title="今日主力净流入 (超大单+大单, 东方财富)"
                      >
                        {flowMap[head.symbolKey]
                          ? <span className="inline-flex items-baseline gap-1">
                              {formatSignedYi(flowMap[head.symbolKey].mainInflow)}
                              <span className="text-[10px] opacity-70">{flowMap[head.symbolKey].mainPercent.toFixed(1)}%</span>
                            </span>
                          : <span>—</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2.5">
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleWatch(head); }}
                            className={`inline-flex items-center gap-1 text-[10px] transition-colors cursor-pointer opacity-60 group-hover:opacity-100 ${
                              watchedKeys.has(head.symbolKey)
                                ? 'text-amber-400 !opacity-100'
                                : 'text-zinc-500 hover:text-amber-400'
                            }`}
                            title={watchedKeys.has(head.symbolKey) ? '移出自选' : '加入自选: 记录理由, 在市场总览跟踪加入以来涨跌'}
                          >
                            <Star className={`h-3 w-3 ${watchedKeys.has(head.symbolKey) ? 'fill-amber-400' : ''}`} />
                            自选
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); openInAnalyzer(head); }}
                            className="inline-flex items-center gap-1 text-[10px] text-blue-400/70 hover:text-blue-300 transition-colors cursor-pointer opacity-60 group-hover:opacity-100"
                            title="在个股分析中打开"
                          >
                            <ExternalLink className="h-3 w-3" />
                            分析
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* Mobile: stacked cards (one per stock, signals wrap inside) */}
          <div className="md:hidden overflow-y-auto max-h-[calc(100vh-320px)] divide-y divide-zinc-900">
            {visibleGroups.map(g => {
              const head = g[0];
              const f = flowMap[head.symbolKey];
              return (
                <article
                  key={head.symbolKey}
                  onClick={() => openInAnalyzer(head)}
                  className="px-3 py-2.5 active:bg-zinc-900/60 cursor-pointer"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] font-mono font-semibold text-zinc-100">{head.code}</span>
                    <span className="text-[11px] text-zinc-400 truncate flex-1 min-w-0">{head.name || '—'}</span>
                    <span className="text-[11px] font-mono text-zinc-200 tabular-nums shrink-0">{head.lastClose.toFixed(2)}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] font-mono text-zinc-500">
                    <span>最新 {head.date}</span>
                    {head.industryPath && (
                      <span className="truncate">{head.industryPath.split(' > ').pop()}</span>
                    )}
                    <span className="ml-auto shrink-0">
                      {head.volRatio != null && head.volRatio > 0 ? `量比 ${head.volRatio.toFixed(2)}` : ''}
                    </span>
                    {f && (
                      <span className={`font-semibold tabular-nums shrink-0 ${f.mainInflow > 0 ? 'text-red-400' : f.mainInflow < 0 ? 'text-green-400' : 'text-zinc-400'}`}>
                        主力 {formatSignedYi(f.mainInflow)}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {g.map(s => (
                      <span
                        key={s.id}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold whitespace-nowrap ${TYPE_STYLE[s.type]}`}
                      >
                        {s.label}
                        {s.strokeUp
                          ? <ArrowUpRight className="h-2.5 w-2.5 opacity-60" />
                          : <ArrowDownRight className="h-2.5 w-2.5 opacity-60" />}
                        <span className="font-mono font-semibold opacity-80">{s.date.slice(5)}</span>
                        <span className={`font-mono font-semibold ${pctClass(s.changeSincePct)}`}>
                          {s.changeSincePct > 0 ? '+' : ''}{s.changeSincePct.toFixed(1)}%
                        </span>
                      </span>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleWatch(head); }}
                      className={`flex-1 inline-flex items-center justify-center gap-1 min-h-[36px] px-3 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
                        watchedKeys.has(head.symbolKey)
                          ? 'border-amber-500/50 bg-amber-500/10 text-amber-400'
                          : 'border-zinc-800 bg-zinc-900 text-zinc-400 active:border-amber-500/40'
                      }`}
                    >
                      <Star className={`h-3.5 w-3.5 ${watchedKeys.has(head.symbolKey) ? 'fill-amber-400' : ''}`} />
                      {watchedKeys.has(head.symbolKey) ? '已自选' : '自选'}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); openInAnalyzer(head); }}
                      className="flex-1 inline-flex items-center justify-center gap-1 min-h-[36px] px-3 rounded-lg bg-blue-500/15 border border-blue-500/30 text-blue-300 text-[11px] font-semibold active:bg-blue-500/25 cursor-pointer"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      缠论分析
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          </>
        )}
      </div>

      {/* Footer note */}
      <p className="text-[10px] text-zinc-600 leading-relaxed">
        数据来源: TickFlow {scanTimeframe === 'weekly' ? '周线 1w (前复权, 约400周)' : '近1年日线 (前复权)'} (由后端缓存并按增量拉取) · 日线/周线结果分开缓存于服务端 .cache/scan, 再次扫描秒级完成, 「强制重扫」可获取最新数据 ·
        信号为缠论三类买卖点机械识别结果, 仅供研究参考, 不构成投资建议。
      </p>

      {/* 加入自选对话框 */}
      {watchDialogRow && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          onClick={() => setWatchDialogRow(null)}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            onClick={e => e.stopPropagation()}
            className="relative bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-[90vw] max-w-md p-4 md:p-5 max-h-[88vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <Star className="h-4 w-4 text-amber-400" />
                加入自选
              </h3>
              <button
                onClick={() => setWatchDialogRow(null)}
                className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
              >
                <X className="h-4 w-4 text-zinc-500" />
              </button>
            </div>

            <div className="rounded-xl bg-zinc-950/60 border border-zinc-800/70 px-3 py-2.5 mb-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono font-semibold text-zinc-200">{watchDialogRow.code}</span>
                <span className="text-xs text-zinc-400 truncate">{watchDialogRow.name || '—'}</span>
                <span className={`ml-auto inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold shrink-0 ${TYPE_STYLE[watchDialogRow.type]}`}>
                  {watchDialogRow.label}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-zinc-500">
                {watchDialogRow.industryPath && <span>板块 {watchDialogRow.industryPath.split(' > ').pop()}</span>}
                <span>信号日 {watchDialogRow.date}</span>
                <span>信号价 {watchDialogRow.price.toFixed(2)}</span>
                <span>现价 {watchDialogRow.lastClose.toFixed(2)}</span>
              </div>
              <p className="mt-1.5 text-[10px] text-zinc-600">
                以 {watchDialogRow.dataDate} 收盘价 {watchDialogRow.lastClose.toFixed(2)} 为基准, 在「市场总览」跟踪加入以来涨跌
              </p>
            </div>

            <div className="mb-4">
              <label className="block text-[10px] font-semibold text-zinc-500 uppercase tracking-wider mb-1.5">
                加入理由
              </label>
              <textarea
                value={watchReason}
                onChange={e => setWatchReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder="记录关注逻辑, 如: 一买信号 + 缩量回踩中枢上沿"
                className="w-full rounded-lg bg-zinc-950/60 border border-zinc-800 focus:border-blue-500/60 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none px-3 py-2 resize-none transition-colors"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setWatchDialogRow(null)}
                className="flex-1 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-all cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={confirmAddWatch}
                className="flex-1 px-4 py-2 bg-amber-500 hover:bg-amber-400 active:bg-amber-600 text-zinc-950 text-xs font-bold rounded-lg transition-all cursor-pointer"
              >
                确认加入
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
