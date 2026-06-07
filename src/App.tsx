import { useState, useEffect } from 'react';
import { Activity, CheckCircle2 } from 'lucide-react';
import Navbar from './components/Navbar';
import ChanlunChart from './components/ChanlunChart';
import BacktestManager from './components/BacktestManager';
import GeminiAdvisor from './components/GeminiAdvisor';
import ConfigView from './components/ConfigView';
import { SupabaseUser } from './utils/supabase';
import { Kline, Stroke, Segment, Hub } from './types/stock';
import {
  mergeKlines,
  findFractions,
  calculateStrokes,
  calculateSegments,
  calculateHubs
} from './utils/chanlun';
import { fetchStockData } from './utils/api';

export default function App() {
  const [currentUser, setCurrentUser] = useState<SupabaseUser | null>(null);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  
  // Stock queries parameters
  const [symbol, setSymbol] = useState('600000');
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  // Processed ChanLun arrays
  const [klines, setKlines] = useState<Kline[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [dataSource, setDataSource] = useState('');

  const fetchAndProcessStock = async (querySymbol: string) => {
    setIsLoading(true);
    setErrorText('');

    try {
      const data = await fetchStockData(querySymbol);
      const rawKlines: Kline[] = data.klines || [];
      
      if (rawKlines.length < 5) {
        throw new Error('Retrieved stock history has insufficient data bars for ChanLun processing.');
      }

      // Step-by-step ChanLun execution on fetched candlesticks
      const merged = mergeKlines(rawKlines);
      const fractions = findFractions(merged, rawKlines);
      const computedStrokes = calculateStrokes(fractions);
      const computedSegments = calculateSegments(computedStrokes);
      const computedHubs = calculateHubs(computedStrokes);

      // Sync React state
      setSymbol(data.symbol);
      setKlines(rawKlines);
      setStrokes(computedStrokes);
      setSegments(computedSegments);
      setHubs(computedHubs);
      setDataSource(data.source || 'TickFlow API');

    } catch (err: any) {
      console.error(err);
      setErrorText(err.message || 'Failed to query and process mechanical stock charts. Please check parameters.');
    } finally {
      setIsLoading(false);
    }
  };

  // Run on mount to display a majestic default chart
  useEffect(() => {
    fetchAndProcessStock('600000');
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      
      {/* Dynamic Navbar */}
      <Navbar
        onUserChanged={setCurrentUser}
        currentUser={currentUser}
        onOpenConfig={() => setIsConfigOpen(true)}
        onSearch={fetchAndProcessStock}
        isLoading={isLoading}
        activeSymbol={symbol}
      />

      {/* Config View Modal */}
      <ConfigView isOpen={isConfigOpen} onClose={() => setIsConfigOpen(false)} />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-8 space-y-6">

        {/* Global Loading / Error messages block */}
        {isLoading && (
          <div className="p-12 text-center bg-zinc-900 border border-zinc-800 rounded-2xl shadow-sm flex flex-col items-center justify-center">
            <div className="h-8 w-8 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin mb-4" />
            <h4 className="text-sm font-semibold text-zinc-200">编译技术市场画布</h4>
            <p className="text-xs text-zinc-550 mt-1 text-zinc-400">合并K线包含关系并定位分型极值...</p>
          </div>
        )}

        {errorText && (
          <div className="p-5 bg-red-950/20 border border-red-900/30 text-red-400 rounded-2xl flex gap-3 text-xs">
            <Activity className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
            <div>
              <p className="font-extrabold font-sans">市场查询失败</p>
              <p className="text-zinc-405 leading-normal font-sans mt-1 text-zinc-400">{errorText}</p>
            </div>
          </div>
        )}

        {/* Content Panels (Active only when stock data is loaded) */}
        {!isLoading && klines.length > 0 && (
          <div className="space-y-6 transition-all duration-300">
            
            {/* 1. Main visual chart */}
            <ChanlunChart
              klines={klines}
              strokes={strokes}
              segments={segments}
              hubs={hubs}
              symbol={symbol}
            />

            {/* Source label badge */}
            <div className="flex items-center justify-between px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-[10px] text-zinc-400 font-mono">
              <span>活跃数据源: <strong>{dataSource}</strong></span>
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                结构分析同步成功
              </span>
            </div>

            {/* 2. Custom Bento Grid for Backtester & Gemini Advisor */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

              {/* Backtester Side */}
              <BacktestManager
                klines={klines}
                symbol={symbol}
                currentUser={currentUser}
              />

              {/* Gemini Advisor Side */}
              <GeminiAdvisor
                symbol={symbol}
                klines={klines}
                strokes={strokes}
                segments={segments}
                hubs={hubs}
              />

            </div>

          </div>
        )}

      </main>

      {/* Humble Footer */}
      <footer className="border-t border-zinc-850 py-6 mt-12 text-center text-[10px] font-mono text-zinc-500">
        <p>© 2026 缠论量化工作台。由 Google AI Studio 构建。</p>
      </footer>

    </div>
  );
}
