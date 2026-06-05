import React, { useState, useRef, useEffect, useMemo } from 'react';
import * as d3 from 'd3';
import { Layers, Eye, EyeOff, ZoomIn, Info, AlertCircle } from 'lucide-react';
import { Kline, Stroke, Segment, Hub, BuySellPoint } from '../types/stock';
import { calculateSMA, calculateBollingerBands, calculateMACD } from '../utils/indicators';

interface ChanlunChartProps {
  klines: Kline[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
  buySellPoints: BuySellPoint[];
  symbol: string;
}

export default function ChanlunChart({ klines, strokes, segments, hubs, buySellPoints, symbol }: ChanlunChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 480 });

  // Viewport zoom brush borders (percentage range [0, 100])
  const [zoomRange, setZoomRange] = useState<[number, number]>([0, 100]);

  // Display triggers
  const [showCandles, setShowCandles] = useState(true);
  const [showStrokes, setShowStrokes] = useState(true);
  const [showSegments, setShowSegments] = useState(true);
  const [showHubs, setShowHubs] = useState(true);
  const [showSignals, setShowSignals] = useState(true);

  // Display triggers for indicators
  const [showMA5, setShowMA5] = useState(false);
  const [showMA20, setShowMA20] = useState(false);
  const [showBOLL, setShowBOLL] = useState(false);
  const [showMACD, setShowMACD] = useState(false);

  // Hover state
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });

  // Setup ResizeObserver for standard container fluid boundaries
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const { width, height } = entries[0].contentRect;
      setDimensions({
        width: Math.max(width, 320),
        height: Math.max(height, 420)
      });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);


  // Sync zoom limits on loaded data transition
  useEffect(() => {
    // Zoom to last 80 candles by default to make it look incredibly clean,
    // and let users brush out to look at the whole timeline.
    if (klines.length > 80) {
      const defaultStart = Math.max(0, klines.length - 80);
      const startPercent = Math.floor((defaultStart / klines.length) * 100);
      setZoomRange([startPercent, 100]);
    } else {
      setZoomRange([0, 100]);
    }
  }, [klines.length]);

  if (klines.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-8 h-96 flex flex-col items-center justify-center text-center">
        <AlertCircle className="h-10 w-10 text-gray-300 mb-2 animate-bounce" />
        <h4 className="text-gray-500 font-medium font-sans">No Market Data Available</h4>
        <p className="text-xs text-gray-400 mt-1">Please enter a valid stock ticker in the finder above.</p>
      </div>
    );
  }

  // Filter K-lines and overlay bounds based on active Zoom brush
  const startIdx = Math.floor((zoomRange[0] / 100) * klines.length);
  const endIdx = Math.min(klines.length - 1, Math.ceil((zoomRange[1] / 100) * klines.length));

  // Safeguard viewport indexes
  const visibleKlinesCount = Math.max(5, endIdx - startIdx + 1);
  const activeStartIdx = Math.max(0, Math.min(startIdx, klines.length - visibleKlinesCount));
  const activeEndIdx = Math.min(klines.length - 1, activeStartIdx + visibleKlinesCount - 1);

  const visibleKlines = klines.slice(activeStartIdx, activeEndIdx + 1);

  // Compute indicators using our indicators utility
  const ma5Values = useMemo(() => calculateSMA(klines, 5), [klines]);
  const ma20Values = useMemo(() => calculateSMA(klines, 20), [klines]);
  const bollValues = useMemo(() => calculateBollingerBands(klines, 20, 2), [klines]);
  const macdValues = useMemo(() => calculateMACD(klines, 12, 26, 9), [klines]);

  // Compute local price extremes to optimize Y-axis boundaries
  let minPrice = d3.min(visibleKlines, f => f.low) || 0;
  let maxPrice = d3.max(visibleKlines, f => f.high) || 100;

  // If Bollinger bands are active, expand price borders slightly to contain them beautifully
  if (showBOLL) {
    const visibleBollMid = bollValues.middle.slice(activeStartIdx, activeEndIdx + 1).filter(v => v !== null) as number[];
    const visibleBollUpper = bollValues.upper.slice(activeStartIdx, activeEndIdx + 1).filter(v => v !== null) as number[];
    const visibleBollLower = bollValues.lower.slice(activeStartIdx, activeEndIdx + 1).filter(v => v !== null) as number[];
    
    if (visibleBollUpper.length > 0) {
      maxPrice = Math.max(maxPrice, ...visibleBollUpper);
      minPrice = Math.min(minPrice, ...visibleBollLower);
    }
  }

  // Padding buffer (12% ceiling and floor spacing for clean rendering of badges)
  const priceBuffer = (maxPrice - minPrice) * 0.12 || 5;
  minPrice = Math.max(0.01, minPrice - priceBuffer);
  maxPrice = maxPrice + priceBuffer;

  // Chart padding configurations & conditional MACD splitting
  const padding = { top: 40, right: 65, bottom: 40, left: 20 };
  const graphWidth = dimensions.width - padding.left - padding.right;
  const macdPanelHeight = showMACD ? 90 : 0;
  const graphHeight = dimensions.height - padding.top - padding.bottom - macdPanelHeight;

  // Scalers using D3 libraries
  const xScale = d3.scaleLinear()
    .domain([activeStartIdx, activeEndIdx])
    .range([padding.left, dimensions.width - padding.right]);

  const yScale = d3.scaleLinear()
    .domain([minPrice, maxPrice])
    .range([dimensions.height - padding.bottom - macdPanelHeight, padding.top]);

  // Calculate local extremes for MACD context if shown
  const visibleMACD = useMemo(() => {
    if (!showMACD) return null;
    const slices = {
      dif: macdValues.dif.slice(activeStartIdx, activeEndIdx + 1),
      dea: macdValues.dea.slice(activeStartIdx, activeEndIdx + 1),
      histogram: macdValues.histogram.slice(activeStartIdx, activeEndIdx + 1),
    };
    
    const allVals = [
      ...slices.dif.filter((v): v is number => v !== null),
      ...slices.dea.filter((v): v is number => v !== null),
      ...slices.histogram.filter((v): v is number => v !== null),
    ];
    
    const minVal = d3.min(allVals) || -1;
    const maxVal = d3.max(allVals) || 1;
    
    const limit = Math.max(Math.abs(minVal), Math.abs(maxVal), 0.1);
    return {
      limit: limit * 1.15,
      dif: macdValues.dif,
      dea: macdValues.dea,
      histogram: macdValues.histogram
    };
  }, [showMACD, macdValues, activeStartIdx, activeEndIdx]);
  
  const macdScaleY = useMemo(() => {
    if (!visibleMACD) return null;
    const bottomY = dimensions.height - padding.bottom;
    const topY = dimensions.height - padding.bottom - macdPanelHeight + 15;
    return d3.scaleLinear()
      .domain([-visibleMACD.limit, visibleMACD.limit])
      .range([bottomY, topY]);
  }, [visibleMACD, dimensions.height, padding.bottom, macdPanelHeight]);

  // Handle Chart Interaction / Hover Tracker
  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement, MouseEvent>) => {
    const svgRect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - svgRect.left;
    const mouseY = e.clientY - svgRect.top;

    // Resolve index from coordinate
    const resolvedIndex = Math.round(xScale.invert(mouseX));
    if (resolvedIndex >= activeStartIdx && resolvedIndex <= activeEndIdx) {
      setHoveredIdx(resolvedIndex);
      setHoverPos({ x: mouseX, y: mouseY });
    } else {
      setHoveredIdx(null);
    }
  };

  const handleMouseLeave = () => {
    setHoveredIdx(null);
  };

  // Safe getter for hovered details
  const activeHoveredCandle = hoveredIdx !== null ? klines[hoveredIdx] : null;

  // Multi-grids
  const yTicks = yScale.ticks(6);
  const visibleIndexSpan = activeEndIdx - activeStartIdx;
  const xTickInterval = Math.max(1, Math.round(visibleIndexSpan / 6));
  const xTicks: number[] = [];
  for (let i = activeStartIdx; i <= activeEndIdx; i += xTickInterval) {
    xTicks.push(i);
  }

  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 text-zinc-100 shadow-xl flex flex-col gap-4">
      
      {/* Top Header Controls bar */}
      <div className="flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-4">
        <div>
          <span className="text-[10px] font-mono tracking-widest text-emerald-400 bg-emerald-950/40 border border-emerald-900/50 px-2 py-0.5 rounded uppercase">Zen Engine</span>
          <h3 className="text-lg font-bold font-sans tracking-tight mt-1 flex items-center gap-2">
            <span>{symbol}</span>
            <span className="text-xs text-zinc-400 font-normal">K-line Architecture & Structural ChanLun</span>
          </h3>
        </div>

        {/* Visibility Toggles of Structure and Selectable Technical Indicators */}
        <div className="flex flex-wrap items-center gap-4">
          
          {/* Zen Structure Controls */}
          <div className="flex flex-wrap items-center gap-1.5 bg-zinc-950 p-1.5 rounded-xl border border-zinc-850">
            <span className="text-[9px] font-mono font-semibold text-zinc-500 uppercase tracking-widest px-1.5">Zen:</span>
            <button
              onClick={() => setShowCandles(!showCandles)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans flex items-center gap-1.5 transition-all cursor-pointer ${
                showCandles ? 'bg-zinc-800 text-zinc-100 shadow border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Toggle Raw Candlesticks"
              id="toggle-candles"
            >
              <span>K-line</span>
            </button>

            <button
              onClick={() => setShowStrokes(!showStrokes)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans flex items-center gap-1.5 transition-all cursor-pointer ${
                showStrokes ? 'bg-amber-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Toggle ChanLun Strokes"
              id="toggle-strokes"
            >
              <span>Stroke (笔)</span>
            </button>

            <button
              onClick={() => setShowSegments(!showSegments)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans flex items-center gap-1.5 transition-all cursor-pointer ${
                showSegments ? 'bg-cyan-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Toggle ChanLun Segments"
              id="toggle-segments"
            >
              <span>Segment (线段)</span>
            </button>

            <button
              onClick={() => setShowHubs(!showHubs)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans flex items-center gap-1.5 transition-all cursor-pointer ${
                showHubs ? 'bg-indigo-650 text-white shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Toggle Overlapping Hubs"
              id="toggle-hubs"
            >
              <span>Hub (中枢)</span>
            </button>

            <button
              onClick={() => setShowSignals(!showSignals)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans flex items-center gap-1.5 transition-all cursor-pointer ${
                showSignals ? 'bg-emerald-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Toggle Buy/Sell Points"
              id="toggle-signals"
            >
              <span>Signals (买卖)</span>
            </button>
          </div>

          {/* Technical Indicators Multi-Selector */}
          <div className="flex flex-wrap items-center gap-1.5 bg-zinc-950 p-1.5 rounded-xl border border-zinc-855">
            <span className="text-[9px] font-mono font-semibold text-zinc-500 uppercase tracking-widest px-1.5">Indicators:</span>
            
            <button
              onClick={() => setShowMA5(!showMA5)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans transition-all cursor-pointer ${
                showMA5 ? 'bg-cyan-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Show Moving Average (5-period)"
              id="toggle-ma5"
            >
              <span>MA5</span>
            </button>

            <button
              onClick={() => setShowMA20(!showMA20)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans transition-all cursor-pointer ${
                showMA20 ? 'bg-pink-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Show Moving Average (20-period)"
              id="toggle-ma20"
            >
              <span>MA20</span>
            </button>

            <button
              onClick={() => setShowBOLL(!showBOLL)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans transition-all cursor-pointer ${
                showBOLL ? 'bg-purple-650 text-white shadow border border-purple-500' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Show Bollinger Bands (20, 2)"
              id="toggle-boll"
            >
              <span>BOLL</span>
            </button>

            <button
              onClick={() => setShowMACD(!showMACD)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans transition-all cursor-pointer ${
                showMACD ? 'bg-amber-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Activate MACD (12, 26, 9) tracks"
              id="toggle-macd"
            >
              <span>MACD</span>
            </button>
          </div>

        </div>
      </div>

      {/* Floating Price Data Header panels */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 bg-zinc-950 p-3 rounded-xl border border-zinc-800">
        <div>
          <span className="text-[10px] font-mono text-zinc-500 uppercase">Interactive Date</span>
          <p className="text-xs font-bold font-mono tracking-wide text-zinc-300 mt-0.5">
            {activeHoveredCandle ? activeHoveredCandle.date : klines[klines.length - 1].date}
          </p>
        </div>
        <div>
          <span className="text-[10px] font-mono text-zinc-500 uppercase">Open Price</span>
          <p className="text-xs font-bold font-mono tracking-wide text-zinc-200 mt-0.5">
            {activeHoveredCandle ? activeHoveredCandle.open.toFixed(2) : klines[klines.length - 1].open.toFixed(2)}
          </p>
        </div>
        <div>
          <span className="text-[10px] font-mono text-zinc-500 uppercase">Close Price</span>
          <p className="text-xs font-bold font-mono tracking-wide mt-0.5 text-emerald-400">
            {activeHoveredCandle ? activeHoveredCandle.close.toFixed(2) : klines[klines.length - 1].close.toFixed(2)}
          </p>
        </div>
        <div>
          <span className="text-[10px] font-mono text-zinc-500 uppercase">High / Low Bounds</span>
          <p className="text-xs font-bold font-mono tracking-wide text-zinc-400 mt-0.5">
            {activeHoveredCandle 
              ? `${activeHoveredCandle.high.toFixed(2)} / ${activeHoveredCandle.low.toFixed(2)}` 
              : `${klines[klines.length - 1].high.toFixed(2)} / ${klines[klines.length - 1].low.toFixed(2)}`}
          </p>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <span className="text-[10px] font-mono text-zinc-500 uppercase">Volume</span>
          <p className="text-xs font-bold font-mono tracking-wide text-amber-400 mt-0.5">
            {activeHoveredCandle 
              ? (activeHoveredCandle.volume / 1000).toFixed(1) + 'K' 
              : (klines[klines.length - 1].volume / 1000).toFixed(1) + 'K'}
          </p>
        </div>
      </div>

      {/* SVG Canvas Board */}
      <div 
        ref={containerRef} 
        className="w-full h-96 sm:h-[480px] bg-zinc-950/80 rounded-xl border border-zinc-800 relative overflow-hidden select-none cursor-crosshair"
      >
        <svg 
          width="100%" 
          height="100%" 
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className="w-full h-full"
        >
          {/* 1. Horizontal Grid lines */}
          {yTicks.map((p, i) => (
            <g key={`y-grid-${i}`}>
              <line
                x1={padding.left}
                y1={yScale(p)}
                x2={dimensions.width - padding.right}
                y2={yScale(p)}
                stroke="#1e293b"
                strokeWidth={1}
                strokeDasharray="2 3"
              />
              <text
                x={dimensions.width - padding.right + 8}
                y={yScale(p) + 4}
                className="fill-slate-500 font-mono text-[9px] text-right font-medium"
              >
                {p.toFixed(1)}
              </text>
            </g>
          ))}

          {/* 2. Vertical Grid lines */}
          {xTicks.map((idx, i) => {
            if (idx < 0 || idx >= klines.length) return null;
            const clin = klines[idx];
            return (
              <g key={`x-grid-${i}`}>
                <line
                  x1={xScale(idx)}
                  y1={padding.top}
                  x2={xScale(idx)}
                  y2={dimensions.height - padding.bottom}
                  stroke="#1e293b"
                  strokeWidth={1}
                  strokeDasharray="2 3"
                />
                <text
                  x={xScale(idx)}
                  y={dimensions.height - padding.bottom + 14}
                  textAnchor="middle"
                  className="fill-slate-500 font-mono text-[9px] font-medium"
                >
                  {clin.date.substring(5)}  {/* Only display MM-DD */}
                </text>
              </g>
            );
          })}

          {/* Bollinger Bands Shaded Area & Lines */}
          {showBOLL && Array.from({ length: activeEndIdx - activeStartIdx }).map((_, i) => {
            const curIdx = activeStartIdx + i + 1;
            const u1 = bollValues.upper[curIdx - 1];
            const u2 = bollValues.upper[curIdx];
            const l1 = bollValues.lower[curIdx - 1];
            const l2 = bollValues.lower[curIdx];
            const m1 = bollValues.middle[curIdx - 1];
            const m2 = bollValues.middle[curIdx];
            
            if (u1 === null || u2 === null || l1 === null || l2 === null || m1 === null || m2 === null) return null;
            
            return (
              <g key={`boll-lines-${curIdx}`}>
                <polygon
                  points={`${xScale(curIdx - 1)},${yScale(u1)} ${xScale(curIdx)},${yScale(u2)} ${xScale(curIdx)},${yScale(l2)} ${xScale(curIdx - 1)},${yScale(l1)}`}
                  fill="rgba(139, 92, 246, 0.04)"
                />
                <line
                  x1={xScale(curIdx - 1)}
                  y1={yScale(u1)}
                  x2={xScale(curIdx)}
                  y2={yScale(u2)}
                  stroke="rgba(167, 139, 250, 0.4)"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
                <line
                  x1={xScale(curIdx - 1)}
                  y1={yScale(m1)}
                  x2={xScale(curIdx)}
                  y2={yScale(m2)}
                  stroke="rgba(139, 92, 246, 0.4)"
                  strokeWidth={1.2}
                />
                <line
                  x1={xScale(curIdx - 1)}
                  y1={yScale(l1)}
                  x2={xScale(curIdx)}
                  y2={yScale(l2)}
                  stroke="rgba(167, 139, 250, 0.4)"
                  strokeWidth={1}
                  strokeDasharray="2 2"
                />
              </g>
            );
          })}

          {/* 3. ChanLun Price Hubs (渲染中枢) */}
          {showHubs && hubs.map((hub, idx) => {
            // Check if bounds of index fall inside currently visible viewport
            const inViewport = (hub.startIndex <= activeEndIdx && hub.endIndex >= activeStartIdx);
            if (!inViewport) return null;

            const rx1 = xScale(Math.max(activeStartIdx, hub.startIndex));
            const rx2 = xScale(Math.min(activeEndIdx, hub.endIndex));
            const ry1 = yScale(hub.high);
            const ry2 = yScale(hub.low);

            return (
              <g key={`hub-render-${idx}`}>
                {/* Visual purple overlapping rect */}
                <rect
                  x={rx1}
                  y={ry1}
                  width={Math.max(2, rx2 - rx1)}
                  height={Math.max(2, ry2 - ry1)}
                  fill="rgba(99, 102, 241, 0.08)"
                  stroke="rgba(99, 102, 241, 0.65)"
                  strokeWidth={1.5}
                  strokeDasharray="3 2"
                />
                {/* Soft glow/text for hub identification */}
                <text
                  x={rx1 + 4}
                  y={ry1 + 12}
                  className="fill-indigo-400 font-mono text-[8px] font-bold"
                >
                  Hub {idx + 1} ({hub.strokesCount}s)
                </text>
              </g>
            );
          })}

          {/* 4. Candlesticks K-lines (K线实体 & 影线) */}
          {showCandles && klines.map((candle, idx) => {
            if (idx < activeStartIdx || idx > activeEndIdx) return null;

            const cx = xScale(idx);
            const cyHigh = yScale(candle.high);
            const cyLow = yScale(candle.low);
            const cyOpen = yScale(candle.open);
            const cyClose = yScale(candle.close);

            const isGreen = candle.close >= candle.open;
            const strokeColor = isGreen ? '#10b981' : '#f43f5e';
            const fillColor = isGreen ? 'rgba(16, 185, 129, 0.25)' : 'rgba(244, 63, 94, 0.85)';

            // Auto fit column width based on scale separation
            const bandWidth = Math.max(3, (graphWidth / visibleKlines.length) * 0.7);

            return (
              <g key={`kline-${idx}`} id={`kline-cand-${idx}`}>
                {/* Shadow wick */}
                <line
                  x1={cx}
                  y1={cyHigh}
                  x2={cx}
                  y2={cyLow}
                  stroke={strokeColor}
                  strokeWidth={1.5}
                />
                {/* Body block */}
                <rect
                  x={cx - bandWidth / 2}
                  y={Math.min(cyOpen, cyClose)}
                  width={bandWidth}
                  height={Math.max(1.5, Math.abs(cyClose - cyOpen))}
                  fill={fillColor}
                  stroke={strokeColor}
                  strokeWidth={1.2}
                />
              </g>
            );
          })}

          {/* Moving Averages (MA5) Line Overlay */}
          {showMA5 && Array.from({ length: activeEndIdx - activeStartIdx }).map((_, i) => {
            const curIdx = activeStartIdx + i + 1;
            const val1 = ma5Values[curIdx - 1];
            const val2 = ma5Values[curIdx];
            if (val1 === null || val2 === null) return null;
            return (
              <line
                key={`ma5-line-${curIdx}`}
                x1={xScale(curIdx - 1)}
                y1={yScale(val1)}
                x2={xScale(curIdx)}
                y2={yScale(val2)}
                stroke="#22d3ee"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            );
          })}

          {/* Moving Averages (MA20) Line Overlay */}
          {showMA20 && Array.from({ length: activeEndIdx - activeStartIdx }).map((_, i) => {
            const curIdx = activeStartIdx + i + 1;
            const val1 = ma20Values[curIdx - 1];
            const val2 = ma20Values[curIdx];
            if (val1 === null || val2 === null) return null;
            return (
              <line
                key={`ma20-line-${curIdx}`}
                x1={xScale(curIdx - 1)}
                y1={yScale(val1)}
                x2={xScale(curIdx)}
                y2={yScale(val2)}
                stroke="#ec4899"
                strokeWidth={1.5}
                strokeLinecap="round"
              />
            );
          })}

          {/* 5. ChanLun Stoke Lines (画生笔) */}
          {showStrokes && strokes.map((stroke, idx) => {
            const startVisible = stroke.start.originalIndex >= activeStartIdx && stroke.start.originalIndex <= activeEndIdx;
            const endVisible = stroke.end.originalIndex >= activeStartIdx && stroke.end.originalIndex <= activeEndIdx;
            
            if (!startVisible && !endVisible) return null;

            const sx1 = xScale(stroke.start.originalIndex);
            const sy1 = yScale(stroke.start.price);
            const sx2 = xScale(stroke.end.originalIndex);
            const sy2 = yScale(stroke.end.price);

            return (
              <g key={`stroke-line-${idx}`}>
                <line
                  x1={sx1}
                  y1={sy1}
                  x2={sx2}
                  y2={sy2}
                  stroke="#fbbf24" // Bright Amber for strokes
                  strokeWidth={1.8}
                  className="stroke-linecap-round"
                />
                {/* Circle extremes */}
                <circle
                  cx={sx1}
                  cy={sy1}
                  r={3.5}
                  fill={stroke.start.type === 'TOP' ? '#ef4444' : '#10b981'}
                  stroke="#1e293b"
                  strokeWidth={1}
                />
              </g>
            );
          })}

          {/* 6. ChanLun Segment Lines (画线段) */}
          {showSegments && segments.map((seg, idx) => {
            const startVisible = seg.start.originalIndex >= activeStartIdx && seg.start.originalIndex <= activeEndIdx;
            const endVisible = seg.end.originalIndex >= activeStartIdx && seg.end.originalIndex <= activeEndIdx;

            if (!startVisible && !endVisible) return null;

            const sx1 = xScale(seg.start.originalIndex);
            const sy1 = yScale(seg.start.price);
            const sx2 = xScale(seg.end.originalIndex);
            const sy2 = yScale(seg.end.price);

            return (
              <line
                key={`segment-line-${idx}`}
                x1={sx1}
                y1={sy1}
                x2={sx2}
                y2={sy2}
                stroke="#06b6d4" // Cyan for higher-level Segment path
                strokeWidth={3}
                strokeDasharray="1 1"
                className="stroke-linecap-round"
              />
            );
          })}

          {/* 7. Buy and Sell Setup Point Indicators (买卖点信号标签) */}
          {showSignals && buySellPoints.map((pt, idx) => {
            if (pt.originalIndex < activeStartIdx || pt.originalIndex > activeEndIdx) return null;

            const px = xScale(pt.originalIndex);
            const pyPrice = yScale(pt.price);
            
            const isBuy = pt.type.startsWith('BUY');
            const color = isBuy ? '#10b981' : '#f43f5e';
            const bgClass = isBuy ? '#064e3b' : '#881337';
            const labelText = pt.type === 'BUY_1' ? '一买' 
                            : pt.type === 'BUY_2' ? '二买' 
                            : pt.type === 'BUY_3' ? '三买'
                            : pt.type === 'SELL_1' ? '一卖'
                            : pt.type === 'SELL_2' ? '二卖'
                            : '三卖';

            // Shift buyers below wicks and sellers above wicks
            const pyShift = isBuy ? pyPrice + 20 : pyPrice - 20;

            return (
              <g key={`bs-signal-${pt.id}-${idx}`} className="cursor-pointer">
                {/* Pointer linking segment line */}
                <line
                  x1={px}
                  y1={pyPrice}
                  x2={px}
                  y2={pyShift}
                  stroke={color}
                  strokeWidth={1.2}
                  strokeDasharray="2 1"
                />
                
                {/* Bright badge button */}
                <circle
                  cx={px}
                  cy={pyShift}
                  r={8.5}
                  fill={color}
                />
                <text
                  x={px}
                  y={pyShift + 3.5}
                  textAnchor="middle"
                  className="fill-white font-sans text-[8px] font-bold"
                >
                  {labelText}
                </text>
                
                {/* Invisible hover zone for title triggers */}
                <title>{`${pt.reason}: Price $${pt.price} at ${pt.date}`}</title>
              </g>
            );
          })}

          {/* MACD Technical Indicator Track */}
          {showMACD && visibleMACD && macdScaleY && (
            <g>
              {/* Separator base border boundary line */}
              <line
                x1={padding.left}
                y1={dimensions.height - padding.bottom - macdPanelHeight}
                x2={dimensions.width - padding.right}
                y2={dimensions.height - padding.bottom - macdPanelHeight}
                stroke="#1e293b"
                strokeWidth={1}
              />
              
              {/* Zero-line baseline */}
              <line
                x1={padding.left}
                y1={macdScaleY(0)}
                x2={dimensions.width - padding.right}
                y2={macdScaleY(0)}
                stroke="rgba(71, 85, 105, 0.4)"
                strokeWidth={1}
              />

              {/* MACD Title text indicator */}
              <text
                x={padding.left + 5}
                y={dimensions.height - padding.bottom - macdPanelHeight + 14}
                className="fill-slate-500 font-mono text-[9px] font-bold"
              >
                MACD (12, 26, 9)
              </text>

              {/* Histogram Bars */}
              {klines.map((candle, idx) => {
                if (idx < activeStartIdx || idx > activeEndIdx) return null;
                const histVal = visibleMACD.histogram[idx];
                if (histVal === null || histVal === undefined) return null;
                
                const cx = xScale(idx);
                const cyZero = macdScaleY(0);
                const cyVal = macdScaleY(histVal);
                
                const isGreen = histVal >= 0;
                const barColor = isGreen ? 'rgba(16, 185, 129, 0.28)' : 'rgba(244, 63, 94, 0.28)';
                const barStroke = isGreen ? '#10b981' : '#f43f5e';
                const bandWidth = Math.max(1.8, (graphWidth / visibleKlines.length) * 0.5);
                
                return (
                  <rect
                    key={`macd-hist-${idx}`}
                    x={cx - bandWidth / 2}
                    y={Math.min(cyZero, cyVal)}
                    width={bandWidth}
                    height={Math.max(1, Math.abs(cyZero - cyVal))}
                    fill={barColor}
                    stroke={barStroke}
                    strokeWidth={0.7}
                  />
                );
              })}

              {/* DIF Line (color: Sky Blue) */}
              {Array.from({ length: activeEndIdx - activeStartIdx }).map((_, i) => {
                const curIdx = activeStartIdx + i + 1;
                const val1 = visibleMACD.dif[curIdx - 1];
                const val2 = visibleMACD.dif[curIdx];
                if (val1 === null || val2 === null) return null;
                return (
                  <line
                    key={`dif-line-${curIdx}`}
                    x1={xScale(curIdx - 1)}
                    y1={macdScaleY(val1)}
                    x2={xScale(curIdx)}
                    y2={macdScaleY(val2)}
                    stroke="#38bdf8"
                    strokeWidth={1.2}
                    strokeLinecap="round"
                  />
                );
              })}

              {/* DEA Line (color: Amber Yellow) */}
              {Array.from({ length: activeEndIdx - activeStartIdx }).map((_, i) => {
                const curIdx = activeStartIdx + i + 1;
                const val1 = visibleMACD.dea[curIdx - 1];
                const val2 = visibleMACD.dea[curIdx];
                if (val1 === null || val2 === null) return null;
                return (
                  <line
                    key={`dea-line-${curIdx}`}
                    x1={xScale(curIdx - 1)}
                    y1={macdScaleY(val1)}
                    x2={xScale(curIdx)}
                    y2={macdScaleY(val2)}
                    stroke="#fbbf24"
                    strokeWidth={1.2}
                    strokeLinecap="round"
                  />
                );
              })}
            </g>
          )}

          {/* 8. Active Hover Tracker Crosshair */}
          {hoveredIdx !== null && (
            <g>
              {/* Vertical line tracker */}
              <line
                x1={xScale(hoveredIdx)}
                y1={padding.top}
                x2={xScale(hoveredIdx)}
                y2={dimensions.height - padding.bottom}
                stroke="#64748b"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              
              {/* Horizontal line tracker */}
              <line
                x1={padding.left}
                y1={hoverPos.y}
                x2={dimensions.width - padding.right}
                y2={hoverPos.y}
                stroke="#64748b"
                strokeWidth={0.8}
                strokeDasharray="4 4"
              />
              
              {/* Price level tag */}
              <rect
                x={dimensions.width - padding.right + 2}
                y={hoverPos.y - 8}
                width={50}
                height={16}
                rx={3}
                fill="#1e293b"
                stroke="#64748b"
              />
              <text
                x={dimensions.width - padding.right + 27}
                y={hoverPos.y + 3}
                textAnchor="middle"
                className="fill-slate-200 font-mono text-[9px] font-semibold"
              >
                {yScale.invert(hoverPos.y).toFixed(1)}
              </text>
            </g>
          )}
        </svg>

        {/* Dynamic Detail Tooltip inside canvas */}
        {activeHoveredCandle && (
          <div className="absolute top-4 left-4 bg-slate-950/95 border border-slate-800 p-3 rounded-lg text-slate-300 pointer-events-none text-[11px] font-mono shadow-xl max-w-xs space-y-1 z-35">
            <p className="font-bold border-b border-slate-800 pb-1 text-slate-100 flex items-center justify-between">
              <span>CANDLE DETAILS</span>
              <span className="text-emerald-400 font-normal">Index #{hoveredIdx}</span>
            </p>
            <p>Date: <span className="text-slate-100 font-bold ml-1">{activeHoveredCandle.date}</span></p>
            <p>Open: <span className="text-slate-100 font-bold ml-1">${activeHoveredCandle.open}</span></p>
            <p>Close: <span className="text-slate-100 font-bold ml-1">${activeHoveredCandle.close}</span></p>
            <p>High: <span className="text-indigo-400 font-bold ml-1">${activeHoveredCandle.high}</span></p>
            <p>Low: <span className="text-indigo-400 font-bold ml-1">${activeHoveredCandle.low}</span></p>
            <p>Volume: <span className="text-amber-400 font-bold ml-1">{activeHoveredCandle.volume.toLocaleString()}</span></p>
            
            {/* Show Indicators if toggled */}
            {(showMA5 || showMA20 || showBOLL || showMACD) && (
              <div className="border-t border-slate-800/80 pt-1.5 mt-1 text-[10px] space-y-0.5 text-zinc-400">
                <p className="font-semibold text-slate-200">ACTIVE INDICATORS</p>
                {showMA5 && hoveredIdx !== null && ma5Values[hoveredIdx] !== null && (
                  <p>MA5: <span className="text-cyan-400 font-medium">${ma5Values[hoveredIdx]?.toFixed(2)}</span></p>
                )}
                {showMA20 && hoveredIdx !== null && ma20Values[hoveredIdx] !== null && (
                  <p>MA20: <span className="text-pink-400 font-medium">${ma20Values[hoveredIdx]?.toFixed(2)}</span></p>
                )}
                {showBOLL && hoveredIdx !== null && bollValues.middle[hoveredIdx] !== null && (
                  <p>BOLL: <span className="text-purple-400 font-medium font-sans">U: {bollValues.upper[hoveredIdx]?.toFixed(1)} / M: {bollValues.middle[hoveredIdx]?.toFixed(1)} / L: {bollValues.lower[hoveredIdx]?.toFixed(1)}</span></p>
                )}
                {showMACD && hoveredIdx !== null && macdValues.dif[hoveredIdx] !== null && (
                  <p>MACD: <span className="text-amber-400 font-medium">DIF: {macdValues.dif[hoveredIdx]?.toFixed(2)} / DEA: {macdValues.dea[hoveredIdx]?.toFixed(2)} / Hist: {macdValues.histogram[hoveredIdx]?.toFixed(2)}</span></p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Real-time Double-Slider Viewport Brush Selector */}
      <div className="bg-zinc-950 p-4 rounded-xl border border-zinc-800 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase text-zinc-400 flex items-center gap-1.5 font-sans">
            <ZoomIn className="h-3 w-3 text-emerald-400" />
            <span>Brush Horizon Filter</span>
          </span>
          <span className="text-xs font-mono text-zinc-500">
            Visible Range: #{activeStartIdx} to #{activeEndIdx} ({visibleKlines.length} candles shown)
          </span>
        </div>
        
        {/* Double ranges inputs */}
        <div className="flex gap-4 items-center mt-1">
          <input
            type="range"
            min="0"
            max={Math.min(95, zoomRange[1] - 5)}
            value={zoomRange[0]}
            onChange={(e) => setZoomRange([parseInt(e.target.value), zoomRange[1]])}
            className="w-full accent-emerald-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
            title="Start Window"
          />
          <input
            type="range"
            min={zoomRange[0] + 5}
            max="100"
            value={zoomRange[1]}
            onChange={(e) => setZoomRange([zoomRange[0], parseInt(e.target.value)])}
            className="w-full accent-emerald-500 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer"
            title="End Window"
          />
        </div>
      </div>

    </div>
  );
}
