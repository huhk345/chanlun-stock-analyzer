import { useState, useEffect, useCallback, useRef } from 'react';
import { Activity, BrainCircuit, GripVertical } from 'lucide-react';
import Navbar from './components/Navbar';
import ChanlunChart from './components/ChanlunChart';
import BacktestManager from './components/BacktestManager';
import GeminiAdvisor from './components/GeminiAdvisor';
import ConfigView from './components/ConfigView';
import AboutView from './components/AboutView';
import StockInfoPanel from './components/StockInfoPanel';
import MarketDashboard from './components/MarketDashboard';
import IndexAnalysis from './components/IndexAnalysis';
import { SupabaseUser } from './utils/supabase';
import { Kline, Stroke, Segment, Hub, Fraction, StockBasicInfo, BacktestTrade, BSPoint } from './types/stock';
import {
  mergeKlines,
  findFractions,
  calculateStrokes,
  calculateSegments,
  calculateHubs,
  calculateBSPoints
} from './utils/chanlun';
import { fetchStockData, fetchStockBasicInfo, resolveSymbol, KlineTimeframe } from './utils/api';

interface ReductionPlan {
  title: string;
  url: string;
  reduction_date: string;
  announcement_type: string;
  announcement_date: string;
}

interface StockMeta {
  stock_code: string;
  stock_name: string;
  industry: string;
  actual_controller: string;
  reduction_plans: ReductionPlan[];
}

const CHAT_RAIL_WIDTH_KEY = 'chanlun_chat_rail_width';
const CHAT_RAIL_MIN = 320;
const CHAT_RAIL_MAX = 800;
const CHAT_RAIL_DEFAULT = 420;
const NAVBAR_HEIGHT = 56;

type ViewMode = 'dashboard' | 'indexes' | 'analyzer';

// Parse the current location into app routing state.
// Mirrors the initial-view logic: presence of ?code= implies the analyzer view.
function parseAppUrl(): { view: ViewMode; code: string; timeframe: KlineTimeframe } {
  const params = new URLSearchParams(window.location.search);
  const rawView = params.get('view');
  const code = params.get('code') || '000001.ss';
  const timeframe: KlineTimeframe = params.get('tf') === 'weekly' ? 'weekly' : 'daily';
  let view: ViewMode = 'dashboard';
  if (rawView === 'analyzer' || params.get('code')) {
    view = 'analyzer';
  } else if (rawView === 'indexes') {
    view = 'indexes';
  }
  return { view, code, timeframe };
}

// Write routing state to the URL. Push creates a history entry (back-button
// support); replace only canonicalizes the current entry without adding one.
// Identical URLs are skipped to avoid duplicate history entries.
function syncAppUrl(
  view: ViewMode,
  symbol: string,
  timeframe: KlineTimeframe,
  mode: 'push' | 'replace',
) {
  const url = new URL(window.location.href);
  if (view === 'dashboard') {
    url.searchParams.set('view', 'dashboard');
    url.searchParams.delete('code');
  } else if (view === 'indexes') {
    url.searchParams.set('view', 'indexes');
    url.searchParams.delete('code');
  } else {
    url.searchParams.set('view', 'analyzer');
    if (symbol) url.searchParams.set('code', symbol);
  }
  if (timeframe === 'weekly') url.searchParams.set('tf', 'weekly');
  else url.searchParams.delete('tf');
  const next = url.toString();
  if (next === window.location.href) return;
  if (mode === 'push') window.history.pushState({}, '', next);
  else window.history.replaceState({}, '', next);
}

// Pure ChanLun pipeline: raw klines -> fractions / strokes / segments / hubs / BS points.
// Shared by full stock loads and chart-only timeframe switches.
function computeChanlunParts(rawKlines: Kline[]) {
  const merged = mergeKlines(rawKlines);
  const fractions = findFractions(merged, rawKlines);
  const computedStrokes = calculateStrokes(fractions);
  const computedSegments = calculateSegments(computedStrokes);
  const computedHubs = calculateHubs(computedStrokes);
  const computedBSPoints = calculateBSPoints(rawKlines, computedStrokes);
  return { fractions, computedStrokes, computedSegments, computedHubs, computedBSPoints };
}

