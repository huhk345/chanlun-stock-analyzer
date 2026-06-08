import { useState, useEffect, useCallback, useRef } from 'react';
import { Activity, BrainCircuit, GripVertical } from 'lucide-react';
import Navbar from './components/Navbar';
import ChanlunChart from './components/ChanlunChart';
import BacktestManager from './components/BacktestManager';
import GeminiAdvisor from './components/GeminiAdvisor';
import ConfigView from './components/ConfigView';
import AboutView from './components/AboutView';
import StockInfoPanel from './components/StockInfoPanel';
import { SupabaseUser } from './utils/supabase';
import { Kline, Stroke, Segment, Hub, Fraction, StockBasicInfo } from './types/stock';
import {
  mergeKlines,
  findFractions,
  calculateStrokes,
  calculateSegments,
  calculateHubs
} from './utils/chanlun';
import { fetchStockData, fetchStockBasicInfo } from './utils/api';

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

export default function App() {
  const [currentUser, setCurrentUser] = useState<SupabaseUser | null>(null);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const [isChatVisible, setIsChatVisible] = useState(true);

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

  // Stock queries parameters
  const initialCode = new URLSearchParams(window.location.search).get('code') || '000001.ss';
  const [symbol, setSymbol] = useState(initialCode);
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  // Processed ChanLun arrays
  const [klines, setKlines] = useState<Kline[]>([]);
  const [fractions, setFractions] = useState<Fraction[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [dataSource, setDataSource] = useState('');
  const [stockBasicInfo, setStockBasicInfo] = useState<StockBasicInfo | null>(null);
  const [stockMeta, setStockMeta] = useState<StockMeta | null>(null);

  const fetchAndProcessStock = async (querySymbol: string) => {
    setIsLoading(true);
    setErrorText('');

    try {
      const data = await fetchStockData(querySymbol);
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
      const merged = mergeKlines(rawKlines);
      const fractions = findFractions(merged, rawKlines);
      const computedStrokes = calculateStrokes(fractions);
      const computedSegments = calculateSegments(computedStrokes);
      const computedHubs = calculateHubs(computedStrokes);

      // Wait for basic info and sync React state
      const basicInfo = await basicInfoPromise;

      // Fetch stock metadata (industry, controller, reduction plans)
      const resolvedSymbol = data.symbol;
      const pureCode = resolvedSymbol.split('.')[0];
      let meta: StockMeta | null = null;
      try {
        const resp = await fetch('/merged_stock_data.json');
        if (resp.ok) {
          const cache = await resp.json();
          meta = cache[pureCode] || null;
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
      setDataSource(data.source || 'TickFlow API');
      setStockBasicInfo(basicInfo);

      // Update URL with stock code for bookmark/refresh support
      const url = new URL(window.location.href);
      url.searchParams.set('code', pureCode);
      window.history.replaceState({}, '', url.toString());

    } catch (err: any) {
      console.error(err);
      setErrorText(err.message || 'Failed to query and process mechanical stock charts. Please check parameters.');
    } finally {
      setIsLoading(false);
    }
  };

  // Run on mount to display a majestic default chart
  useEffect(() => {
    if (hasInitialized.current) return;
    hasInitialized.current = true;
    const urlCode = new URLSearchParams(window.location.search).get('code') || '000001.ss';
    fetchAndProcessStock(urlCode);
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

  const renderAdvisor = (extraWrapperClassName = '') => (
    <div className={extraWrapperClassName}>
      <GeminiAdvisor
        symbol={symbol}
        klines={klines}
        strokes={strokes}
        segments={segments}
        hubs={hubs}
        fractions={fractions}
        onClose={isMobile ? () => setIsChatVisible(false) : undefined}
      />
    </div>
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      
      {/* Dynamic Navbar */}
      <Navbar
        onUserChanged={setCurrentUser}
        currentUser={currentUser}
        onOpenConfig={() => setIsConfigOpen(true)}
        onOpenAbout={() => setIsAboutOpen(true)}
        onSearch={fetchAndProcessStock}
        isLoading={isLoading}
        activeSymbol={symbol}
        klines={klines}
        stockBasicInfo={stockBasicInfo}
      />

      {/* Config View Modal */}
      <ConfigView isOpen={isConfigOpen} onClose={() => setIsConfigOpen(false)} />

      {/* About View Modal */}
      <AboutView
        isOpen={isAboutOpen}
        onClose={() => setIsAboutOpen(false)}
        dataSource={dataSource}
      />

      {/* Main Container - Chart + Backtest scroll under the fixed right rail */}
      <main
        className="flex-1 w-full px-4 md:px-6 lg:px-8 py-6 transition-[padding] duration-200"
        style={{ paddingRight: `calc(${railOffset}px + 1rem)` }}
      >

        {/* Global Loading / Error messages block */}
        {isLoading && (
          <div className="p-12 text-center bg-zinc-900/50 backdrop-blur-sm border border-zinc-800/50 rounded-2xl shadow-lg flex flex-col items-center justify-center">
            <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin mb-4" />
            <h4 className="text-sm font-semibold text-zinc-200">编译技术市场画布</h4>
            <p className="text-xs text-zinc-400 mt-1">合并K线包含关系并定位分型极值...</p>
          </div>
        )}

        {errorText && (
          <div className="p-5 bg-red-950/20 backdrop-blur-sm border border-red-900/30 text-red-400 rounded-2xl flex gap-3 text-xs">
            <Activity className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
            <div>
              <p className="font-bold">市场查询失败</p>
              <p className="text-zinc-400 leading-normal mt-1">{errorText}</p>
            </div>
          </div>
        )}

        {/* Content Panels - Stacked, full width under the rail */}
        {!isLoading && klines.length > 0 && (
          <div className="flex flex-col gap-6 h-full min-w-0">

            {/* Main Chart */}
            <div className="flex-1 min-h-0 min-w-0">
              <ChanlunChart
                klines={klines}
                fractions={fractions}
                strokes={strokes}
                segments={segments}
                hubs={hubs}
                symbol={symbol}
                stockBasicInfo={stockBasicInfo}
                industry={stockMeta?.industry}
                actualController={stockMeta?.actual_controller}
                reductionPlans={stockMeta?.reduction_plans}
              />
            </div>

            {/* AI Advisor - flows inline below the chart on mobile */}
            {isChatVisible && isMobile && renderAdvisor()}

            <StockInfoPanel stockData={stockMeta} />

            {/* Backtest Manager */}
            <BacktestManager
              klines={klines}
              symbol={symbol}
              currentUser={currentUser}
            />

          </div>
        )}

      </main>

      {/* Fixed AI Right Rail - always-on-top side panel (desktop only) */}
      {isChatVisible && !isMobile && (
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
              onClose={() => setIsChatVisible(false)}
            />
          </div>
        </aside>
      )}

      {/* Floating tab to re-open the rail when collapsed (desktop only) */}
      {!isChatVisible && !isMobile && (
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

      {/* Humble Footer */}
      <footer
        className="border-t border-zinc-850 py-6 mt-12 text-center text-[10px] font-mono text-zinc-500 transition-[padding] duration-200"
        style={{ paddingRight: `${railOffset}px` }}
      >
        <p>© 2026 缠论量化工作台。由 Google AI Studio 构建。</p>
      </footer>

    </div>
  );
}
