import React, { useState } from 'react';
import { Search, Compass, Globe } from 'lucide-react';

interface StockSearchProps {
  onSearch: (symbol: string) => void;
  isLoading: boolean;
  activeSymbol: string;
}

const PRESET_STOCKS = [
  { symbol: '600519', name: 'Moutai (贵州茅台)' },
  { symbol: '002594', name: 'BYD (比亚迪)' },
  { symbol: '000001', name: 'PingAn Bank (平安银行)' },
  { symbol: '600036', name: 'CMB (招商银行)' },
  { symbol: '601318', name: 'PingAn Insurance (中国平安)' },
  { symbol: '000858', name: 'Wuliangye (五粮液)' }
];

export default function StockSearch({ onSearch, isLoading, activeSymbol }: StockSearchProps) {
  const [ticker, setTicker] = useState(activeSymbol);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ticker.trim()) return;
    onSearch(ticker.toUpperCase().trim());
  };

  const handlePresetClick = (symbol: string) => {
    setTicker(symbol);
    onSearch(symbol);
  };

  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-sm overflow-hidden relative text-zinc-100">
      <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-6">
        
        {/* Left Search input */}
        <div className="w-full lg:max-w-md">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-widest flex items-center gap-2 mb-2 font-sans">
            <Compass className="h-4 w-4 text-emerald-400" />
            <span>搜索A股股票代码</span>
          </h2>
          <form onSubmit={handleSubmit} className="relative flex items-center">
            <input
              type="text"
              value={ticker}
              onChange={(e) => setTicker(e.target.value)}
              placeholder="例如: 600519, 000001, 002594..."
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

        {/* Info Badge */}
        <div className="flex items-center gap-3 px-4 py-2 bg-zinc-950 rounded-xl border border-zinc-800">
          <div className="h-8 w-8 bg-emerald-500/10 rounded-lg flex items-center justify-center">
            <Globe className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <span className="text-[10px] text-zinc-500 font-mono tracking-wider block uppercase font-sans">数据范围</span>
            <span className="text-sm font-bold text-zinc-100">5年日K线 · 前复权</span>
          </div>
        </div>

      </div>

      {/* Preset shortcuts */}
      <div className="mt-4 pt-4 border-t border-zinc-800/80">
        <div className="flex items-center gap-2 mb-2">
          <Globe className="h-3.5 w-3.5 text-zinc-500" />
          <span className="text-[10px] font-semibold uppercase font-sans tracking-widest text-zinc-500">热门A股</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESET_STOCKS.map(item => (
            <button
              key={item.symbol}
              type="button"
              onClick={() => handlePresetClick(item.symbol)}
              className={`px-3 py-1.5 rounded-xl border text-[11px] font-sans font-medium hover:border-emerald-500 hover:text-emerald-400 transition-all cursor-pointer ${
                activeSymbol === item.symbol || activeSymbol === `${item.symbol}.SS` || activeSymbol === `${item.symbol}.SZ`
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
