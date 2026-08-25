import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Radar, Play, Square, Plus, X, Loader2, AlertTriangle, Search, ExternalLink,
  ArrowUpRight, ArrowDownRight, RefreshCw, Database, Star,
  TrendingUp, TrendingDown,
} from 'lucide-react';
import { Kline, BSPointType, StockBasicInfo } from '../types/stock';
import { mergeKlines, findFractions, calculateStrokes, calculateBSPoints } from '../utils/chanlun';
import {
  IndexId, INDEX_META, ParsedSymbol, parseSymbol, symbolKey, kindLabel,
  fetchIndexMembers, loadStockMeta, fetchYearKlines, fetchStockFlowBatch, StockMeta, StockFlow,
} from '../utils/indexAnalysisApi';
import { formatSignedYi } from '../utils/marketApi';
import { WatchItem, loadWatchlist, upsertWatchlist, removeFromWatchlist } from '../utils/watchlistStorage';
import { fetchStockBasicInfo } from '../utils/api';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

const CUSTOM_KEY = 'chanlun_scan_custom';
const PREFS_KEY = 'chanlun_scan_prefs';
const CACHE_KEY = 'chanlun_scan_cache_v1';
/** 买卖点统计窗口: 最近 90 个自然日 */
const SIGNAL_WINDOW_DAYS = 90;
const CONCURRENCY = 6;
/** 每完成多少只批量落盘一次缓存 */
const CACHE_FLUSH_EVERY = 20;

const ALL_TYPES: BSPointType[] = ['B1', 'B2', 'B3', 'S1', 'S2', 'S3'];

const TYPE_LABELS: Record<BSPointType, string> = {
  B1: '一买', B2: '二买', B3: '三买', S1: '一卖', S2: '二卖', S3: '三卖',
};

export const TYPE_STYLE: Record<BSPointType, string> = {
  B1: 'bg-red-500/15 text-red-400 border-red-500/30',
  B2: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  B3: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
  S1: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  S2: 'bg-teal-500/15 text-teal-400 border-teal-500/30',
  S3: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
};

// ---------------------------------------------------------------------------
// localStorage 缓存: 每只股票仅存最终缠论结果 (末根K线日期/收盘 + 全部买卖点),
// 复用时可跳过 API 请求与全部计算, 仅做 90 天窗口过滤。
// ---------------------------------------------------------------------------

/** [type, date, price, strokeUp] */
type CachedSignal = [BSPointType, string, number, 0 | 1];

interface CacheEntry {
  d: string;            // 末根 K 线日期 (数据新鲜度)
  c: number;            // 末根收盘价
  s: CachedSignal[];    // 全部三类买卖点
  v?: number;           // 量比: 最新收盘成交量 / 前5日均量 (旧缓存无此字段)
  a?: number;           // 近5日日均成交额 (亿元, 旧缓存无此字段)
}

type ScanCache = Record<string, CacheEntry>;

/** 预期最新交易日 (北京时间 YYYY-MM-DD, 忽略节假日): 收盘后取当日平日, 否则取上一平日 */
function expectedTradeDay(): string {
  const d = new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60000);
  if (d.getUTCHours() < 16) d.setUTCDate(d.getUTCDate() - 1); // 16:00 前日K尚未更新, 视为上一交易日
  const dow = d.getUTCDay();
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  else if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** 缓存条目是否覆盖预期最新交易日 (按内容判断, 不依赖扫描时间戳) */
function entryFresh(entry: CacheEntry | undefined): boolean {
  return !!entry && entry.d >= expectedTradeDay();
}

function loadCache(): ScanCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as ScanCache;
    }
  } catch { /* ignore */ }
  return {};
}

function saveCache(cache: ScanCache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 配额超限: 逐出约一半最旧条目后重试一次
    try {
      const keys = Object.keys(cache);
      const drop = keys.slice(0, Math.ceil(keys.length / 2));
      for (const k of drop) delete cache[k];
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch { /* ignore */ }
  }
}

