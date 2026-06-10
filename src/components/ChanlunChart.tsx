import { useState, useRef, useEffect, useMemo } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, LineSeries, HistogramSeries, IChartApi, ISeriesApi, ISeriesMarkersPluginApi, CandlestickData, LineData, HistogramData, Time, ColorType, CrosshairMode } from 'lightweight-charts';
import { AlertCircle, TrendingUp, TrendingDown, Briefcase, User, ChevronRight, AlertTriangle, ExternalLink, FileText, Plus } from 'lucide-react';
import { Kline, Stroke, Segment, Hub, Fraction, StockBasicInfo } from '../types/stock';
import { calculateSMA, calculateBollingerBands, calculateMACD } from '../utils/indicators';
import { userIndicators } from '../indicators/user';
import { loadStoredIndicators } from '../utils/indicatorLoader';
import { calculateUserIndicatorSafely, createIndicatorInput } from '../utils/indicatorAdapter';
import type { UserIndicatorDefinition, NormalizedUserIndicator } from '../types/indicator';
import IndicatorDialog from './IndicatorDialog';

interface ReductionPlan {
  title: string;
  url: string;
  reduction_date: string;
  announcement_type: string;
  announcement_date: string;
}

interface ChanlunChartProps {
  klines: Kline[];
  fractions: Fraction[];
  strokes: Stroke[];
  segments: Segment[];
  hubs: Hub[];
  symbol: string;
  stockBasicInfo?: StockBasicInfo | null;
  industry?: string;
  actualController?: string;
  reductionPlans?: ReductionPlan[];
}

function dateToTime(dateStr: string): Time {
  return dateStr as Time;
}