export default function App() {
  const [currentUser, setCurrentUser] = useState<SupabaseUser | null>(null);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isChatVisible, setIsChatVisible] = useState(true);

  // View routing: dashboard is the index page; analyzer is the stock workspace.
  // Entering analyzer via ?view=analyzer or a shared ?code= link.
  const initialRoute = parseAppUrl();
  const initialView: ViewMode = initialRoute.view;
  const [view, setView] = useState<ViewMode>(initialView);

  // Prevent double API calls in StrictMode
  const hasInitialized = useRef(false);

  // Resizable right-rail width (persisted)
  const [chatWidth, setChatWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(CHAT_RAIL_WIDTH_KEY);
      if (saved) {
        const n = parseInt(saved, 10);
        if (!isNaN(n)) return Math.min(CHAT_RAIL_MAX, Math.max(CHAT_RAIL_MIN, n));
      }
    } catch {
      // ignore
    }
    return CHAT_RAIL_DEFAULT;
  });
  const [isResizingRail, setIsResizingRail] = useState(false);

  // Mobile breakpoint: < 768px -> AI panel flows under the chart
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 768;
  });
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Stock queries parameters.
  // Default always 日线: fresh loads ignore ?tf= (in-session toggle still works).
  const initialCode = initialRoute.code;
  const initialTimeframe: KlineTimeframe = 'daily';
  const [symbol, setSymbol] = useState(initialCode);
  const [timeframe, setTimeframe] = useState<KlineTimeframe>(initialTimeframe);
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const timeframeRef = useRef<KlineTimeframe>(initialTimeframe);
  timeframeRef.current = timeframe;
  // Refs for the popstate handler (registered once) to read latest state
  // without re-subscribing on every render.
  const viewRef = useRef<ViewMode>(initialView);
  viewRef.current = view;
  const symbolRef = useRef<string>(initialCode);
  symbolRef.current = symbol;

  // Processed ChanLun arrays
  const [klines, setKlines] = useState<Kline[]>([]);
  const [fractions, setFractions] = useState<Fraction[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [bsPoints, setBsPoints] = useState<BSPoint[]>([]);
  const [dataSource, setDataSource] = useState('');
  const [dataPeriod, setDataPeriod] = useState('');
  const [stockBasicInfo, setStockBasicInfo] = useState<StockBasicInfo | null>(null);
  const [stockMeta, setStockMeta] = useState<StockMeta | null>(null);
  const [backtestTrades, setBacktestTrades] = useState<BacktestTrade[]>([]);

  const fetchAndProcessStock = async (querySymbol: string, forcedTimeframe?: KlineTimeframe) => {
    const tf = forcedTimeframe ?? timeframeRef.current;
    setIsLoading(true);
    setErrorText('');

    try {
      const data = await fetchStockData(querySymbol, tf);
      const rawKlines: Kline[] = data.klines || [];
      
      if (rawKlines.length < 5) {
        throw new Error('Retrieved stock history has insufficient data bars for ChanLun processing.');
      }

      // Fetch stock basic information in parallel with ChanLun processing
      const basicInfoPromise = fetchStockBasicInfo(querySymbol).catch(err => {
        console.error('Failed to fetch stock basic info:', err);
        return null;
      });

      // Step-by-step ChanLun execution on fetched candlesticks
      const { fractions, computedStrokes, computedSegments, computedHubs, computedBSPoints } =
        computeChanlunParts(rawKlines);

      // Wait for basic info and sync React state
      const basicInfo = await basicInfoPromise;

      // Fetch stock metadata (industry, controller, reduction plans)
      const resolvedSymbol = data.symbol;
      const pureCode = resolvedSymbol.split('.')[0];
      // 已知指数代码: 000001.SH 是上证指数而非平安银行, 不套用个股元数据
      const KNOWN_INDEX_CODES = new Set(['000001', '000016', '000300', '000905', '000852', '000688', '399001', '399006']);
      let meta: StockMeta | null = null;
      try {
        const resp = await fetch('/merged_stock_data.json');
        if (resp.ok && !KNOWN_INDEX_CODES.has(pureCode)) {
          const cache = await resp.json();
          meta = cache[pureCode] || null;
          // Verify exchange suffix matches the code prefix to avoid misattribution.
          // e.g., pureCode "000001" maps to 平安银行 (.SZ) in the JSON, but
          // 000001.SS/.SH is the Shanghai Composite Index — a different entity.
          if (meta) {
            const isSS = /^(60|68|90|11|13|51|58)/.test(pureCode);
            const expectedSuffix = isSS ? 'SH' : 'SZ';
            const { resolved } = resolveSymbol(querySymbol);
            if (resolved.split('.')[1] !== expectedSuffix) {
              meta = null;
            }
          }
        }
      } catch {
        // non-critical
      }

      setSymbol(resolvedSymbol);
      setStockMeta(meta);
      setKlines(rawKlines);
      setFractions(fractions);
      setStrokes(computedStrokes);
      setSegments(computedSegments);
      setHubs(computedHubs);
      setBsPoints(computedBSPoints);
      setBacktestTrades([]);
      setDataSource(data.source || 'TickFlow API');
      setDataPeriod(data.period || '');
      setStockBasicInfo(basicInfo);

      // Update URL with stock code + timeframe for bookmark/refresh support.
      // Replace only: the history entry was already pushed by the navigation
      // handler (or restored via popstate), so this just canonicalizes it.
      syncAppUrl('analyzer', querySymbol, tf, 'replace');

    } catch (err: any) {
      console.error(err);
      setErrorText(err.message || 'Failed to query and process mechanical stock charts. Please check parameters.');
    } finally {
      setIsLoading(false);
    }
  };

  // Latest fetch/klines via refs so the popstate listener (registered once)
  // always calls the current implementation and sees current data.
  const fetchRef = useRef<typeof fetchAndProcessStock | null>(null);
  fetchRef.current = fetchAndProcessStock;
  const klinesRef = useRef<Kline[]>(klines);
  klinesRef.current = klines;

  // Search from navbar / dashboard / scan always lands on the analyzer view.
  // Push a history entry so the browser back button returns to the previous view/stock.
  // Optional `tf` (from the 买卖点扫描周期切换) jumps straight into that timeframe
  // so weekly scan results open a weekly chart for every index/stock/ETF.
  const handleSearch = (querySymbol: string, tf?: KlineTimeframe) => {
    if (tf && tf !== timeframeRef.current) {
      setTimeframe(tf);
      timeframeRef.current = tf;
    }
    const activeTf = tf ?? timeframeRef.current;
    syncAppUrl('analyzer', querySymbol, activeTf, 'push');
    setView('analyzer');
    fetchAndProcessStock(querySymbol, activeTf);
  };

  // 日线 / 周线切换: 仅重拉图表 (K线 + 缠论重算), 其他信息保持不动.
  // 不碰: 基本面报价、行业/减持元数据、AI 对话 (GeminiAdvisor 仅在换股时清空)、
  // 回测报告 (BacktestManager 本地状态保留); 只有叠加在K线上的回测标记随图表刷新。
  const fetchChartTimeframe = async (querySymbol: string, next: KlineTimeframe) => {
    setIsLoading(true);
    setErrorText('');

    try {
      const data = await fetchStockData(querySymbol, next);
      const rawKlines: Kline[] = data.klines || [];

      if (rawKlines.length < 5) {
        throw new Error('Retrieved stock history has insufficient data bars for ChanLun processing.');
      }

      const { fractions, computedStrokes, computedSegments, computedHubs, computedBSPoints } =
        computeChanlunParts(rawKlines);

      setSymbol(data.symbol);
      setKlines(rawKlines);
      setFractions(fractions);
      setStrokes(computedStrokes);
      setSegments(computedSegments);
      setHubs(computedHubs);
      setBsPoints(computedBSPoints);
      setBacktestTrades([]);
      setDataSource(data.source || '');
      setDataPeriod(data.period || '');

      syncAppUrl('analyzer', querySymbol, next, 'replace');
    } catch (err: any) {
      console.error(err);
      setErrorText(err.message || 'Failed to query and process mechanical stock charts. Please check parameters.');
    } finally {
      setIsLoading(false);
    }
  };

  // 日线 / 周线切换: 保持当前 symbol, 仅刷新图表并进入 loading 态
  const handleTimeframeChange = (next: KlineTimeframe) => {
    if (next === timeframe || isLoading) return;
    setTimeframe(next);
    timeframeRef.current = next;
    syncAppUrl(viewRef.current, symbolRef.current, next, 'push');
    if (view === 'analyzer' && symbol) {
      fetchChartTimeframe(symbol, next);
    }
  };

  const handleViewChange = (nextView: ViewMode) => {
    if (nextView === viewRef.current && nextView !== 'analyzer') return;
    setView(nextView);
    syncAppUrl(nextView, symbolRef.current, timeframeRef.current, 'push');

    // First entry into the analyzer loads the current symbol
    if (nextView === 'analyzer' && klines.length === 0 && !isLoading) {
      fetchAndProcessStock(symbol);
    }
  };

  // Run on mount: only the analyzer view needs the default chart immediately.
  // Default always 日线: drop any ?tf= from the URL so it matches the daily state.
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    const bootUrl = new URL(window.location.href);
    if (bootUrl.searchParams.has('tf')) {
      bootUrl.searchParams.delete('tf');
      window.history.replaceState({}, '', bootUrl.toString());
    }
    if (initialView === 'analyzer') {
      const urlCode = new URLSearchParams(window.location.search).get('code') || '000001.ss';
      fetchAndProcessStock(urlCode, timeframeRef.current);
    }
  }, []);

  // Browser back/forward support: restore view + symbol + timeframe from the
  // URL and refetch the analyzer chart when the restored stock/period differs.
  useEffect(() => {
    const normalize = (code: string) => {
      try {
        return resolveSymbol(code).resolved;
      } catch {
        return code.trim().toUpperCase();
      }
    };
    const onPopState = () => {
      const route = parseAppUrl();
      const prevView = viewRef.current;
      const prevSymbol = symbolRef.current;
      const prevTf = timeframeRef.current;
      const viewChanged = route.view !== prevView;
      const symbolChanged = normalize(route.code) !== normalize(prevSymbol);
      const tfChanged = route.timeframe !== prevTf;

      if (viewChanged) setView(route.view);
      if (tfChanged) setTimeframe(route.timeframe);
      viewRef.current = route.view;
      timeframeRef.current = route.timeframe;

      if (route.view === 'analyzer') {
        const needFetch =
          viewChanged || symbolChanged || tfChanged || klinesRef.current.length === 0;
        if (needFetch) {
          fetchRef.current?.(route.code, route.timeframe);
        }
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Persist rail width whenever it settles.
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_RAIL_WIDTH_KEY, String(chatWidth));
    } catch {
      // ignore
    }
  }, [chatWidth]);

  // Global mouse listeners for the rail resize drag.
  const startResizingRail = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizingRail(true);
  }, []);

  useEffect(() => {
    if (!isResizingRail) return;

    const handleMouseMove = (e: MouseEvent) => {
      const next = window.innerWidth - e.clientX;
      setChatWidth(Math.min(CHAT_RAIL_MAX, Math.max(CHAT_RAIL_MIN, next)));
    };
    const handleMouseUp = () => setIsResizingRail(false);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [isResizingRail]);

  // The chart re-renders when its container width changes via ResizeObserver,
  // so no extra wiring is needed when chatWidth toggles or drags.

  const railOffset = isChatVisible && !isMobile ? chatWidth : 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      
      {/* Dynamic Navbar */}
      <Navbar
        onUserChanged={setCurrentUser}
        currentUser={currentUser}
        onOpenConfig={() => setIsConfigOpen(true)}
        onOpenAbout={() => setIsAboutOpen(true)}
        onSearch={handleSearch}
        isLoading={isLoading}
        activeSymbol={view === 'analyzer' ? symbol : undefined}
        klines={klines}
        stockBasicInfo={view === 'analyzer' ? stockBasicInfo : undefined}
        isMobile={isMobile}
        view={view}
        onViewChange={handleViewChange}
      />

      {/* Config View Modal */}
      <ConfigView isOpen={isConfigOpen} onClose={() => setIsConfigOpen(false)} />

      {/* About View Modal */}
      <AboutView
        isOpen={isAboutOpen}
        onClose={() => setIsAboutOpen(false)}
        dataSource={dataSource}
      />

      {/* Main Container - Dashboard (index) view */}
      {view === 'dashboard' && (
        <main className="flex-1 w-full px-[10px] py-[10px] md:px-6 md:py-6 lg:px-8">
          <MarketDashboard onSelectStock={handleSearch} />
        </main>
      )}

      {/* Main Container - Index ChanLun buy/sell points view */}
      {view === 'indexes' && (
        <main className="flex-1 w-full px-[10px] py-[10px] md:px-6 md:py-6 lg:px-8">
          <IndexAnalysis onSelectStock={handleSearch} />
        </main>
      )}

      {/* Main Container - Chart + Backtest scroll under the fixed right rail */}
      {view === 'analyzer' && (
      <main
        className="flex-1 w-full px-[10px] py-[10px] md:px-6 md:py-6 lg:px-8 transition-[padding] duration-200"
        style={{ paddingRight: isMobile ? `10px` : `calc(${railOffset}px + 1rem)` }}
      >

        {/* Global Loading / Error messages block.
            Initial load (no data yet): full-page spinner.
            Timeframe switch (data exists): keep chart mounted, overlay loading mode instead. */}
        {isLoading && klines.length === 0 && (
          <div className="p-6 md:p-12 text-center flex flex-col items-center justify-center">
            <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin mb-4" />
            <h4 className="text-sm font-semibold text-zinc-200">编译技术市场画布</h4>
            <p className="text-xs text-zinc-400 mt-1">合并K线包含关系并定位分型极值...</p>
          </div>
        )}

        {errorText && (
          <div className="px-3 py-3 md:p-5 md:bg-red-950/20 md:backdrop-blur-sm md:border md:border-red-900/30 text-red-400 md:rounded-2xl flex gap-3 text-xs">
            <Activity className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
            <div>
              <p className="font-bold">市场查询失败</p>
              <p className="text-zinc-400 leading-normal mt-1">{errorText}</p>
            </div>
          </div>
        )}

        {/* Content Panels - Stacked, full width under the rail.
            Keep mounted during timeframe refetch so only the chart canvas
            shows loading instead of unmounting. */}
        {klines.length > 0 && (
          <div className="flex flex-col gap-0 md:gap-6 h-full min-w-0">

            {/* Main Chart (stays mounted during 日线/周线 refetch;
                the lightweight-charts canvas itself shows loading state) */}
            <div className="flex-1 min-h-0 min-w-0">
              <ChanlunChart
                klines={klines}
                fractions={fractions}
                strokes={strokes}
                segments={segments}
                hubs={hubs}
                bsPoints={bsPoints}
                symbol={symbol}
                stockBasicInfo={stockBasicInfo}
                industry={stockMeta?.industry}
                actualController={stockMeta?.actual_controller}
                reductionPlans={stockMeta?.reduction_plans}
                backtestTrades={backtestTrades}
                timeframe={timeframe}
                dataPeriod={dataPeriod}
                isLoading={isLoading}
                onTimeframeChange={handleTimeframeChange}
              />
            </div>

            {/* AI Advisor - flows inline below the chart on mobile.
                Bounded height so the chat thread scrolls internally instead of
                pushing the backtest panel endlessly down the page. */}
            {isChatVisible && isMobile && (
              <div className="border-t border-zinc-800/60 h-[75vh] max-h-[700px] min-h-[480px]">
                <GeminiAdvisor
                  symbol={symbol}
                  klines={klines}
                  strokes={strokes}
                  segments={segments}
                  hubs={hubs}
                  fractions={fractions}
                  timeframe={timeframe}
                  onClose={() => setIsChatVisible(false)}
                />
              </div>
            )}

            <StockInfoPanel stockData={stockMeta} />

            {/* Backtest Manager */}
            <BacktestManager
              klines={klines}
              symbol={symbol}
              currentUser={currentUser}
              onBacktestResult={(trades) => setBacktestTrades(trades)}
            />

          </div>
        )}

      </main>
      )}

      {/* Fixed AI Right Rail - always-on-top side panel (desktop only, analyzer view) */}
      {view === 'analyzer' && isChatVisible && !isMobile && (
        <aside
          className="fixed right-0 z-40 flex shadow-[-12px_0_32px_-12px_rgba(0,0,0,0.6)]"
          style={{
            top: `${NAVBAR_HEIGHT}px`,
            bottom: 0,
            width: `${chatWidth}px`,
          }}
        >
          {/* Drag handle for resizing */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startResizingRail}
            className={`group relative w-1.5 shrink-0 cursor-col-resize bg-zinc-800/60 hover:bg-blue-500/40 transition-colors ${
              isResizingRail ? '!bg-blue-500/70' : ''
            }`}
            title="拖动以调整宽度"
          >
            <div className="absolute top-1/2 -translate-y-1/2 left-1/2 -translate-x-1/2 flex items-center justify-center w-4 h-10 rounded bg-zinc-900/80 border border-zinc-800 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              <GripVertical className="h-3 w-3 text-zinc-500" />
            </div>
          </div>

          {/* Panel content */}
          <div className="flex-1 min-w-0 h-full">
            <GeminiAdvisor
              symbol={symbol}
              klines={klines}
              strokes={strokes}
              segments={segments}
              hubs={hubs}
              fractions={fractions}
              timeframe={timeframe}
              onClose={() => setIsChatVisible(false)}
            />
          </div>
        </aside>
      )}

      {/* Floating tab to re-open the rail when collapsed (desktop only) */}
      {view === 'analyzer' && !isChatVisible && !isMobile && (
        <button
          type="button"
          onClick={() => setIsChatVisible(true)}
          className="fixed right-0 top-1/2 -translate-y-1/2 z-40 flex flex-col items-center gap-2 px-2 py-4 bg-blue-500/10 hover:bg-blue-500/20 border-y border-l border-blue-500/30 rounded-l-lg text-blue-400 transition-all cursor-pointer shadow-[-6px_0_16px_-6px_rgba(59,130,246,0.25)]"
          title="显示 AI 对话"
        >
          <BrainCircuit className="h-4 w-4" />
          <span className="text-[10px] font-mono [writing-mode:vertical-rl] [text-orientation:mixed] tracking-wider">
            AI 顾问
          </span>
        </button>
      )}

      {/* Mobile floating AI toggle */}
      {view === 'analyzer' && !isChatVisible && isMobile && (
        <button
          type="button"
          onClick={() => setIsChatVisible(true)}
          className="fixed right-4 z-40 flex items-center justify-center w-12 h-12 bg-blue-500 hover:bg-blue-400 active:bg-blue-600 rounded-full text-white shadow-lg shadow-blue-500/30 transition-all cursor-pointer"
          style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          title="显示 AI 对话"
        >
          <BrainCircuit className="h-5 w-5" />
        </button>
      )}

      {/* Humble Footer */}
      <footer
        className="border-t border-zinc-850 py-3 md:py-6 mt-0 md:mt-12 text-center text-[10px] font-mono text-zinc-500 transition-[padding] duration-200 px-3"
        style={{ paddingRight: isMobile || view === 'dashboard' ? 0 : `${railOffset}px` }}
      >
        <p>© 2026 缠论量化工作台。由 Google AI Studio 构建。<a href="https://github.com/huhk345/chanlun-stock-analyzer" target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-300 transition-colors">源代码</a></p>
        <p className="mt-1">本工具仅供学习研究使用, 不构成任何投资建议, 投资有风险, 入市需谨慎。</p>
      </footer>

    </div>
  );
}