interface SignalRow {
  id: string;             // symbolKey-type-date
  symbolKey: string;      // '000001.SZ'
  code: string;
  name?: string;
  industryPath?: string;  // 板块完整路径 '金融 > 商业银行 > ... > 银行'
  type: BSPointType;
  label: string;
  date: string;           // 信号日期 YYYY-MM-DD
  price: number;          // 信号价
  lastClose: number;      // 最新收盘价
  dataDate: string;       // 最新收盘价对应的数据日期 (自选跟踪基准日)
  daysAgo: number;        // 距今自然日
  changeSincePct: number; // 现价相对信号价涨跌 %
  strokeUp: boolean;      // 产生信号的笔方向
  volRatio?: number;      // 量比: 最新收盘量 / 前5日均量
  amount5?: number;       // 近5日日均成交额 (亿元)
}

interface ScanProgress {
  running: boolean;
  total: number;
  done: number;
  ok: number;
  failed: number;
  cached: number;   // 命中缓存, 跳过下载与计算
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
}

// ---------------------------------------------------------------------------
// 计算: 近一年日K -> 缠论 -> 缓存条目; 以及缓存条目 -> 90天内信号行
// ---------------------------------------------------------------------------

/** 完整缠论流水线, 仅保留笔与买卖点 (线段/中枢结果不参与买卖点判定, 省去两遍计算) */
function computeCacheEntry(klines: Kline[]): CacheEntry {
  const merged = mergeKlines(klines);
  const fractions = findFractions(merged, klines);
  const strokes = calculateStrokes(fractions);
  const bsPoints = calculateBSPoints(klines, strokes);
  const strokeUpByIndex = new Map<number, boolean>(strokes.map((s, i) => [i, s.direction === 'up']));

  // 量能指标: 量比 (最新收盘量 / 前5日均量) 与 近5日日均成交额
  const n = klines.length;
  let volRatio = 0;
  if (n >= 2) {
    const prev5 = klines.slice(Math.max(0, n - 6), n - 1);
    const avgVol5 = prev5.reduce((s, k) => s + k.volume, 0) / prev5.length;
    volRatio = avgVol5 > 0 ? klines[n - 1].volume / avgVol5 : 0;
  }
  const last5 = klines.slice(-5);
  const amount5 = last5.reduce((s, k) => s + k.amount, 0) / last5.length / 1e8;

  return {
    d: klines[klines.length - 1].date,
    c: klines[klines.length - 1].close,
    s: bsPoints.map(p => [p.type, p.date, p.price, strokeUpByIndex.get(p.strokeIndex) ? 1 : 0]),
    v: Math.round(volRatio * 100) / 100,
    a: Math.round(amount5 * 100) / 100,
  };
}

function rowsFromCacheEntry(
  sym: string,
  entry: CacheEntry,
  meta: StockMeta,
): SignalRow[] {
  if (entry.s.length === 0) return [];
  const code = sym.split('.')[0];
  const industryPath = meta.industries[code];
  const out: SignalRow[] = [];
  for (const [type, date, price, strokeUp] of entry.s) {
    const daysAgo = daysBetween(date, entry.d);
    if (daysAgo > SIGNAL_WINDOW_DAYS) continue;
    out.push({
      id: `${sym}-${type}-${date}`,
      symbolKey: sym,
      code,
      name: meta.names[code],
      industryPath,
      type,
      label: TYPE_LABELS[type],
      date,
      price,
      lastClose: entry.c,
      dataDate: entry.d,
      daysAgo,
      changeSincePct: price > 0 ? ((entry.c - price) / price) * 100 : 0,
      strokeUp: strokeUp === 1,
      volRatio: entry.v,
      amount5: entry.a,
    });
  }
  return out;
}

