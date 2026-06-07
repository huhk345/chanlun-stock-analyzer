import { useState, useRef, useEffect, useMemo } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, LineSeries, HistogramSeries, IChartApi, ISeriesApi, ISeriesMarkersPluginApi, CandlestickData, LineData, HistogramData, Time, ColorType, CrosshairMode } from 'lightweight-charts';
import { AlertCircle } from 'lucide-react';
import { Kline, Stroke, Segment, Hub } from '../types/stock';
import { calculateSMA, calculateBollingerBands, calculateMACD } from '../utils/indicators';

interface ChanlunChartProps {
  klines: Kline[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
  symbol: string;
}

function dateToTime(dateStr: string): Time {
  return dateStr as Time;
}

export default function ChanlunChart({ klines, strokes, segments, hubs, symbol }: ChanlunChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ma5SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ma20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollMiddleRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bollLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdHistRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const macdDifRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdDeaRef = useRef<ISeriesApi<'Line'> | null>(null);
  const strokeSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const segmentSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // Display triggers
  const [showCandles, setShowCandles] = useState(true);
  const [showStrokes, setShowStrokes] = useState(true);
  const [showSegments, setShowSegments] = useState(true);
  const [showHubs, setShowHubs] = useState(true);

  // Display triggers for indicators
  const [showMA5, setShowMA5] = useState(false);
  const [showMA20, setShowMA20] = useState(false);
  const [showBOLL, setShowBOLL] = useState(false);
  const [showMACD, setShowMACD] = useState(false);

  // Hover state
  const [hoveredData, setHoveredData] = useState<{
    date: string; open: number; high: number; low: number; close: number; volume: number;
    ma5?: number; ma20?: number; bollUpper?: number; bollMiddle?: number; bollLower?: number;
    macdDif?: number; macdDea?: number; macdHist?: number;
  } | null>(null);

  // Compute indicators
  const ma5Values = useMemo(() => calculateSMA(klines, 5), [klines]);
  const ma20Values = useMemo(() => calculateSMA(klines, 20), [klines]);
  const bollValues = useMemo(() => calculateBollingerBands(klines, 20, 2), [klines]);
  const macdValues = useMemo(() => calculateMACD(klines, 12, 26, 9), [klines]);

  // Prepare candle data for lightweight-charts
  const candleData = useMemo<CandlestickData<Time>[]>(() => {
    return klines.map(k => ({
      time: dateToTime(k.date),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
  }, [klines]);

  const volumeData = useMemo<HistogramData<Time>[]>(() => {
    return klines.map(k => ({
      time: dateToTime(k.date),
      value: k.volume,
      color: k.close >= k.open ? 'rgba(16, 185, 129, 0.25)' : 'rgba(244, 63, 94, 0.25)',
    }));
  }, [klines]);

  // Create chart instance
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#09090b' },
        textColor: '#64748b',
        fontSize: 10,
        fontFamily: 'ui-monospace, monospace',
      },
      grid: {
        vertLines: { color: '#1e293b', style: 2 },
        horzLines: { color: '#1e293b', style: 2 },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#64748b', width: 1, style: 2, labelBackgroundColor: '#1e293b' },
        horzLine: { color: '#64748b', width: 1, style: 2, labelBackgroundColor: '#1e293b' },
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        scaleMargins: { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: false,
        rightOffset: 5,
        barSpacing: 8,
        minBarSpacing: 2,
      },
      handleScale: { axisPressedMouseMove: true },
      handleScroll: { vertTouchDrag: false },
    });

    chartRef.current = chart;

    // Candlestick series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderUpColor: '#10b981',
      borderDownColor: '#f43f5e',
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
    });
    candleSeriesRef.current = candleSeries;

