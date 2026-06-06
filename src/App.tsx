import React, { useState, useEffect } from 'react';
import { Activity, BookOpen, LineChart, Cpu, Sparkles, CheckCircle2 } from 'lucide-react';
import Navbar from './components/Navbar';
import StockSearch from './components/StockSearch';
import ChanlunChart from './components/ChanlunChart';
import BacktestManager from './components/BacktestManager';
import GeminiAdvisor from './components/GeminiAdvisor';
import { SupabaseUser } from './utils/supabase';
import { Kline, Stroke, Segment, Hub, BuySellPoint } from './types/stock';
import {
  mergeKlines,
  findFractions,
  calculateStrokes,
  calculateSegments,
  calculateHubs,
  calculateBuySellPoints
} from './utils/chanlun';
import { calculateMACD, calculateBollingerBands } from './utils/indicators';

export default function App() {
  const [currentUser, setCurrentUser] = useState<SupabaseUser | null>(null);
  
  // Stock queries parameters
  const [symbol, setSymbol] = useState('600000');
  const [isLoading, setIsLoading] = useState(false);
  const [errorText, setErrorText] = useState('');

  // Processed ChanLun arrays
  const [klines, setKlines] = useState<Kline[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [buySellPoints, setBuySellPoints] = useState<BuySellPoint[]>([]);
  const [dataSource, setDataSource] = useState('');

  const fetchAndProcessStock = async (querySymbol: string) => {
    setIsLoading(true);
    setErrorText('');

    try {
      const response = await fetch(`/api/stock?symbol=${querySymbol}`);
      if (!response.ok) {
        throw new Error('Stock retrieval endpoint failed');
      }

      const data = await response.json();
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

      // 计算MACD和BOLL指标用于买卖点动力学辅助判断
      const macdData = calculateMACD(rawKlines, 12, 26, 9);
      const bollData = calculateBollingerBands(rawKlines, 20, 2);

      const computedSignals = calculateBuySellPoints(
        computedStrokes,
        computedHubs,
        rawKlines,
        macdData,
        bollData
      );

      // Sync React state
      setSymbol(data.symbol);
      setKlines(rawKlines);
      setStrokes(computedStrokes);
      setSegments(computedSegments);
      setHubs(computedHubs);
      setBuySellPoints(computedSignals);
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
      <Navbar onUserChanged={setCurrentUser} currentUser={currentUser} />

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 md:p-8 space-y-6">
        
        {/* Welcome Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-zinc-900 border border-zinc-800 p-6 rounded-2xl text-zinc-100 shadow-md relative overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.06),transparent_45%)]" />
          <div className="space-y-1 relative">
            <h2 className="text-xl font-bold font-sans tracking-tight uppercase">缠论量化交易工作台</h2>
            <p className="text-zinc-400 text-xs font-normal max-w-2xl">
              应用缠中说禅结构分析全球股票市场。追踪笔、线段和重叠中枢结构。
            </p>
          </div>
          <div className="flex items-center gap-3 relative shrink-0">
            <div className="h-10 w-10 bg-zinc-950 rounded-xl flex items-center justify-center border border-zinc-850">
              <LineChart className="h-5 w-5 text-emerald-400 animate-pulse" />
            </div>
            <div className="text-left">
              <span className="text-[10px] text-zinc-500 font-mono tracking-wider block uppercase font-sans">当前关注资产</span>
              <span className="text-sm font-bold font-mono text-emerald-400">{symbol}</span>
            </div>
          </div>
        </div>

        {/* Search Panel */}
        <StockSearch 
          onSearch={fetchAndProcessStock} 
          isLoading={isLoading} 
          activeSymbol={symbol}
        />

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
              buySellPoints={buySellPoints}
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
                buySellPoints={buySellPoints} 
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
                buySellPoints={buySellPoints}
              />

            </div>

          </div>
        )}

        {/* ChanLun Introduction / Theory card */}
        <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-sm">
          <h3 className="text-xs font-bold text-zinc-350 flex items-center gap-2 mb-4 uppercase tracking-wider">
            <BookOpen className="h-4.5 w-4.5 text-emerald-400" />
            <span>缠论理论入门与参考</span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-[11px] text-zinc-400 leading-relaxed font-sans">
            <div className="space-y-1.5 p-4 bg-zinc-950/40 rounded-xl border border-zinc-850">
              <span className="px-2 py-0.5 rounded text-[10px] font-mono text-emerald-400 bg-emerald-950/20 border border-emerald-900/30 font-bold uppercase block w-fit">基础元素:笔</span>
              <p className="text-zinc-400 font-sans mt-2">
                经过K线包含关系处理后形成。必须起始于底分型,结束于顶分型,且起点和终点之间至少有5根原始或合并K线。
              </p>
            </div>
            
            <div className="space-y-1.5 p-4 bg-zinc-950/40 rounded-xl border border-zinc-850">
              <span className="px-2 py-0.5 rounded text-[10px] font-mono text-cyan-400 bg-cyan-950/20 border border-cyan-900/30 font-bold uppercase block w-fit">盘整核心:中枢</span>
              <p className="text-zinc-400 font-sans mt-2">
                由连续三笔的价格区间重叠部分形成。该核心区域主导趋势走向,提供突破压力位和支撑位。
              </p>
            </div>

            <div className="space-y-1.5 p-4 bg-zinc-950/40 rounded-xl border border-zinc-850">
              <span className="px-2 py-0.5 rounded text-[10px] font-mono text-amber-400 bg-amber-950/20 border border-amber-900/30 font-bold uppercase block w-fit">信号矩阵:买卖点</span>
              <p className="text-zinc-400 font-sans mt-2">
                <strong>一类买卖点</strong>在关键趋势背离极值触发。<strong>二类买卖点</strong>在回调确认相对高低点触发。<strong>三类买卖点</strong>在突破回测确认触发。
              </p>
            </div>
          </div>
        </div>

      </main>

      {/* Humble Footer */}
      <footer className="border-t border-zinc-850 py-6 mt-12 text-center text-[10px] font-mono text-zinc-500">
        <p>© 2026 缠论量化工作台。由 Google AI Studio 构建。</p>
      </footer>

    </div>
  );
}