function rowsFromKlines(
  sym: string,
  klines: Kline[],
  meta: StockMeta,
): SignalRow[] {
  return rowsFromCacheEntry(sym, computeCacheEntry(klines), meta);
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export default function IndexAnalysis({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
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

  // 指数代码映射: IndexId -> 用于 fetchStockBasicInfo 的 symbol
  const INDEX_SYMBOLS: Record<IndexId, string> = {
    hs300: '000300.SH',
    zz500: '000905.SH',
  };

  // 指数基本信息 (名称/价格/涨跌幅)
  const [indexBasicInfo, setIndexBasicInfo] = useState<Partial<Record<IndexId, StockBasicInfo | null>>>({});
  const activeIndexIds = useMemo(
    () => (Object.keys(selectedIndexes) as IndexId[]).filter(id => selectedIndexes[id]),
    [selectedIndexes],
  );

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      const result: Partial<Record<IndexId, StockBasicInfo | null>> = {};
      await Promise.all(
        activeIndexIds.map(async (id) => {
          try {
            const info = await fetchStockBasicInfo(INDEX_SYMBOLS[id]);
            if (!cancelled) result[id] = info;
          } catch {
            if (!cancelled) result[id] = null;
          }
        }),
      );
      if (!cancelled) setIndexBasicInfo(result);
    };
    fetchAll();
    return () => { cancelled = true; };
  }, [activeIndexIds]);

  // 成分股缓存与名称/板块映射
  const membersRef = useRef<Partial<Record<IndexId, string[]>>>({});
  const metaRef = useRef<StockMeta>({ names: {}, industries: {} });

  // 个股当日主力资金流向: symbolKey -> StockFlow
  const [flowMap, setFlowMap] = useState<Record<string, StockFlow>>({});
  const refreshFlows = useCallback(async (keys: string[]) => {
    if (keys.length === 0) return;
    try {
      const got = await fetchStockFlowBatch(keys);
      if (Object.keys(got).length > 0) setFlowMap(prev => ({ ...prev, ...got }));
    } catch { /* 忽略, 表格显示 — */ }
  }, []);

  // 结果缓存 (localStorage): symbol -> CacheEntry
  // 新鲜度按内容判断: 缓存末根K线日期落后于预期交易日 -> 该条目过期, 扫描时重新下载
  const initialCache = useMemo<ScanCache>(() => loadCache(), []);
  const cacheRef = useRef<ScanCache>(initialCache);
  const [cacheInfo, setCacheInfo] = useState(() => ({
    count: Object.keys(initialCache).length,
    latestDate: Object.values(initialCache).reduce<string>((acc, e) => (e.d > acc ? e.d : acc), ''),
  }));
  /** 挂载时缓存整体已落后于预期交易日: 自动触发一次增量扫描刷新 */
  const staleOnMountRef = useRef(
    Object.keys(initialCache).length > 0 &&
    Object.values(initialCache).reduce<string>((a, e) => (e.d > a ? e.d : a), '') < expectedTradeDay(),
  );
  const expectedDay = useMemo(expectedTradeDay, []);

  // 扫描状态
  const [progress, setProgress] = useState<ScanProgress>({ running: false, total: 0, done: 0, ok: 0, failed: 0, cached: 0 });
  const [rows, setRows] = useState<SignalRow[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scanningRef = useRef(false);
  /** 首次进入: 缓存结果是否已加载完成 */
  const [hydrated, setHydrated] = useState(false);

  // 过滤与排序
  const [typeFilter, setTypeFilter] = useState<Set<BSPointType>>(new Set(ALL_TYPES));
  const [query, setQuery] = useState('');
  const [sortBy, setSortBy] = useState<'dateDesc' | 'dateAsc' | 'code'>('dateDesc');
  const [hideNoName, setHideNoName] = useState(false);

  // 自选股: 从信号行加入 (可填理由), 在市场总览页跟踪加入以来涨跌
  const [watchlist, setWatchlist] = useState<WatchItem[]>(() => loadWatchlist());
  const [watchDialogRow, setWatchDialogRow] = useState<SignalRow | null>(null);
  const [watchReason, setWatchReason] = useState('');
  const watchedKeys = useMemo(() => new Set(watchlist.map(w => w.symbolKey)), [watchlist]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // -------------------------------------------------------------------------
  // 默认展示: 有缓存时直接从 localStorage 恢复上次扫描结果, 无需手动扫描
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      if (Object.keys(cacheRef.current).length > 0) {
        metaRef.current = await loadStockMeta();
        if (!cancelled && !scanningRef.current) {
          const out: SignalRow[] = [];
          for (const [sym, entry] of Object.entries(cacheRef.current)) {
            out.push(...rowsFromCacheEntry(sym, entry, metaRef.current));
          }
          setRows(out);
          refreshFlows([...new Set(out.map(r => r.symbolKey))]);
        }
      }
      if (!cancelled) setHydrated(true);
    };
    hydrate();
    return () => { cancelled = true; };
  }, [refreshFlows]);

  // -------------------------------------------------------------------------
  // 自选股操作
  // -------------------------------------------------------------------------

  const openWatchDialog = (row: SignalRow) => {
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

  const toggleWatch = (row: SignalRow) => {
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
  // 扫描引擎 (并发池 + localStorage 缓存)
  // -------------------------------------------------------------------------

  const stopScan = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    scanningRef.current = false;
    setProgress(p => ({ ...p, running: false }));
    saveCache(cacheRef.current); // 中断也保留已完成部分
    setCacheInfo({
      count: Object.keys(cacheRef.current).length,
      latestDate: Object.values(cacheRef.current).reduce<string>((acc, e) => (e.d > acc ? e.d : acc), ''),
    });
  }, []);

  const startScan = useCallback(async (force = false) => {
    if (progress.running) return;
    scanningRef.current = true;

    // 1. 组装扫描宇宙: 选中的指数成分股 + 自定义标的
    const universe: string[] = [];
    const pushUnique = (list: string[]) => {
      for (const s of list) if (!universe.includes(s)) universe.push(s);
    };
    const ids = (Object.keys(selectedIndexes) as IndexId[]).filter(id => selectedIndexes[id]);
    try {
      await Promise.all(ids.map(async id => {
        if (!membersRef.current[id]) membersRef.current[id] = await fetchIndexMembers(id);
        pushUnique(membersRef.current[id]!);
      }));
    } catch (err: any) {
      console.error(err);
      scanningRef.current = false;
      setProgress(p => ({ ...p, running: false }));
      setCustomError('成分股列表获取失败, 请检查网络后重试');
      return;
    }
    pushUnique(customSymbols);

    // 2. 名称/板块映射 (失败不阻塞, 仅少名称与板块列)
    metaRef.current = await loadStockMeta();

    // 3. 并发扫描: 缓存命中直接复用结果, 未命中才请求 API + 计算
    const controller = new AbortController();
    abortRef.current = controller;
    setRows([]);
    setProgress({ running: true, total: universe.length, done: 0, ok: 0, failed: 0, cached: 0 });

    let cursor = 0;
    let done = 0;
    let ok = 0;
    let failed = 0;
    let cachedHits = 0;
    let sinceFlush = 0;
    const signaledKeys = new Set<string>();

    const worker = async () => {
      while (cursor < universe.length && !controller.signal.aborted) {
        const sym = universe[cursor++];
        const cachedEntry = cacheRef.current[sym];
        // 缓存命中条件: 非强制 && 条目数据已达预期最新交易日; 过期条目重新下载计算
        const hit = !force && entryFresh(cachedEntry) ? cachedEntry : undefined;

        if (hit) {
          // 缓存命中: 零请求零计算, 仅做窗口过滤
          ok++;
          cachedHits++;
          sinceFlush++;
          done++;
          setProgress(p => ({ ...p, done, ok, failed, cached: cachedHits }));
          const newRows = rowsFromCacheEntry(sym, hit, metaRef.current);
          if (newRows.length > 0) {
            signaledKeys.add(sym);
            setRows(prev => [...prev, ...newRows]);
          }
          continue;
        }

        try {
          const klines = await fetchYearKlines(sym, 3, controller.signal);
          cacheRef.current[sym] = computeCacheEntry(klines);
          ok++;
          sinceFlush++;
          if (sinceFlush >= CACHE_FLUSH_EVERY) {
            saveCache(cacheRef.current);
            sinceFlush = 0;
          }
          const newRows = rowsFromKlines(sym, klines, metaRef.current);
          if (newRows.length > 0) {
            signaledKeys.add(sym);
            setRows(prev => [...prev, ...newRows]);
          }
        } catch (err: any) {
          if (err?.name === 'AbortError') return;
          failed++;
        } finally {
          done++;
          setProgress(p => ({ ...p, done, ok, failed, cached: cachedHits }));
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    scanningRef.current = false;

    // 4. 扫描完成后批量拉取有信号标的的当日主力资金流向
    refreshFlows([...signaledKeys]);

    saveCache(cacheRef.current);
    setCacheInfo({
      count: Object.keys(cacheRef.current).length,
      latestDate: Object.values(cacheRef.current).reduce<string>((acc, e) => (e.d > acc ? e.d : acc), ''),
    });
    if (!controller.signal.aborted) {
      setProgress(p => ({ ...p, running: false }));
      abortRef.current = null;
    }
  }, [customSymbols, progress.running, refreshFlows, selectedIndexes]);

  // -------------------------------------------------------------------------
  // 挂载时数据过期自动刷新: 缓存落后于预期交易日 -> 自动增量重扫落后的标的
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!staleOnMountRef.current) return;
    let cancelled = false;
    // 延迟一拍: 避开 StrictMode 模拟卸载时的 abort, 也让挂载流程先完成
    const t = setTimeout(() => {
      if (cancelled) return;
      staleOnMountRef.current = false;
      startScan(false);
    }, 0);
    return () => { cancelled = true; clearTimeout(t); };
  }, [startScan]);

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
    const bySymbol = new Map<string, SignalRow[]>();
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

  const openInAnalyzer = (row: SignalRow) => {
    onSelectStock?.(row.symbolKey.replace('.SH', '.SS'));
  };

  const anyUniverseSelected = selectedIndexes.hs300 || selectedIndexes.zz500 || customSymbols.length > 0;
  const cacheStale = cacheInfo.latestDate !== '' && cacheInfo.latestDate < expectedDay;

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
            默认扫描沪深300 / 中证500成分股 (近1年日线API数据), 列出最近 {SIGNAL_WINDOW_DAYS} 天内的三类买卖点
          </p>
        </div>
      </div>

      {/* Index Basic Info Cards */}
      {activeIndexIds.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {activeIndexIds.map(id => {
            const info = indexBasicInfo[id];
            if (!info) return null;
            return (
              <div
                key={id}
                className="flex-1 min-w-[200px] bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950 rounded-xl border border-zinc-800/80 p-3"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">{INDEX_META[id].label}</span>
                      <span className="text-[10px] font-mono text-zinc-600">{info.symbol}</span>
                    </div>
                    <h3 className="text-lg font-bold text-zinc-100 mt-0.5">{info.name}</h3>
                  </div>
                  <div className="flex flex-col items-end shrink-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-xl font-bold font-mono ${info.change >= 0 ? 'text-red-500' : 'text-green-500'}`}>
                        {info.price.toFixed(2)}
                      </span>
                      {info.change >= 0 ? (
                        <TrendingUp className="h-4 w-4 text-red-500" />
                      ) : (
                        <TrendingDown className="h-4 w-4 text-green-500" />
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className={`text-xs font-mono font-semibold ${info.change >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                        {info.change >= 0 ? '+' : ''}{info.change.toFixed(2)}
                      </span>
                      <span className={`text-xs font-mono font-semibold ${info.change >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                        ({info.changePercent.toFixed(2)}%)
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3 flex-wrap">
        {/* Universe toggles */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-zinc-600 font-semibold uppercase tracking-wider mr-0.5">范围</span>
          {(Object.keys(INDEX_META) as IndexId[]).map(id => (
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

        {/* Custom adds */}
        <form
          onSubmit={e => { e.preventDefault(); addCustom(); }}
          className="flex items-center gap-1 h-8 pl-2.5 pr-1 rounded-md bg-zinc-900/70 border border-zinc-800/60 focus-within:border-blue-500/60 transition-colors"
        >
          <Plus className="h-3 w-3 text-zinc-500 shrink-0" />
          <input
            value={customInput}
            onChange={e => { setCustomInput(e.target.value); setCustomError(''); }}
            placeholder="添加指数/ETF/股票"
            className="w-44 bg-transparent text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          <button
            type="submit"
            disabled={progress.running}
            className="h-6 px-2 rounded bg-zinc-800 hover:bg-blue-500 active:bg-blue-600 hover:text-white text-zinc-300 text-[10px] font-semibold transition-all cursor-pointer disabled:opacity-40"
          >
            加入
          </button>
        </form>

        {/* Start / Stop / Force refresh */}
        <div className="flex items-center gap-2 ml-auto">
          {cacheInfo.count > 0 && !progress.running && (
            <span
              className={`hidden md:flex items-center gap-1.5 text-[10px] font-mono ${cacheStale ? 'text-amber-500/90' : 'text-zinc-600'}`}
              title="localStorage 结果缓存; 增量扫描只复用数据已达最新交易日的条目, 过期条目自动重新下载计算"
            >
              <Database className="h-3 w-3" />
              缓存 {cacheInfo.count} 只{cacheInfo.latestDate ? ` · 数据至 ${cacheInfo.latestDate}` : ''}
              {cacheStale && ' · 已过期'}
            </span>
          )}
          {progress.running ? (
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
                  title="忽略缓存, 重新下载全部数据并计算"
                >
                  <RefreshCw className="h-3 w-3" />
                  强制重扫
                </button>
              )}
              <button
                onClick={() => startScan(false)}
                disabled={!anyUniverseSelected}
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
                disabled={progress.running}
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

      {/* Progress bar */}
      {(progress.running || (progress.total > 0 && progress.done < progress.total)) && (
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
            {progress.running || progress.total > 0 ? (
              <>
                <Radar className="h-6 w-6 text-zinc-700" />
                <p className="text-xs text-zinc-500">
                  {progress.running ? '正在扫描, 结果将实时出现在表格中...' : `最近 ${SIGNAL_WINDOW_DAYS} 天内无符合条件的买卖点`}
                </p>
              </>
            ) : !hydrated ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-zinc-600" />
                <p className="text-xs text-zinc-500">正在加载本地缓存结果...</p>
              </>
            ) : (
              <>
                <Radar className="h-6 w-6 text-zinc-700" />
                <p className="text-xs text-zinc-500">选择扫描范围后点击「开始扫描」, 将逐只获取近1年日线并计算缠论三类买卖点</p>
                <button
                  onClick={() => startScan(false)}
                  disabled={!anyUniverseSelected}
                  className="mt-2 flex items-center gap-1.5 h-8 px-4 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-xs font-bold cursor-pointer shadow-sm shadow-blue-500/20 disabled:opacity-40"
                >
                  <Play className="h-3 w-3 fill-current" />
                  扫描
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="overflow-auto max-h-[calc(100vh-320px)]">
            <table className="w-full text-left border-collapse">
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
                      className="border-b border-zinc-900 hover:bg-zinc-900/40 transition-colors group"
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
                            onClick={() => toggleWatch(head)}
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
                            onClick={() => openInAnalyzer(head)}
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
        )}
      </div>

      {/* Footer note */}
      <p className="text-[10px] text-zinc-600 leading-relaxed">
        数据来源: TickFlow 近1年日线 (前复权) · 扫描结果缓存于浏览器 localStorage, 再次扫描秒级完成, 「强制重扫」可获取最新数据 ·
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
            className="relative bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-[90vw] max-w-md p-5"
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