    // Volume series
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
    });
    volumeSeriesRef.current = volumeSeries;

    // MA5 line
    const ma5Series = chart.addSeries(LineSeries, {
      color: '#22d3ee',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    ma5SeriesRef.current = ma5Series;

    // MA20 line
    const ma20Series = chart.addSeries(LineSeries, {
      color: '#ec4899',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    ma20SeriesRef.current = ma20Series;

    // Bollinger Bands
    const bollUpper = chart.addSeries(LineSeries, {
      color: 'rgba(167, 139, 250, 0.4)',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    bollUpperRef.current = bollUpper;

    const bollMiddle = chart.addSeries(LineSeries, {
      color: 'rgba(139, 92, 246, 0.4)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    bollMiddleRef.current = bollMiddle;

    const bollLower = chart.addSeries(LineSeries, {
      color: 'rgba(167, 139, 250, 0.4)',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    bollLowerRef.current = bollLower;

    // MACD histogram
    const macdHist = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'price', precision: 2 },
      priceScaleId: 'macd',
    });
    macdHist.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    macdHistRef.current = macdHist;

    // MACD DIF line
    const macdDif = chart.addSeries(LineSeries, {
      color: '#38bdf8',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceScaleId: 'macd',
    });
    macdDifRef.current = macdDif;

    // MACD DEA line
    const macdDea = chart.addSeries(LineSeries, {
      color: '#fbbf24',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceScaleId: 'macd',
    });
    macdDeaRef.current = macdDea;

    // Stroke line series
    const strokeSeries = chart.addSeries(LineSeries, {
      color: '#fbbf24',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    strokeSeriesRef.current = strokeSeries;

    // Segment line series
    const segmentSeries = chart.addSeries(LineSeries, {
      color: '#06b6d4',
      lineWidth: 3,
      lineStyle: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    segmentSeriesRef.current = segmentSeries;

    // Markers plugin for buy/sell signals
    const markersPlugin = createSeriesMarkers(candleSeries, []);
    markersPluginRef.current = markersPlugin;

    // Crosshair move handler
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        setHoveredData(null);
        return;
      }
      const data = param.seriesData.get(candleSeries) as CandlestickData<Time> | undefined;
      if (!data) {
        setHoveredData(null);
        return;
      }
      const idx = klines.findIndex(k => k.date === String(param.time));
      const kline = idx >= 0 ? klines[idx] : null;
      if (!kline) {
        setHoveredData(null);
        return;
      }
      setHoveredData({
        date: kline.date,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
        volume: kline.volume,
        ma5: idx >= 0 && ma5Values[idx] !== null ? ma5Values[idx]! : undefined,
        ma20: idx >= 0 && ma20Values[idx] !== null ? ma20Values[idx]! : undefined,
        bollUpper: idx >= 0 && bollValues.upper[idx] !== null ? bollValues.upper[idx]! : undefined,
        bollMiddle: idx >= 0 && bollValues.middle[idx] !== null ? bollValues.middle[idx]! : undefined,
        bollLower: idx >= 0 && bollValues.lower[idx] !== null ? bollValues.lower[idx]! : undefined,
        macdDif: idx >= 0 && macdValues.dif[idx] !== null ? macdValues.dif[idx]! : undefined,
        macdDea: idx >= 0 && macdValues.dea[idx] !== null ? macdValues.dea[idx]! : undefined,
        macdHist: idx >= 0 && macdValues.histogram[idx] !== null ? macdValues.histogram[idx]! : undefined,
      });
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(entries => {
      if (!entries || entries.length === 0) return;
      const { width, height } = entries[0].contentRect;
      chart.applyOptions({ width: Math.max(width, 320), height: Math.max(height, 420) });
    });
    resizeObserver.observe(chartContainerRef.current);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []); // Only create chart once

  // Update data when klines change
  useEffect(() => {
    if (!candleSeriesRef.current || klines.length === 0) return;

    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current?.setData(volumeData);

    // Default: show last 80 candles
    if (klines.length > 80) {
      chartRef.current?.timeScale().setVisibleRange({
        from: dateToTime(klines[Math.max(0, klines.length - 80)].date),
        to: dateToTime(klines[klines.length - 1].date),
      });
    }
  }, [candleData, volumeData, klines]);

  // Update MA indicators
  useEffect(() => {
    if (!ma5SeriesRef.current || klines.length === 0) return;
    const ma5Data: LineData<Time>[] = [];
    const ma20Data: LineData<Time>[] = [];
    klines.forEach((k, i) => {
      if (ma5Values[i] !== null) ma5Data.push({ time: dateToTime(k.date), value: ma5Values[i]! });
      if (ma20Values[i] !== null) ma20Data.push({ time: dateToTime(k.date), value: ma20Values[i]! });
    });
    ma5SeriesRef.current?.setData(ma5Data);
    ma20SeriesRef.current?.setData(ma20Data);
  }, [klines, ma5Values, ma20Values]);

  // Update Bollinger Bands
  useEffect(() => {
    if (!bollUpperRef.current || klines.length === 0) return;
    const upperData: LineData<Time>[] = [];
    const middleData: LineData<Time>[] = [];
    const lowerData: LineData<Time>[] = [];
    klines.forEach((k, i) => {
      if (bollValues.upper[i] !== null) upperData.push({ time: dateToTime(k.date), value: bollValues.upper[i]! });
      if (bollValues.middle[i] !== null) middleData.push({ time: dateToTime(k.date), value: bollValues.middle[i]! });
      if (bollValues.lower[i] !== null) lowerData.push({ time: dateToTime(k.date), value: bollValues.lower[i]! });
    });
    bollUpperRef.current?.setData(upperData);
    bollMiddleRef.current?.setData(middleData);
    bollLowerRef.current?.setData(lowerData);
  }, [klines, bollValues]);

  // Update MACD
  useEffect(() => {
    if (!macdHistRef.current || klines.length === 0) return;
    const histData: HistogramData<Time>[] = [];
    const difData: LineData<Time>[] = [];
    const deaData: LineData<Time>[] = [];
    klines.forEach((k, i) => {
      if (macdValues.histogram[i] !== null) {
        const val = macdValues.histogram[i]!;
        histData.push({
          time: dateToTime(k.date),
          value: val,
          color: val >= 0 ? 'rgba(16, 185, 129, 0.28)' : 'rgba(244, 63, 94, 0.28)',
        });
      }
      if (macdValues.dif[i] !== null) difData.push({ time: dateToTime(k.date), value: macdValues.dif[i]! });
      if (macdValues.dea[i] !== null) deaData.push({ time: dateToTime(k.date), value: macdValues.dea[i]! });
    });
    macdHistRef.current?.setData(histData);
    macdDifRef.current?.setData(difData);
    macdDeaRef.current?.setData(deaData);
  }, [klines, macdValues]);

  // Update strokes - avoid duplicate times (end of one stroke = start of next)
  useEffect(() => {
    if (!strokeSeriesRef.current || klines.length === 0) return;
    if (strokes.length === 0) {
      strokeSeriesRef.current?.setData([]);
      return;
    }
    const strokeData: LineData<Time>[] = [];
    // Push all start points (they are unique), then the final end point
    strokes.forEach((stroke) => {
      strokeData.push({ time: dateToTime(stroke.start.date), value: stroke.start.price });
    });
    // Add the end of the last stroke
    const lastStroke = strokes[strokes.length - 1];
    strokeData.push({ time: dateToTime(lastStroke.end.date), value: lastStroke.end.price });
    strokeSeriesRef.current?.setData(strokeData);
  }, [strokes, klines]);

  // Update segments - avoid duplicate times
  useEffect(() => {
    if (!segmentSeriesRef.current || klines.length === 0) return;
    if (segments.length === 0) {
      segmentSeriesRef.current?.setData([]);
      return;
    }
    const segData: LineData<Time>[] = [];
    segments.forEach(seg => {
      segData.push({ time: dateToTime(seg.start.date), value: seg.start.price });
    });
    const lastSeg = segments[segments.length - 1];
    segData.push({ time: dateToTime(lastSeg.end.date), value: lastSeg.end.price });
    segmentSeriesRef.current?.setData(segData);
  }, [segments, klines]);

  // Toggle visibility
  useEffect(() => {
    if (candleSeriesRef.current) {
      candleSeriesRef.current.applyOptions({ visible: showCandles });
    }
  }, [showCandles]);

  useEffect(() => {
    if (strokeSeriesRef.current) {
      strokeSeriesRef.current.applyOptions({ visible: showStrokes });
    }
  }, [showStrokes]);

  useEffect(() => {
    if (segmentSeriesRef.current) {
      segmentSeriesRef.current.applyOptions({ visible: showSegments });
    }
  }, [showSegments]);

  useEffect(() => {
    if (ma5SeriesRef.current) {
      ma5SeriesRef.current.applyOptions({ visible: showMA5 });
    }
  }, [showMA5]);

  useEffect(() => {
    if (ma20SeriesRef.current) {
      ma20SeriesRef.current.applyOptions({ visible: showMA20 });
    }
  }, [showMA20]);

  useEffect(() => {
    [bollUpperRef, bollMiddleRef, bollLowerRef].forEach(ref => {
      if (ref.current) ref.current.applyOptions({ visible: showBOLL });
    });
  }, [showBOLL]);

  useEffect(() => {
    [macdHistRef, macdDifRef, macdDeaRef].forEach(ref => {
      if (ref.current) ref.current.applyOptions({ visible: showMACD });
    });
    if (candleSeriesRef.current) {
      candleSeriesRef.current.priceScale().applyOptions({
        scaleMargins: showMACD ? { top: 0.1, bottom: 0.25 } : { top: 0.1, bottom: 0.2 },
      });
    }
  }, [showMACD]);

  // Draw hubs with semi-transparent rectangles using Canvas API
  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || klines.length === 0) return;

    if (!showHubs || hubs.length === 0) {
      // Clear canvas if hubs are hidden
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }
      return;
    }

    // Create or get canvas
    let canvas = canvasRef.current;
    if (!canvas && chartContainerRef.current) {
      canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.top = '0';
      canvas.style.left = '0';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = '10'; // Increase z-index to be above the chart
      chartContainerRef.current.appendChild(canvas);
      canvasRef.current = canvas;
    }

    if (!canvas) return;

    // Set canvas size (exclude price scale width)
    const container = chartContainerRef.current;
    if (container) {
      const priceScaleWidth = chartRef.current!.priceScale('right').width();
      canvas.width = container.clientWidth - priceScaleWidth;
      canvas.height = container.clientHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw each hub
    hubs.forEach(hub => {
      const startK = klines[hub.startIndex];
      const endK = klines[Math.min(hub.endIndex, klines.length - 1)];
      if (!startK || !endK) return;

      // Convert time to x coordinate
      const x1 = chartRef.current!.timeScale().timeToCoordinate(startK.date as Time);
      const x2 = chartRef.current!.timeScale().timeToCoordinate(endK.date as Time);

      // Convert price to y coordinate
      const y1 = candleSeriesRef.current!.priceToCoordinate(hub.zg);
      const y2 = candleSeriesRef.current!.priceToCoordinate(hub.zd);

      if (x1 === null || x2 === null || y1 === null || y2 === null) return;

      // Draw filled rectangle with semi-transparent color
      ctx.fillStyle = 'rgba(99, 102, 241, 0.15)';
      ctx.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));

      // Draw border
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));

      // Draw middle line
      const midY = (y1 + y2) / 2;
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(x1, midY);
      ctx.lineTo(x2, midY);
      ctx.stroke();
      ctx.setLineDash([]);
    });

    // Redraw on chart changes
    const redrawHubs = () => {
      if (!chartRef.current || !candleSeriesRef.current || !ctx || !canvas) return;

      // Update canvas size to match container (exclude price scale width)
      const container = chartContainerRef.current;
      if (container) {
        const priceScaleWidth = chartRef.current!.priceScale('right').width();
        canvas.width = container.clientWidth - priceScaleWidth;
        canvas.height = container.clientHeight;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      hubs.forEach(hub => {
        const startK = klines[hub.startIndex];
        const endK = klines[Math.min(hub.endIndex, klines.length - 1)];
        if (!startK || !endK) return;

        const x1 = chartRef.current!.timeScale().timeToCoordinate(startK.date as Time);
        const x2 = chartRef.current!.timeScale().timeToCoordinate(endK.date as Time);
        const y1 = candleSeriesRef.current!.priceToCoordinate(hub.zg);
        const y2 = candleSeriesRef.current!.priceToCoordinate(hub.zd);

        if (x1 === null || x2 === null || y1 === null || y2 === null) return;

        ctx.fillStyle = 'rgba(99, 102, 241, 0.15)';
        ctx.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));

        ctx.strokeStyle = 'rgba(99, 102, 241, 0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));

        const midY = (y1 + y2) / 2;
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(x1, midY);
        ctx.lineTo(x2, midY);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    };

    // Delayed redraw to ensure chart layout is fully updated
    const delayedRedrawHubs = () => {
      setTimeout(redrawHubs, 0);
    };

    // Subscribe to chart changes
    chartRef.current.timeScale().subscribeVisibleLogicalRangeChange(redrawHubs);
    chartRef.current.timeScale().subscribeVisibleTimeRangeChange(redrawHubs);

    // Subscribe to container size changes
    const resizeObserver = new ResizeObserver(() => {
      delayedRedrawHubs();
    });
    if (container) {
      resizeObserver.observe(container);
    }

    // Initial delayed redraw to ensure chart is fully rendered
    delayedRedrawHubs();

    return () => {
      if (chartRef.current) {
        chartRef.current.timeScale().unsubscribeVisibleLogicalRangeChange(redrawHubs);
        chartRef.current.timeScale().unsubscribeVisibleTimeRangeChange(redrawHubs);
      }
      resizeObserver.disconnect();
    };
  }, [hubs, klines, showHubs, showMACD]);

  if (klines.length === 0) {
    return (
      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-8 h-96 flex flex-col items-center justify-center text-center">
        <AlertCircle className="h-10 w-10 text-gray-300 mb-2 animate-bounce" />
        <h4 className="text-zinc-500 font-medium font-sans">无市场数据</h4>
        <p className="text-xs text-zinc-400 mt-1">请在上方搜索框输入有效的股票代码。</p>
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 text-zinc-100 shadow-xl flex flex-col gap-4">

      {/* Top Header Controls bar */}
      <div className="flex flex-col xl:flex-row items-stretch xl:items-center justify-between gap-4">
        <div>
          <span className="text-[10px] font-mono tracking-widest text-emerald-400 bg-emerald-950/40 border border-emerald-900/50 px-2 py-0.5 rounded uppercase">缠论引擎</span>
          <h3 className="text-lg font-bold font-sans tracking-tight mt-1 flex items-center gap-2">
            <span>{symbol}</span>
            <span className="text-xs text-zinc-400 font-normal">K线结构与缠论分析</span>
          </h3>
        </div>

        {/* Visibility Toggles */}
        <div className="flex flex-wrap items-center gap-4">

          {/* Zen Structure Controls */}
          <div className="flex flex-wrap items-center gap-1.5 bg-zinc-950 p-1.5 rounded-xl border border-zinc-850">
            <span className="text-[9px] font-mono font-semibold text-zinc-500 uppercase tracking-widest px-1.5">Zen:</span>
            <button
              onClick={() => setShowCandles(!showCandles)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans flex items-center gap-1.5 transition-all cursor-pointer ${
                showCandles ? 'bg-zinc-800 text-zinc-100 shadow border border-zinc-700' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="切换原始K线"
              id="toggle-candles"
            >
              <span>K线</span>
            </button>

            <button
              onClick={() => setShowStrokes(!showStrokes)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans flex items-center gap-1.5 transition-all cursor-pointer ${
                showStrokes ? 'bg-amber-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="切换缠论笔"
              id="toggle-strokes"
            >
              <span>笔</span>
            </button>

            <button
              onClick={() => setShowSegments(!showSegments)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans flex items-center gap-1.5 transition-all cursor-pointer ${
                showSegments ? 'bg-cyan-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="切换缠论线段"
              id="toggle-segments"
            >
              <span>线段</span>
            </button>

            <button
              onClick={() => setShowHubs(!showHubs)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans flex items-center gap-1.5 transition-all cursor-pointer ${
                showHubs ? 'bg-indigo-650 text-white shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="切换中枢"
              id="toggle-hubs"
            >
              <span>中枢</span>
            </button>
          </div>

          {/* Technical Indicators */}
          <div className="flex flex-wrap items-center gap-1.5 bg-zinc-950 p-1.5 rounded-xl border border-zinc-855">
            <span className="text-[9px] font-mono font-semibold text-zinc-500 uppercase tracking-widest px-1.5">Indicators:</span>

            <button
              onClick={() => setShowMA5(!showMA5)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans transition-all cursor-pointer ${
                showMA5 ? 'bg-cyan-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="显示5周期移动平均线"
              id="toggle-ma5"
            >
              <span>MA5</span>
            </button>

            <button
              onClick={() => setShowMA20(!showMA20)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans transition-all cursor-pointer ${
                showMA20 ? 'bg-pink-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="显示20周期移动平均线"
              id="toggle-ma20"
            >
              <span>MA20</span>
            </button>

            <button
              onClick={() => setShowBOLL(!showBOLL)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans transition-all cursor-pointer ${
                showBOLL ? 'bg-purple-650 text-white shadow border border-purple-500' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="显示布林带(20, 2)"
              id="toggle-boll"
            >
              <span>BOLL</span>
            </button>

            <button
              onClick={() => setShowMACD(!showMACD)}
              className={`px-2 py-1.5 rounded-lg text-xs font-medium font-sans transition-all cursor-pointer ${
                showMACD ? 'bg-amber-500 text-zinc-950 font-bold shadow' : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="激活MACD(12, 26, 9)指标"
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
          <span className="text-[10px] font-mono text-zinc-500 uppercase">交互日期</span>
          <div className="flex items-center gap-2 mt-0.5">
            <p className="text-xs font-bold font-mono tracking-wide text-zinc-300">
              {hoveredData ? hoveredData.date : klines[klines.length - 1].date}
            </p>
            {(() => {
              const data = hoveredData ?? klines[klines.length - 1];
              if (!data) return null;
              const change = data.close - data.open;
              const pct = (change / data.open) * 100;
              const isUp = pct >= 0;
              return (
                <span className={`text-[10px] font-mono font-bold tracking-wide px-1.5 py-0.5 rounded ${
                  isUp ? 'text-emerald-400 bg-emerald-500/10' : 'text-red-400 bg-red-500/10'
                }`}>
                  {isUp ? '+' : ''}{pct.toFixed(2)}%
                </span>
              );
            })()}
          </div>
        </div>
        <div>
          <span className="text-[10px] font-mono text-zinc-500 uppercase">开盘价</span>
          <p className="text-xs font-bold font-mono tracking-wide text-zinc-200 mt-0.5">
            {hoveredData ? hoveredData.open.toFixed(2) : klines[klines.length - 1].open.toFixed(2)}
          </p>
        </div>
        <div>
          <span className="text-[10px] font-mono text-zinc-500 uppercase">收盘价</span>
          <p className="text-xs font-bold font-mono tracking-wide mt-0.5 text-emerald-400">
            {hoveredData ? hoveredData.close.toFixed(2) : klines[klines.length - 1].close.toFixed(2)}
          </p>
        </div>
        <div>
          <span className="text-[10px] font-mono text-zinc-500 uppercase">最高/最低价</span>
          <p className="text-xs font-bold font-mono tracking-wide text-zinc-400 mt-0.5">
            {hoveredData
              ? `${hoveredData.high.toFixed(2)} / ${hoveredData.low.toFixed(2)}`
              : `${klines[klines.length - 1].high.toFixed(2)} / ${klines[klines.length - 1].low.toFixed(2)}`}
          </p>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <span className="text-[10px] font-mono text-zinc-500 uppercase">成交量</span>
          <p className="text-xs font-bold font-mono tracking-wide text-amber-400 mt-0.5">
            {hoveredData
              ? (hoveredData.volume / 1000).toFixed(1) + 'K'
              : (klines[klines.length - 1].volume / 1000).toFixed(1) + 'K'}
          </p>
        </div>
      </div>

      {/* TradingView Chart Container */}
      <div
        ref={chartContainerRef}
        className="w-full h-96 sm:h-[480px] bg-zinc-950/80 rounded-xl border border-zinc-800 relative overflow-hidden select-none"
      />

      {/* Indicator details on hover */}
      {hoveredData && (showMA5 || showMA20 || showBOLL || showMACD) && (
        <div className="bg-zinc-950 p-3 rounded-xl border border-zinc-800 text-[11px] font-mono text-zinc-400 space-y-0.5">
          <p className="font-semibold text-slate-200">ACTIVE INDICATORS</p>
          {showMA5 && hoveredData.ma5 !== undefined && (
            <p>MA5: <span className="text-cyan-400 font-medium">${hoveredData.ma5.toFixed(2)}</span></p>
          )}
          {showMA20 && hoveredData.ma20 !== undefined && (
            <p>MA20: <span className="text-pink-400 font-medium">${hoveredData.ma20.toFixed(2)}</span></p>
          )}
          {showBOLL && hoveredData.bollUpper !== undefined && (
            <p>BOLL: <span className="text-purple-400 font-medium font-sans">U: {hoveredData.bollUpper.toFixed(1)} / M: {hoveredData.bollMiddle?.toFixed(1)} / L: {hoveredData.bollLower?.toFixed(1)}</span></p>
          )}
          {showMACD && hoveredData.macdDif !== undefined && (
            <p>MACD: <span className="text-amber-400 font-medium">DIF: {hoveredData.macdDif.toFixed(2)} / DEA: {hoveredData.macdDea?.toFixed(2)} / Hist: {hoveredData.macdHist?.toFixed(2)}</span></p>
          )}
        </div>
      )}
    </div>
  );
}
