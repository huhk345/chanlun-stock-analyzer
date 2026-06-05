import React, { useState } from 'react';
import { Search, TrendingUp, Compass, Globe } from 'lucide-react';

interface StockSearchProps {
  onSearch: (symbol: string, range: string, interval: string) => void;
  isLoading: boolean;
  activeSymbol: string;
  activeRange: string;
  activeInterval: string;
}

const PRESET_STOCKS = [
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'TSLA', name: 'Tesla Inc.' },
  { symbol: '600519', name: 'Moutai (贵州茅台)' },
  { symbol: '002594', name: 'BYD (比亚迪)' },
  { symbol: 'NVDA', name: 'Nvidia Corp.' },
  { symbol: '000001', name: 'PingAn Bank (平安银行)' }
];

export default function StockSearch({ onSearch, isLoading, activeSymbol, activeRange, activeInterval }: StockSearchProps) {
  const [ticker, setTicker] = useState(activeSymbol);
  const [range, setRange] = useState(activeRange);
  const [interval, setIntervalVal] = useState(activeInterval);

  // Sync internal state when props update
  React.useEffect(() => {
    setIntervalVal(activeInterval);
  }, [activeInterval]);

  React.useEffect(() => {
    setRange(activeRange);
  }, [activeRange]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticker.trim()) return;
    onSearch(ticker.toUpperCase().trim(), range, interval);
  };

  const handlePresetClick = (symbol: string) => {
    setTicker(symbol);
    onSearch(symbol, range, interval);
  };

  const handleRangeChange = (newRange: string) => {
    setRange(newRange);
    if (ticker.trim()) {
      onSearch(ticker.toUpperCase().trim(), newRange, interval);
    }
  };

  const handleIntervalChange = (newInterval: string) => {
    setIntervalVal(newInterval);
    if (ticker.trim()) {
      onSearch(ticker.toUpperCase().trim(), range, newInterval);
    }
  };

  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-sm overflow-hidden relative text-zinc-100">
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-6">
        
        {/* Left Search input */}
        <div className="w-full lg:max-w-md">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest flex items-center gap-2 mb-2 font-sans">
            <Compass className="h-4 w-4 text-emerald-400" />
            <span>Search Global / A-Share Tickers</span>
          </h2>
          <form onSubmit={handleSubmit} className="relative flex items-center">
            <input
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="e.g. AAPL, NVDA, 600519..."
              disabled={isLoading}
              className="w-full pl-4 pr-12 py-2.5 text-sm bg-zinc-950 text-zinc-100 border border-zinc-800 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500 font-mono"
            />
            <button
               type="submit"
               disabled={isLoading}
               className="absolute right-2 p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-750 text-zinc-100 transition-all disabled:opacity-50 cursor-pointer"
               id="btn-search-ticker"
            >
              <Search className="h-4 w-4" />
            </button>
          </form>
        </div>

        {/* Range Selector & Timeframe Interval Selector */}
        <div className="flex flex-wrap items-center gap-6">
          {/* Timeframe Interval Control */}
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-zinc-500 mb-2 font-sans uppercase tracking-widest">K-line Interval</span>
            <div className="inline-flex bg-zinc-950 p-1 rounded-xl border border-zinc-800">
              {[
                { value: '5m', label: '5 Min' },
                { value: '60m', label: '60 Min' },
                { value: '4h', label: '4 Hour' },
                { value: '1d', label: 'Daily' }
              ].map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleIntervalChange(opt.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg font-mono transition-all cursor-pointer ${
                    interval === opt.value
                      ? 'bg-emerald-500 text-zinc-950 font-bold shadow'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                  id={`btn-interval-${opt.value}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Range Selection Control */}
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-zinc-500 mb-2 font-sans uppercase tracking-widest">Analyze Horizon</span>
            <div className="inline-flex bg-zinc-950 p-1 rounded-xl border border-zinc-800">
              {[
                { value: '6m', label: '6 Month' },
                { value: '1y', label: '1 Year' },
                { value: '2y', label: '2 Year' }
              ].map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => handleRangeChange(opt.value)}
                  disabled={interval !== '1d'}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg font-mono transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
                    range === opt.value
                      ? 'bg-zinc-800 text-zinc-100 shadow'
                      : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                  id={`btn-range-${opt.value}`}
                  title={interval !== '1d' ? 'Horizon applies only to Daily interval (intraday handles automatic timeframe)' : ''}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

      </div>

      {/* Preset shortcuts */}
      <div className="mt-4 pt-4 border-t border-zinc-800/80">
        <div className="flex items-center gap-2 mb-2">
          <Globe className="h-3.5 w-3.5 text-zinc-500" />
          <span className="text-[10px] font-semibold uppercase font-sans tracking-widest text-zinc-500">Benchmarking Showcase</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESET_STOCKS.map(item => (
            <button
              key={item.symbol}
              type="button"
              onClick={() => handlePresetClick(item.symbol)}
              className={`px-3 py-1.5 rounded-xl border text-[11px] font-sans font-medium hover:border-emerald-500 hover:text-emerald-400 transition-all cursor-pointer ${
                activeSymbol === item.symbol || (item.symbol === '600519' && activeSymbol === '600519.SS')
                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400 font-bold'
                  : 'border-zinc-805 bg-zinc-950 text-zinc-400 border-zinc-800 hover:bg-zinc-800'
              }`}
              id={`preset-${item.symbol}`}
            >
              <strong>{item.symbol}</strong> <span className="opacity-75 font-normal ml-0.5 text-zinc-500">{item.name}</span>
            </button>
          ))}
        </div>
      </div>

    </div>
  );
}