export default function ChanlunChart({ klines, fractions, strokes, segments, hubs, symbol, stockBasicInfo, industry, actualController, reductionPlans }: ChanlunChartProps) {
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

  // User-defined indicator series refs - stores series by indicatorId-seriesId
  const userIndicatorSeriesRefs = useRef<Record<string, ISeriesApi<'Line'> | ISeriesApi<'Histogram'>>>({});

  // Display triggers
  const [showCandles, setShowCandles] = useState(true);
  const [showStrokes, setShowStrokes] = useState(true);
  const [showSegments, setShowSegments] = useState(true);
  const [showHubs, setShowHubs] = useState(true);
  const [showFractions, setShowFractions] = useState(false);

  // Display triggers for indicators
  const [showMA5, setShowMA5] = useState(false);
  const [showMA20, setShowMA20] = useState(false);
  const [showBOLL, setShowBOLL] = useState(false);
  const [showMACD, setShowMACD] = useState(false);

  // User-defined indicators
  const [allUserIndicators, setAllUserIndicators] = useState<UserIndicatorDefinition[]>([]);
  const [userIndicatorVisibility, setUserIndicatorVisibility] = useState<Record<string, boolean>>({});
  const [showIndicatorDialog, setShowIndicatorDialog] = useState(false);

  // Load user-defined indicators on mount
  useEffect(() => {
    const stored = loadStoredIndicators();
    const all = [...userIndicators, ...stored];
    setAllUserIndicators(all);
    
    // Initialize visibility state with defaults
    const visibility: Record<string, boolean> = {};
    for (const indicator of all) {
      visibility[indicator.id] = indicator.defaultVisible ?? false;
    }
    setUserIndicatorVisibility(visibility);
  }, []);

  // Hover state
  const [hoveredData, setHoveredData] = useState<{
    date: string; open: number; high: number; low: number; close: number; volume: number; amount: number;
    ma5?: number; ma20?: number; bollUpper?: number; bollMiddle?: number; bollLower?: number;
    macdDif?: number; macdDea?: number; macdHist?: number;
    userIndicators?: Record<string, Record<string, number | null>>;
  } | null>(null);

  // Compute indicators
  const ma5Values = useMemo(() => calculateSMA(klines, 5), [klines]);
  const ma20Values = useMemo(() => calculateSMA(klines, 20), [klines]);
  const bollValues = useMemo(() => calculateBollingerBands(klines, 20, 2), [klines]);
  const macdValues = useMemo(() => calculateMACD(klines, 12, 26, 9), [klines]);

  // Compute user-defined indicators
  const userIndicatorResults = useMemo(() => {
    const results: Record<string, NormalizedUserIndicator> = {};
    
    for (const indicator of allUserIndicators) {
      if (!userIndicatorVisibility[indicator.id]) continue;
      
      try {
        const input = createIndicatorInput(klines, symbol, indicator);
        const result = calculateUserIndicatorSafely(indicator, input);
        results[indicator.id] = result;
        
        // Log errors if any
        if (result.errors.length > 0) {
          console.warn(`Indicator "${indicator.id}" errors:`, result.errors);
        }
      } catch (error) {
        console.error(`Failed to calculate indicator "${indicator.id}":`, error);
      }
    }
    
    return results;
  }, [klines, symbol, allUserIndicators, userIndicatorVisibility]);

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
      color: k.close >= k.open ? 'rgba(244, 63, 94, 0.25)' : 'rgba(16, 185, 129, 0.25)',
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
      upColor: '#f43f5e',
      downColor: '#10b981',
      borderUpColor: '#f43f5e',
      borderDownColor: '#10b981',
      wickUpColor: '#f43f5e',
      wickDownColor: '#10b981',
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
      // Extract user-defined indicator values for the current date
      const userIndicatorValues: Record<string, Record<string, number | null>> = {};
      for (const [indicatorId, result] of Object.entries(userIndicatorResults)) {
        const seriesValues: Record<string, number | null> = {};
        for (const series of result.result.series) {
          const point = series.data.find(p => p.time === kline.date);
          seriesValues[series.id] = point?.value ?? null;
        }
        userIndicatorValues[indicatorId] = seriesValues;
      }

      setHoveredData({
        date: kline.date,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.close,
        volume: kline.volume,
        amount: kline.amount,
        ma5: idx >= 0 && ma5Values[idx] !== null ? ma5Values[idx]! : undefined,
        ma20: idx >= 0 && ma20Values[idx] !== null ? ma20Values[idx]! : undefined,
        bollUpper: idx >= 0 && bollValues.upper[idx] !== null ? bollValues.upper[idx]! : undefined,
        bollMiddle: idx >= 0 && bollValues.middle[idx] !== null ? bollValues.middle[idx]! : undefined,
        bollLower: idx >= 0 && bollValues.lower[idx] !== null ? bollValues.lower[idx]! : undefined,
        macdDif: idx >= 0 && macdValues.dif[idx] !== null ? macdValues.dif[idx]! : undefined,
        macdDea: idx >= 0 && macdValues.dea[idx] !== null ? macdValues.dea[idx]! : undefined,
        macdHist: idx >= 0 && macdValues.histogram[idx] !== null ? macdValues.histogram[idx]! : undefined,
        userIndicators: userIndicatorValues,
      });
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(entries => {
      if (!entries || entries.length === 0) return;
      const { width, height } = entries[0].contentRect;
      chart.applyOptions({ width: Math.max(width, 320), height: Math.max(height, 200) });
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

  // Update user-defined indicators
  useEffect(() => {
    if (!chartRef.current || klines.length === 0) return;

    // Get all currently visible indicator-series keys
    const currentKeys = new Set<string>();
    for (const [indicatorId, result] of Object.entries(userIndicatorResults)) {
      for (const series of result.result.series) {
        currentKeys.add(`${indicatorId}-${series.id}`);
      }
    }

    // Remove series that are no longer visible
    for (const [key, series] of Object.entries(userIndicatorSeriesRefs.current)) {
      if (!currentKeys.has(key)) {
        try {
          chartRef.current?.removeSeries(series);
        } catch (e) {
          // Series may already be removed
        }
        delete userIndicatorSeriesRefs.current[key];
      }
    }

    // Create or update series for each visible indicator
    for (const [indicatorId, result] of Object.entries(userIndicatorResults)) {
      for (const series of result.result.series) {
        const key = `${indicatorId}-${series.id}`;
        const priceScaleId = series.pane === 'indicator' ? `user-indicator-${indicatorId}` : undefined;

        // Prepare data
        const seriesData: (LineData<Time> | HistogramData<Time>)[] = [];
        for (const point of series.data) {
          if (point.value !== null) {
            if (series.type === 'histogram') {
              const histSeries = series as import('../types/indicator').UserIndicatorHistogramSeries;
              const color = point.color ?? 
                (point.value >= 0 
                  ? (histSeries.positiveColor ?? histSeries.color ?? 'rgba(16, 185, 129, 0.5)')
                  : (histSeries.negativeColor ?? histSeries.color ?? 'rgba(244, 63, 94, 0.5)'));
              seriesData.push({
                time: dateToTime(point.time),
                value: point.value,
                color,
              });
            } else {
              seriesData.push({
                time: dateToTime(point.time),
                value: point.value,
              });
            }
          }
        }

        // Check if series already exists
        const existingSeries = userIndicatorSeriesRefs.current[key];
        
        if (existingSeries) {
          // Update data
          existingSeries.setData(seriesData);
        } else {
          // Create new series
          let newSeries: ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
          
          if (series.type === 'line') {
            const lineSeries = series as import('../types/indicator').UserIndicatorLineSeries;
            newSeries = chartRef.current!.addSeries(LineSeries, {
              color: lineSeries.color,
              lineWidth: lineSeries.lineWidth ?? 2,
              lineStyle: lineSeries.lineStyle === 'dashed' ? 2 : lineSeries.lineStyle === 'dotted' ? 1 : 0,
              priceLineVisible: false,
              lastValueVisible: false,
              crosshairMarkerVisible: false,
              priceScaleId: priceScaleId,
            });
          } else {
            const histSeries = series as import('../types/indicator').UserIndicatorHistogramSeries;
            newSeries = chartRef.current!.addSeries(HistogramSeries, {
              priceFormat: { type: 'price', precision: 2 },
              priceScaleId: priceScaleId ?? '',
              color: histSeries.color ?? 'rgba(100, 149, 237, 0.5)',
            });
          }

          // Configure price scale for indicator pane
          if (priceScaleId && series.pane === 'indicator') {
            newSeries.priceScale().applyOptions({
              scaleMargins: { top: 0.8, bottom: 0 },
            });
          }

          userIndicatorSeriesRefs.current[key] = newSeries;
          newSeries.setData(seriesData);
        }
      }
    }
  }, [klines, userIndicatorResults]);

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

  // Update fraction markers on candlestick series
  useEffect(() => {
    if (!markersPluginRef.current || klines.length === 0) return;

    if (!showFractions) {
      markersPluginRef.current.setMarkers([]);
      return;
    }

    const markers = fractions.map(fraction => ({
      time: dateToTime(fraction.date),
      position: fraction.type === 'TOP' ? 'aboveBar' as const : 'belowBar' as const,
      color: fraction.type === 'TOP' ? '#ef4444' : '#3b82f6',
      shape: fraction.type === 'TOP' ? 'arrowDown' as const : 'arrowUp' as const,
    }));

    markersPluginRef.current.setMarkers(markers);
  }, [fractions, klines, showFractions]);

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
  }, [hubs, klines, showHubs, showMACD, showCandles, showFractions, showStrokes, showSegments, showMA5, showMA20, showBOLL]);

  if (klines.length === 0) {
    return (
      <div className="mobile-flat bg-zinc-900 md:rounded-2xl md:border md:border-zinc-8 md:p-8 h-96 flex flex-col items-center justify-center text-center">
        <AlertCircle className="h-10 w-10 text-gray-300 mb-2 animate-bounce" />
        <h4 className="text-zinc-500 font-medium font-sans">无市场数据</h4>
        <p className="text-xs text-zinc-400 mt-1">请在上方搜索框输入有效的股票代码。</p>
      </div>
    );
  }

  return (
    <div className="mobile-flat bg-zinc-900 md:rounded-2xl md:border md:border-zinc-800 md:p-3 md:shadow-xl text-zinc-100 flex flex-col gap-2 md:gap-4">

      {/* Stock Basic Info Header */}
      {stockBasicInfo && (
        <div className="mobile-flat bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950 md:rounded-xl md:border md:border-zinc-800/80 md:p-4 p-0">
          <div className="flex flex-row xl:flex-row items-start xl:items-center justify-between gap-2 md:gap-4">
            {/* Left: Stock Name & Symbol */}
            <div className="flex items-center gap-4 min-w-0">
              <div className="flex flex-col min-w-0">
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-bold text-zinc-100 truncate">{stockBasicInfo.name}</h2>
                    {reductionPlans && reductionPlans.length > 0 && (
                      <div className="group/badge relative shrink-0">
                        <span className="flex items-center justify-center h-5 w-5 rounded-full bg-orange-500/20 border border-orange-500/40 text-orange-400 cursor-help">
                          <AlertTriangle className="h-3 w-3" />
                        </span>
                        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-72 opacity-0 invisible group-hover/badge:opacity-100 group-hover/badge:visible transition-all duration-200 z-50 pointer-events-none">
                          <div className="bg-zinc-900 border border-orange-900/40 rounded-xl shadow-xl overflow-hidden">
                            <div className="px-3 py-2 border-b border-orange-900/20 bg-gradient-to-r from-orange-950/30 to-orange-950/10 flex items-center gap-2">
                              <TrendingDown className="h-3.5 w-3.5 text-orange-400" />
                              <span className="text-[10px] font-bold text-orange-300 uppercase tracking-wider">减持计划</span>
                              <span className="ml-auto text-[10px] font-semibold text-orange-400 bg-orange-500/10 px-1.5 py-0.5 rounded">{reductionPlans.length} 条</span>
                            </div>
                            <div className="divide-y divide-orange-900/20 max-h-48 overflow-y-auto">
                              {reductionPlans.map((plan, i) => (
                                <a key={i} href={plan.url} target="_blank" rel="noopener noreferrer" className="block px-3 py-2 hover:bg-orange-950/20 transition-colors group/link">
                                  <div className="flex items-start gap-2">
                                    <FileText className="h-3 w-3 text-zinc-500 mt-0.5 shrink-0 group-hover/link:text-orange-400 transition-colors" />
                                    <div className="min-w-0 flex-1">
                                      <p className="text-[11px] text-zinc-200 leading-snug line-clamp-2 group-hover/link:text-orange-300 transition-colors">{plan.title}</p>
                                      <div className="flex items-center gap-2 mt-1">
                                        <span className="text-[10px] text-zinc-500">减持日期</span>
                                        <span className="text-[10px] font-mono text-orange-400 font-semibold">{plan.reduction_date}</span>
                                      </div>
                                    </div>
                                    <ExternalLink className="h-3 w-3 text-zinc-600 shrink-0 mt-1 opacity-0 group-hover/link:opacity-100 transition-opacity" />
                                  </div>
                                </a>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <span className="text-sm font-mono text-zinc-500 bg-zinc-800/50 px-2 py-0.5 rounded self-start shrink-0">{stockBasicInfo.symbol}</span>
                </div>
              </div>
            </div>
            
            {/* Right: Price & Stats */}
            <div className="flex flex-wrap items-center gap-6">
              {/* Price */}
              <div className="flex flex-col items-end">
                <div className="flex items-center gap-2">
                  <span className={`text-2xl font-bold font-mono ${stockBasicInfo.change >= 0 ? 'text-red-500' : 'text-green-500'}`}>
                    {stockBasicInfo.price.toFixed(2)}
                  </span>
                  {stockBasicInfo.change >= 0 ? (
                    <TrendingUp className="h-5 w-5 text-red-500" />
                  ) : (
                    <TrendingDown className="h-5 w-5 text-green-500" />
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`text-sm font-mono font-semibold ${stockBasicInfo.change >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                    {stockBasicInfo.change >= 0 ? '+' : ''}{stockBasicInfo.change.toFixed(2)}
                  </span>
                  <span className={`text-sm font-mono font-semibold ${stockBasicInfo.change >= 0 ? 'text-red-400' : 'text-green-400'}`}>
                    ({stockBasicInfo.changePercent.toFixed(2)}%)
                  </span>
                </div>
              </div>
              
              {/* Divider */}
              <div className="hidden lg:block h-12 w-px bg-zinc-800" />
              
              {/* Market Cap & PE Ratio */}
              <div className="flex flex-col gap-2 text-xs">
                <div className="flex items-center gap-2">
                  <Briefcase className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="text-zinc-500">市值:</span>
                  <span className="text-zinc-200 font-mono font-semibold">
                    {stockBasicInfo.totalMarketValue ? (
                      stockBasicInfo.totalMarketValue >= 1000000000000
                        ? `${(stockBasicInfo.totalMarketValue / 1000000000000).toFixed(2)}万亿`
                        : `${(stockBasicInfo.totalMarketValue / 100000000).toFixed(2)}亿`
                    ) : '--'}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="text-zinc-500">市盈率:</span>
                  <span className="text-zinc-200 font-mono font-semibold">
                    {stockBasicInfo.peRatio ? stockBasicInfo.peRatio.toFixed(2) : '--'}
                  </span>
                </div>
              </div>
              
            </div>

            {/* Controls - Right side */}
            <div className="hidden xl:flex flex-col gap-1 ml-auto">
              <div className="flex items-center gap-1 bg-zinc-800/15 rounded-xl px-2.5 py-1.5 border border-zinc-700/20">
                <span className="text-[9px] font-bold text-zinc-500 tracking-wider mr-0.5 bg-zinc-800/60 px-1.5 py-0.5 rounded-md leading-none">缠</span>
                <button
                  onClick={() => setShowCandles(!showCandles)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    showCandles ? 'bg-zinc-700/80 text-zinc-100 shadow-sm' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title="切换原始K线"
                  id="toggle-candles"
                >
                  <span className={`w-1 h-1 rounded-full ${showCandles ? 'bg-zinc-100' : 'bg-zinc-500'}`} />
                  K线
                </button>
                <button
                  onClick={() => setShowFractions(!showFractions)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    showFractions ? 'bg-rose-500/90 text-white shadow-sm shadow-rose-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title="切换顶底分型"
                  id="toggle-fractions"
                >
                  <span className={`w-1 h-1 rounded-full ${showFractions ? 'bg-white' : 'bg-rose-400'}`} />
                  分型
                </button>
                <button
                  onClick={() => setShowStrokes(!showStrokes)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    showStrokes ? 'bg-amber-500/90 text-white shadow-sm shadow-amber-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title="切换缠论笔"
                  id="toggle-strokes"
                >
                  <span className={`w-1 h-1 rounded-full ${showStrokes ? 'bg-white' : 'bg-amber-400'}`} />
                  笔
                </button>
                <button
                  onClick={() => setShowSegments(!showSegments)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    showSegments ? 'bg-cyan-500/90 text-white shadow-sm shadow-cyan-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title="切换缠论线段"
                  id="toggle-segments"
                >
                  <span className={`w-1 h-1 rounded-full ${showSegments ? 'bg-white' : 'bg-cyan-400'}`} />
                  线段
                </button>
                <button
                  onClick={() => setShowHubs(!showHubs)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    showHubs ? 'bg-indigo-500/80 text-white shadow-sm shadow-indigo-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title="切换中枢"
                  id="toggle-hubs"
                >
                  <span className={`w-1 h-1 rounded-full ${showHubs ? 'bg-white' : 'bg-indigo-400'}`} />
                  中枢
                </button>
              </div>
              <div className="flex items-center gap-1 bg-zinc-800/15 rounded-xl px-2.5 py-1.5 border border-zinc-700/20">
                <span className="text-[9px] font-bold text-zinc-500 tracking-wider mr-0.5 bg-zinc-800/60 px-1.5 py-0.5 rounded-md leading-none">指</span>
                <button
                  onClick={() => setShowMA5(!showMA5)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    showMA5 ? 'bg-cyan-500/90 text-white shadow-sm shadow-cyan-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title="显示5周期移动平均线"
                  id="toggle-ma5"
                >
                  <span className={`w-1 h-1 rounded-full ${showMA5 ? 'bg-white' : 'bg-cyan-400'}`} />
                  MA5
                </button>
                <button
                  onClick={() => setShowMA20(!showMA20)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    showMA20 ? 'bg-pink-500/90 text-white shadow-sm shadow-pink-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title="显示20周期移动平均线"
                  id="toggle-ma20"
                >
                  <span className={`w-1 h-1 rounded-full ${showMA20 ? 'bg-white' : 'bg-pink-400'}`} />
                  MA20
                </button>
                <button
                  onClick={() => setShowBOLL(!showBOLL)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    showBOLL ? 'bg-purple-500/80 text-white shadow-sm shadow-purple-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title="显示布林带(20, 2)"
                  id="toggle-boll"
                >
                  <span className={`w-1 h-1 rounded-full ${showBOLL ? 'bg-white' : 'bg-purple-400'}`} />
                  BOLL
                </button>
                <button
                  onClick={() => setShowMACD(!showMACD)}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    showMACD ? 'bg-amber-500/90 text-white shadow-sm shadow-amber-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title="激活MACD(12, 26, 9)指标"
                  id="toggle-macd"
                >
                  <span className={`w-1 h-1 rounded-full ${showMACD ? 'bg-white' : 'bg-amber-400'}`} />
                  MACD
                </button>
                {/* User-defined indicators */}
                {allUserIndicators.map(indicator => (
                  <button
                    key={indicator.id}
                    onClick={() => setUserIndicatorVisibility(prev => ({ ...prev, [indicator.id]: !prev[indicator.id] }))}
                    className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                      userIndicatorVisibility[indicator.id] 
                        ? 'bg-emerald-500/80 text-white shadow-sm shadow-emerald-500/20' 
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                    }`}
                    title={indicator.description || indicator.name}
                  >
                    <span className={`w-1 h-1 rounded-full ${userIndicatorVisibility[indicator.id] ? 'bg-white' : 'bg-emerald-400'}`} />
                    {indicator.name.length > 6 ? indicator.name.slice(0, 6) : indicator.name}
                  </button>
                ))}
                <button
                  onClick={() => setShowIndicatorDialog(true)}
                  className="px-1.5 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center justify-center transition-all cursor-pointer text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
                  title="添加自定义指标"
                >
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
          
          {/* Mobile Controls */}
          <div className="xl:hidden flex flex-wrap items-center gap-2 mt-2 md:mt-3 pt-2 md:pt-3 border-t border-zinc-800 px-2 md:px-0">
            <div className="flex flex-wrap items-center gap-1 mobile-flat bg-zinc-800/15 md:rounded-xl px-1.5 md:px-2.5 py-1 md:py-1.5 md:border md:border-zinc-700/20">
              <span className="text-[9px] font-bold text-zinc-500 tracking-wider mr-0.5 bg-zinc-800/60 px-1.5 py-0.5 rounded-md leading-none">缠</span>
              <button
                onClick={() => setShowCandles(!showCandles)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showCandles ? 'bg-zinc-700/80 text-zinc-100 shadow-sm' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换原始K线"
                id="toggle-candles"
              >
                <span className={`w-1 h-1 rounded-full ${showCandles ? 'bg-zinc-100' : 'bg-zinc-500'}`} />
                K线
              </button>
              <button
                onClick={() => setShowFractions(!showFractions)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showFractions ? 'bg-rose-500/90 text-white shadow-sm shadow-rose-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换顶底分型"
                id="toggle-fractions"
              >
                <span className={`w-1 h-1 rounded-full ${showFractions ? 'bg-white' : 'bg-rose-400'}`} />
                分型
              </button>
              <button
                onClick={() => setShowStrokes(!showStrokes)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showStrokes ? 'bg-amber-500/90 text-white shadow-sm shadow-amber-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换缠论笔"
                id="toggle-strokes"
              >
                <span className={`w-1 h-1 rounded-full ${showStrokes ? 'bg-white' : 'bg-amber-400'}`} />
                笔
              </button>
              <button
                onClick={() => setShowSegments(!showSegments)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showSegments ? 'bg-cyan-500/90 text-white shadow-sm shadow-cyan-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换缠论线段"
                id="toggle-segments"
              >
                <span className={`w-1 h-1 rounded-full ${showSegments ? 'bg-white' : 'bg-cyan-400'}`} />
                线段
              </button>
              <button
                onClick={() => setShowHubs(!showHubs)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showHubs ? 'bg-indigo-500/80 text-white shadow-sm shadow-indigo-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换中枢"
                id="toggle-hubs"
              >
                <span className={`w-1 h-1 rounded-full ${showHubs ? 'bg-white' : 'bg-indigo-400'}`} />
                中枢
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1 mobile-flat bg-zinc-800/15 md:rounded-xl px-1.5 md:px-2.5 py-1 md:py-1.5 md:border md:border-zinc-700/20">
              <span className="text-[9px] font-bold text-zinc-500 tracking-wider mr-0.5 bg-zinc-800/60 px-1.5 py-0.5 rounded-md leading-none">指</span>
              <button
                onClick={() => setShowMA5(!showMA5)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showMA5 ? 'bg-cyan-500/90 text-white shadow-sm shadow-cyan-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="显示5周期移动平均线"
                id="toggle-ma5"
              >
                <span className={`w-1 h-1 rounded-full ${showMA5 ? 'bg-white' : 'bg-cyan-400'}`} />
                MA5
              </button>
              <button
                onClick={() => setShowMA20(!showMA20)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showMA20 ? 'bg-pink-500/90 text-white shadow-sm shadow-pink-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="显示20周期移动平均线"
                id="toggle-ma20"
              >
                <span className={`w-1 h-1 rounded-full ${showMA20 ? 'bg-white' : 'bg-pink-400'}`} />
                MA20
              </button>
              <button
                onClick={() => setShowBOLL(!showBOLL)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showBOLL ? 'bg-purple-500/80 text-white shadow-sm shadow-purple-500/20 border border-purple-400/30' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="显示布林带(20, 2)"
                id="toggle-boll"
              >
                <span className={`w-1 h-1 rounded-full ${showBOLL ? 'bg-white' : 'bg-purple-400'}`} />
                BOLL
              </button>
              <button
                onClick={() => setShowMACD(!showMACD)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showMACD ? 'bg-amber-500/90 text-white shadow-sm shadow-amber-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="激活MACD(12, 26, 9)指标"
                id="toggle-macd"
              >
                <span className={`w-1 h-1 rounded-full ${showMACD ? 'bg-white' : 'bg-amber-400'}`} />
                MACD
              </button>
              {/* User-defined indicators */}
              {allUserIndicators.map(indicator => (
                <button
                  key={indicator.id}
                  onClick={() => setUserIndicatorVisibility(prev => ({ ...prev, [indicator.id]: !prev[indicator.id] }))}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    userIndicatorVisibility[indicator.id] 
                      ? 'bg-emerald-500/80 text-white shadow-sm shadow-emerald-500/20' 
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title={indicator.description || indicator.name}
                >
                  <span className={`w-1 h-1 rounded-full ${userIndicatorVisibility[indicator.id] ? 'bg-white' : 'bg-emerald-400'}`} />
                  {indicator.name.length > 6 ? indicator.name.slice(0, 6) : indicator.name}
                </button>
              ))}
              <button
                onClick={() => setShowIndicatorDialog(true)}
                className="px-1.5 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center justify-center transition-all cursor-pointer text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
                title="添加自定义指标"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Controls when no stock info */}
      {!stockBasicInfo && (
        <div className="flex flex-col xl:flex-row items-stretch xl:items-center justify-end gap-4">

          {/* Visibility Toggles */}
          <div className="flex flex-wrap items-center gap-4 px-2 md:px-0">

            <div className="flex flex-wrap items-center gap-1 mobile-flat bg-zinc-800/15 md:rounded-xl px-1.5 md:px-2.5 py-1 md:py-1.5 md:border md:border-zinc-700/20">
              <span className="text-[9px] font-bold text-zinc-500 tracking-wider mr-0.5 bg-zinc-800/60 px-1.5 py-0.5 rounded-md leading-none">缠</span>
              <button
                onClick={() => setShowCandles(!showCandles)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showCandles ? 'bg-zinc-700/80 text-zinc-100 shadow-sm' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换原始K线"
                id="toggle-candles"
              >
                <span className={`w-1 h-1 rounded-full ${showCandles ? 'bg-zinc-100' : 'bg-zinc-500'}`} />
                K线
              </button>
              <button
                onClick={() => setShowFractions(!showFractions)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showFractions ? 'bg-rose-500/90 text-white shadow-sm shadow-rose-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换顶底分型"
                id="toggle-fractions"
              >
                <span className={`w-1 h-1 rounded-full ${showFractions ? 'bg-white' : 'bg-rose-400'}`} />
                分型
              </button>
              <button
                onClick={() => setShowStrokes(!showStrokes)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showStrokes ? 'bg-amber-500/90 text-white shadow-sm shadow-amber-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换缠论笔"
                id="toggle-strokes"
              >
                <span className={`w-1 h-1 rounded-full ${showStrokes ? 'bg-white' : 'bg-amber-400'}`} />
                笔
              </button>
              <button
                onClick={() => setShowSegments(!showSegments)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showSegments ? 'bg-cyan-500/90 text-white shadow-sm shadow-cyan-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换缠论线段"
                id="toggle-segments"
              >
                <span className={`w-1 h-1 rounded-full ${showSegments ? 'bg-white' : 'bg-cyan-400'}`} />
                线段
              </button>
              <button
                onClick={() => setShowHubs(!showHubs)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showHubs ? 'bg-indigo-500/80 text-white shadow-sm shadow-indigo-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="切换中枢"
                id="toggle-hubs"
              >
                <span className={`w-1 h-1 rounded-full ${showHubs ? 'bg-white' : 'bg-indigo-400'}`} />
                中枢
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1 mobile-flat bg-zinc-800/15 md:rounded-xl px-1.5 md:px-2.5 py-1 md:py-1.5 md:border md:border-zinc-700/20">
              <span className="text-[9px] font-bold text-zinc-500 tracking-wider mr-0.5 bg-zinc-800/60 px-1.5 py-0.5 rounded-md leading-none">指</span>
              <button
                onClick={() => setShowMA5(!showMA5)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showMA5 ? 'bg-cyan-500/90 text-white shadow-sm shadow-cyan-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="显示5周期移动平均线"
                id="toggle-ma5"
              >
                <span className={`w-1 h-1 rounded-full ${showMA5 ? 'bg-white' : 'bg-cyan-400'}`} />
                MA5
              </button>
              <button
                onClick={() => setShowMA20(!showMA20)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showMA20 ? 'bg-pink-500/90 text-white shadow-sm shadow-pink-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="显示20周期移动平均线"
                id="toggle-ma20"
              >
                <span className={`w-1 h-1 rounded-full ${showMA20 ? 'bg-white' : 'bg-pink-400'}`} />
                MA20
              </button>
              <button
                onClick={() => setShowBOLL(!showBOLL)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showBOLL ? 'bg-purple-500/80 text-white shadow-sm shadow-purple-500/20 border border-purple-400/30' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="显示布林带(20, 2)"
                id="toggle-boll"
              >
                <span className={`w-1 h-1 rounded-full ${showBOLL ? 'bg-white' : 'bg-purple-400'}`} />
                BOLL
              </button>
              <button
                onClick={() => setShowMACD(!showMACD)}
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                  showMACD ? 'bg-amber-500/90 text-white shadow-sm shadow-amber-500/20' : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                }`}
                title="激活MACD(12, 26, 9)指标"
                id="toggle-macd"
              >
                <span className={`w-1 h-1 rounded-full ${showMACD ? 'bg-white' : 'bg-amber-400'}`} />
                MACD
              </button>
              {/* User-defined indicators */}
              {allUserIndicators.map(indicator => (
                <button
                  key={indicator.id}
                  onClick={() => setUserIndicatorVisibility(prev => ({ ...prev, [indicator.id]: !prev[indicator.id] }))}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center gap-1 transition-all cursor-pointer ${
                    userIndicatorVisibility[indicator.id] 
                      ? 'bg-emerald-500/80 text-white shadow-sm shadow-emerald-500/20' 
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                  }`}
                  title={indicator.description || indicator.name}
                >
                  <span className={`w-1 h-1 rounded-full ${userIndicatorVisibility[indicator.id] ? 'bg-white' : 'bg-emerald-400'}`} />
                  {indicator.name.length > 6 ? indicator.name.slice(0, 6) : indicator.name}
                </button>
              ))}
              <button
                onClick={() => setShowIndicatorDialog(true)}
                className="px-1.5 py-0.5 rounded-full text-[10px] font-medium font-sans flex items-center justify-center transition-all cursor-pointer text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/40"
                title="添加自定义指标"
              >
                <Plus className="h-3 w-3" />
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Chart and its header group */}
      <div className="flex flex-col">
        {/* Floating Price Data Header panels */}
        <div className="mobile-flat mobile-px-2 mobile-py-2 bg-zinc-950 md:p-3 md:rounded-t-xl md:border md:border-zinc-800 md:border-b-0">
          {/* Row 1: Price Data */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 py-2 mobile-text-center">
            <div className="min-w-0">
              <span className="text-[10px] font-mono text-zinc-500 uppercase">交易日期</span>
              <div className="flex items-center gap-1 mt-0.5 mobile-justify-center">
                <p className="text-xs font-bold font-mono tracking-wide text-zinc-300 truncate">
                  {hoveredData ? hoveredData.date : klines[klines.length - 1].date}
                </p>
                {(() => {
                  const data = hoveredData ?? klines[klines.length - 1];
                  if (!data) return null;

                  const currentIndex = hoveredData
                    ? klines.findIndex(k => k.date === hoveredData.date)
                    : klines.length - 1;

                  if (currentIndex <= 0) return null;

                  const prevClose = klines[currentIndex - 1].close;
                  const change = data.close - prevClose;
                  const pct = (change / prevClose) * 100;
                  const isUp = pct >= 0;

                  return (
                    <span className={`text-[10px] font-mono font-bold tracking-wide px-1.5 py-0.5 rounded ${
                      isUp ? 'text-red-400 bg-red-500/10' : 'text-green-400 bg-green-500/10'
                    }`}>
                      {isUp ? '+' : ''}{pct.toFixed(2)}%
                    </span>
                  );
                })()}
              </div>
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-mono text-zinc-500 uppercase">开盘/收盘价</span>
              <p className="text-xs font-bold font-mono tracking-wide mt-0.5">
                <span className="text-zinc-200">{hoveredData ? hoveredData.open.toFixed(2) : klines[klines.length - 1].open.toFixed(2)}</span>
                <span className="text-zinc-600 mx-1">/</span>
                <span className={(() => { const c = hoveredData ? hoveredData : klines[klines.length - 1]; return c.close < c.open ? 'text-green-400' : 'text-red-400'; })()}>{hoveredData ? hoveredData.close.toFixed(2) : klines[klines.length - 1].close.toFixed(2)}</span>
              </p>
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-mono text-zinc-500 uppercase">最高/最低价</span>
              <p className="text-xs font-bold font-mono tracking-wide text-zinc-400 mt-0.5 truncate">
                {hoveredData
                  ? `${hoveredData.high.toFixed(2)} / ${hoveredData.low.toFixed(2)}`
                  : `${klines[klines.length - 1].high.toFixed(2)} / ${klines[klines.length - 1].low.toFixed(2)}`}
              </p>
            </div>
            <div className="min-w-0">
              <span className="text-[10px] font-mono text-zinc-500 uppercase">成交量/成交额</span>
              <p className="text-xs font-bold font-mono tracking-wide mt-0.5">
                <span className="text-amber-400">
                  {hoveredData
                    ? (hoveredData.volume / 1000).toFixed(1) + 'K'
                    : (klines[klines.length - 1].volume / 1000).toFixed(1) + 'K'}
                </span>
                <span className="text-zinc-600 mx-1">/</span>
                <span className="text-sky-400">
                  {(() => {
                    const a = hoveredData ? hoveredData.amount : klines[klines.length - 1].amount;
                    if (a >= 100000000) return (a / 100000000).toFixed(2) + '亿';
                    if (a >= 10000) return (a / 10000).toFixed(1) + '万';
                    return a.toFixed(0);
                  })()}
                </span>
              </p>
            </div>
          </div>

          {/* Row 2: Industry & Controller */}
          {industry && (
            <div className="mt-2.5 pt-2.5 border-t border-zinc-800/60 flex flex-wrap items-center gap-x-5 gap-y-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <Briefcase className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                <div className="flex flex-wrap items-center gap-1 min-w-0">
                  {industry.split(' > ').map((part, index, parts) => (
                    <span key={index} className="flex items-center gap-1">
                      <span className={`text-[11px] font-medium truncate ${
                        index === parts.length - 1
                          ? 'text-blue-400 font-semibold'
                          : 'text-zinc-400'
                      }`}>
                        {part}
                      </span>
                      {index < parts.length - 1 && (
                        <ChevronRight className="h-2.5 w-2.5 text-zinc-600 shrink-0" />
                      )}
                    </span>
                  ))}
                </div>
              </div>
              {actualController && (
                <div className="flex items-center gap-1.5">
                  <User className="h-3 w-3 text-zinc-500 shrink-0" />
                  <span className={`text-[11px] font-medium ${
                    actualController === '无'
                      ? 'text-zinc-500 italic'
                      : 'text-zinc-300'
                  }`}>
                    {actualController}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* TradingView Chart Container */}
        <div
          ref={chartContainerRef}
          className="w-full h-72 sm:h-96 md:sm:h-[480px] bg-zinc-950/80 md:rounded-b-xl md:border md:border-zinc-800 relative overflow-hidden select-none"
        >
          {/* Indicator values overlay - top left */}
          {(showMA5 || showMA20 || showBOLL || showMACD || Object.values(userIndicatorVisibility).some(v => v)) && (
            <div className="absolute top-1 left-1 z-10 flex flex-row gap-1 pointer-events-none">
              {(() => {
                const idx = hoveredData
                  ? klines.findIndex(k => k.date === hoveredData.date)
                  : klines.length - 1;
                if (idx < 0) return null;
                const items: { key: string; label: string; value: string; color: string }[] = [];
                if (showMA5 && idx >= 0 && ma5Values[idx] !== null) {
                  items.push({ key: 'ma5', label: 'MA5', value: ma5Values[idx]!.toFixed(2), color: '#22d3ee' });
                }
                if (showMA20 && idx >= 0 && ma20Values[idx] !== null) {
                  items.push({ key: 'ma20', label: 'MA20', value: ma20Values[idx]!.toFixed(2), color: '#f472b6' });
                }
                if (showBOLL && idx >= 0) {
                  const b = bollValues;
                  if (b.upper[idx] !== null && b.middle[idx] !== null && b.lower[idx] !== null) {
                    items.push({
                      key: 'boll', label: 'BOLL',
                      value: `U:${b.upper[idx]!.toFixed(1)} M:${b.middle[idx]!.toFixed(1)} L:${b.lower[idx]!.toFixed(1)}`,
                      color: '#a78bfa',
                    });
                  }
                }
                if (showMACD && idx >= 0) {
                  const m = macdValues;
                  if (m.dif[idx] !== null && m.dea[idx] !== null && m.histogram[idx] !== null) {
                    items.push({
                      key: 'macd', label: 'MACD',
                      value: `DIF:${m.dif[idx]!.toFixed(2)} DEA:${m.dea[idx]!.toFixed(2)} Hist:${m.histogram[idx]!.toFixed(2)}`,
                      color: '#fbbf24',
                    });
                  }
                }
                // User-defined indicators
                const dateKey = hoveredData ? hoveredData.date : klines[klines.length - 1].date;
                for (const [indicatorId] of Object.entries(userIndicatorResults)) {
                  const indicator = allUserIndicators.find(i => i.id === indicatorId);
                  if (!indicator || !userIndicatorVisibility[indicatorId]) continue;
                  const result = userIndicatorResults[indicatorId];
                  for (const series of result.result.series) {
                    const point = series.data.find(p => p.time === dateKey);
                    if (point?.value !== null && point?.value !== undefined) {
                      items.push({
                        key: `${indicatorId}-${series.id}`,
                        label: `${indicator.name}${series.name ? `(${series.name})` : ''}`,
                        value: point.value.toFixed(2),
                        color: series.type === 'line'
                          ? (series as import('../types/indicator').UserIndicatorLineSeries).color
                          : '#34d399',
                      });
                    }
                  }
                }
                return items.map(item => (
                  <span
                    key={item.key}
                    className="text-[10px] font-mono font-medium leading-tight bg-zinc-950/70 px-1 py-px rounded"
                    style={{ color: item.color }}
                  >
                    {item.label} {item.value}
                  </span>
                ));
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Indicator details on hover */}
      {hoveredData && (showMA5 || showMA20 || showBOLL || showMACD || Object.values(userIndicatorVisibility).some(v => v)) && (
        <div className="mobile-flat mobile-px-2 mobile-py-2 bg-zinc-950 md:p-3 md:rounded-xl md:border md:border-zinc-800 text-[11px] font-mono text-zinc-400 space-y-0.5">
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
          {/* User-defined indicators */}
          {hoveredData.userIndicators && Object.entries(hoveredData.userIndicators).map(([indicatorId, seriesValues]) => {
            const indicator = allUserIndicators.find(i => i.id === indicatorId);
            if (!indicator || !userIndicatorVisibility[indicatorId]) return null;
            const result = userIndicatorResults[indicatorId];
            if (!result) return null;
            
            return (
              <div key={indicatorId}>
                {result.result.series.map(series => {
                  const value = seriesValues[series.id];
                  if (value === null || value === undefined) return null;
                  return (
                    <p key={series.id}>
                      {indicator.name} ({series.name}): <span className="text-emerald-400 font-medium">{value.toFixed(2)}</span>
                    </p>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* Indicator Dialog */}
      <IndicatorDialog
        isOpen={showIndicatorDialog}
        onClose={() => setShowIndicatorDialog(false)}
        onIndicatorCreated={(indicator) => {
          setAllUserIndicators(prev => [...prev, indicator]);
          setUserIndicatorVisibility(prev => ({
            ...prev,
            [indicator.id]: indicator.defaultVisible ?? true,
          }));
        }}
        existingIndicatorIds={allUserIndicators.map(i => i.id)}
        symbol={symbol}
      />
    </div>
  );
}
