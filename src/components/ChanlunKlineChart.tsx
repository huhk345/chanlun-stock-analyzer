import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { Activity } from 'lucide-react';
import type { BacktestTrade, Kline } from '../types/stock';
import { runChanlunPipeline } from '../utils/chanlun';

interface ChanlunKlineChartProps {
  klines: Kline[];
  trades?: BacktestTrade[];
  heightClass?: string;
}

const EMPTY_STRUCTURES = {
  mergedKlines: [],
  fractions: [],
  strokes: [],
  segments: [],
  hubs: [],
  bsPoints: [],
};

const FRACTAL_COLORS = {
  TOP: '#fb7185',
  BOTTOM: '#60a5fa',
};

const BS_STYLE: Record<
  string,
  { position: 'aboveBar' | 'belowBar'; shape: 'arrowUp' | 'arrowDown'; color: string }
> = {
  B1: { position: 'belowBar', shape: 'arrowUp', color: '#ef4444' },
  B2: { position: 'belowBar', shape: 'arrowUp', color: '#f97316' },
  B3: { position: 'belowBar', shape: 'arrowUp', color: '#ec4899' },
  S1: { position: 'aboveBar', shape: 'arrowDown', color: '#22c55e' },
  S2: { position: 'aboveBar', shape: 'arrowDown', color: '#14b8a6' },
  S3: { position: 'aboveBar', shape: 'arrowDown', color: '#06b6d4' },
};

function TogglePill({
  active,
  label,
  count,
  title,
  activeClassName,
  dotClassName,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  title: string;
  activeClassName: string;
  dotClassName: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium transition ${
        active
          ? activeClassName
          : 'border-transparent text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300'
      }`}
    >
      <span className={`h-1 w-1 rounded-full ${active ? 'bg-white' : dotClassName}`} />
      {label}
      {count !== undefined && (
        <span className={`font-mono text-[9px] ${active ? 'opacity-80' : 'text-zinc-600'}`}>{count}</span>
      )}
    </button>
  );
}

/**
 * 策略模拟结果用的轻量 K 线图:
 * K 线 + 成交量 + 缠论笔/线段/中枢/分型/三类买卖点 + 回测成交标记。
 *
 * 与个股分析页的 ChanlunChart 保持同一视觉语言, 但只保留回测复盘需要的
 * 图层, 避免在结果卡片里塞入一整套指标工具栏。缠论结构在浏览器端由
 * runChanlunPipeline 重新计算 (回测接口只返回 K 线与成交)。
 */
export default function ChanlunKlineChart({
  klines,
  trades = [],
  heightClass = 'h-64 md:h-72',
}: ChanlunKlineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const strokeRef = useRef<ISeriesApi<'Line'> | null>(null);
  const segmentRef = useRef<ISeriesApi<'Line'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [showFractions, setShowFractions] = useState(false);
  const [showStrokes, setShowStrokes] = useState(true);
  const [showSegments, setShowSegments] = useState(true);
  const [showHubs, setShowHubs] = useState(true);
  const [showBSPoints, setShowBSPoints] = useState(true);
  const [showTrades, setShowTrades] = useState(true);

  const structures = useMemo(() => {
    if (klines.length === 0) return EMPTY_STRUCTURES;
    return runChanlunPipeline(klines);
  }, [klines]);

  // Create the chart once. Data / overlays are applied by the effects below so
  // toggling a layer never resets the user's zoom and scroll position.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
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
        scaleMargins: { top: 0.12, bottom: 0.22 },
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: false,
        rightOffset: 3,
        barSpacing: 6,
        minBarSpacing: 1.5,
      },
      handleScale: { axisPressedMouseMove: true },
      handleScroll: { vertTouchDrag: false },
    });
    chartRef.current = chart;

    // 中国市场惯例: 红涨绿跌
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#f43f5e',
      downColor: '#10b981',
      borderUpColor: '#f43f5e',
      borderDownColor: '#10b981',
      wickUpColor: '#f43f5e',
      wickDownColor: '#10b981',
    });
    candleRef.current = candleSeries;

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    volumeRef.current = volumeSeries;

    // 缠论笔 / 线段 (颜色与个股分析页一致)
    const strokeSeries = chart.addSeries(LineSeries, {
      color: '#fbbf24',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    strokeRef.current = strokeSeries;

    const segmentSeries = chart.addSeries(LineSeries, {
      color: '#06b6d4',
      lineWidth: 3,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    segmentRef.current = segmentSeries;

    // 一个 markers 插件同时承载: 分型 / 三类买卖点 / 回测成交。
    markersRef.current = createSeriesMarkers(candleSeries, []);

    // 中枢矩形用一张覆盖在图表上的透明 canvas 绘制。
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      pointerEvents: 'none',
      zIndex: '5',
    });
    el.appendChild(canvas);
    canvasRef.current = canvas;

    return () => {
      canvas.remove();
      canvasRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      strokeRef.current = null;
      segmentRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // K 线 + 成交量
  useEffect(() => {
    const candle = candleRef.current;
    const chart = chartRef.current;
    if (!candle || !chart) return;

    candle.setData(
      klines.map((k) => ({
        time: k.date as Time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      })),
    );

    volumeRef.current?.setData(
      klines.map((k) => ({
        time: k.date as Time,
        value: k.volume,
        color: k.close >= k.open ? 'rgba(244, 63, 94, 0.25)' : 'rgba(16, 185, 129, 0.25)',
      })),
    );

    const n = klines.length;
    if (n === 0) return;
    // 回测区间常常有几百根 K 线: 默认展示最近一段, 保证笔/中枢看得清,
    // 用户仍可拖动/缩放查看完整区间。
    if (n <= 160) {
      chart.timeScale().fitContent();
    } else {
      chart.timeScale().setVisibleLogicalRange({ from: n - 220, to: n + 3 });
    }
  }, [klines]);

  // 缠论笔 / 线段折线
  useEffect(() => {
    const strokeData: LineData<Time>[] = [];
    for (const stroke of structures.strokes) {
      strokeData.push({ time: stroke.start.date as Time, value: stroke.start.price });
    }
    if (structures.strokes.length > 0) {
      const last = structures.strokes[structures.strokes.length - 1];
      strokeData.push({ time: last.end.date as Time, value: last.end.price });
    }
    strokeRef.current?.setData(strokeData);

    const segmentData: LineData<Time>[] = [];
    for (const segment of structures.segments) {
      segmentData.push({ time: segment.start.date as Time, value: segment.start.price });
    }
    if (structures.segments.length > 0) {
      const last = structures.segments[structures.segments.length - 1];
      segmentData.push({ time: last.end.date as Time, value: last.end.price });
    }
    segmentRef.current?.setData(segmentData);
  }, [structures]);

  useEffect(() => {
    strokeRef.current?.applyOptions({ visible: showStrokes });
  }, [showStrokes]);

  useEffect(() => {
    segmentRef.current?.applyOptions({ visible: showSegments });
  }, [showSegments]);

  // 分型 / 三类买卖点 / 回测成交标记
  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;

    if (klines.length === 0) {
      plugin.setMarkers([]);
      return;
    }

    const markers: SeriesMarker<Time>[] = [];
    const klineByDate = new Map(klines.map((k) => [k.date, k]));

    if (showFractions) {
      for (const fraction of structures.fractions) {
        markers.push({
          time: fraction.date as Time,
          position: fraction.type === 'TOP' ? 'aboveBar' : 'belowBar',
          shape: fraction.type === 'TOP' ? 'arrowDown' : 'arrowUp',
          color: FRACTAL_COLORS[fraction.type],
          size: 0.7,
        });
      }
    }

    if (showBSPoints) {
      for (const point of structures.bsPoints) {
        const style = BS_STYLE[point.type];
        if (!style) continue;
        markers.push({
          time: point.date as Time,
          ...style,
          text: point.label,
          size: 1.2,
        });
      }
    }

    if (showTrades) {
      for (const trade of trades) {
        const kline = klineByDate.get(trade.date);
        if (!kline) continue;
        const isBuy = trade.type === 'BUY';
        const offset = (kline.high - kline.low) * 1.5 || kline.close * 0.02;
        markers.push({
          time: trade.date as Time,
          position: isBuy ? 'atPriceBottom' : 'atPriceTop',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          color: isBuy ? '#ef4444' : '#22c55e',
          text: isBuy ? '买入' : '卖出',
          price: isBuy ? kline.low - offset : kline.high + offset,
          size: 1.4,
        });
      }
    }

    // lightweight-charts 要求标记按时间升序
    markers.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    plugin.setMarkers(markers);
  }, [klines, structures.fractions, structures.bsPoints, trades, showFractions, showBSPoints, showTrades]);

  // 中枢矩形 (canvas overlay)
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    const canvas = canvasRef.current;
    const el = containerRef.current;
    if (!chart || !candle || !canvas || !el) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    const paint = () => {
      frame = 0;
      const cssWidth = Math.max(0, el.clientWidth - chart.priceScale('right').width());
      const cssHeight = el.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
      const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssWidth, cssHeight);

      if (!showHubs || structures.hubs.length === 0) return;

      for (const hub of structures.hubs) {
        const startK = klines[hub.startIndex];
        const endK = klines[Math.min(hub.endIndex, klines.length - 1)];
        if (!startK || !endK) continue;

        const x1 = chart.timeScale().timeToCoordinate(startK.date as Time);
        const x2 = chart.timeScale().timeToCoordinate(endK.date as Time);
        const y1 = candle.priceToCoordinate(hub.zg);
        const y2 = candle.priceToCoordinate(hub.zd);
        if (x1 === null || x2 === null || y1 === null || y2 === null) continue;

        const left = Math.min(x1, x2);
        const width = Math.max(2, Math.abs(x2 - x1));
        const top = Math.min(y1, y2);
        const height = Math.max(1, Math.abs(y2 - y1));

        ctx.fillStyle = 'rgba(99, 102, 241, 0.16)';
        ctx.fillRect(left, top, width, height);

        ctx.strokeStyle = 'rgba(99, 102, 241, 0.65)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(left, top, width, height);

        const midY = top + height / 2;
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(left, midY);
        ctx.lineTo(left + width, midY);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };

    schedule();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(el);
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    chart.timeScale().subscribeVisibleTimeRangeChange(schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      chart.timeScale().unsubscribeVisibleTimeRangeChange(schedule);
    };
  }, [klines, structures.hubs, showHubs]);

  if (klines.length === 0) {
    return (
      <div className={`flex items-center justify-center ${heightClass} text-xs text-zinc-600`}>
        暂无 K 线数据
      </div>
    );
  }

  const buyCount = trades.filter((t) => t.type === 'BUY').length;
  const sellCount = trades.length - buyCount;

  return (
    <div className="w-full">
      {/* 图层开关 (默认只打开复盘最常看的笔/线段/中枢/买卖点) */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 flex h-4 items-center rounded bg-zinc-800/70 px-1.5 text-[9px] font-bold leading-none tracking-wider text-zinc-400">
          缠
        </span>
        <TogglePill
          active={showStrokes}
          onClick={() => setShowStrokes((v) => !v)}
          label="笔"
          count={structures.strokes.length}
          title="显示/隐藏缠论笔"
          activeClassName="border-amber-400/30 bg-amber-500/20 text-amber-200"
          dotClassName="bg-amber-400"
        />
        <TogglePill
          active={showSegments}
          onClick={() => setShowSegments((v) => !v)}
          label="线段"
          count={structures.segments.length}
          title="显示/隐藏缠论线段"
          activeClassName="border-cyan-400/30 bg-cyan-500/20 text-cyan-200"
          dotClassName="bg-cyan-400"
        />
        <TogglePill
          active={showHubs}
          onClick={() => setShowHubs((v) => !v)}
          label="中枢"
          count={structures.hubs.length}
          title="显示/隐藏缠论中枢"
          activeClassName="border-indigo-400/30 bg-indigo-500/20 text-indigo-200"
          dotClassName="bg-indigo-400"
        />
        <TogglePill
          active={showBSPoints}
          onClick={() => setShowBSPoints((v) => !v)}
          label="三类点"
          count={structures.bsPoints.length}
          title="显示/隐藏缠论一、二、三类买卖点"
          activeClassName="border-fuchsia-400/30 bg-fuchsia-500/20 text-fuchsia-200"
          dotClassName="bg-fuchsia-400"
        />
        <TogglePill
          active={showFractions}
          onClick={() => setShowFractions((v) => !v)}
          label="分型"
          count={structures.fractions.length}
          title="显示/隐藏顶底分型"
          activeClassName="border-rose-400/30 bg-rose-500/20 text-rose-200"
          dotClassName="bg-rose-400"
        />
        <TogglePill
          active={showTrades}
          onClick={() => setShowTrades((v) => !v)}
          label="成交"
          count={trades.length}
          title="显示/隐藏回测买卖成交标记"
          activeClassName="border-emerald-400/30 bg-emerald-500/20 text-emerald-200"
          dotClassName="bg-emerald-400"
        />
        <span className="ml-auto hidden items-center gap-2 font-mono text-[10px] text-zinc-600 sm:flex">
          {trades.length > 0 && (
            <>
              <span className="text-red-400/80">买入 {buyCount}</span>
              <span className="text-emerald-400/80">卖出 {sellCount}</span>
            </>
          )}
          <span className="flex items-center gap-1">
            <Activity className="h-3 w-3" />
            {structures.strokes.length} 笔 · {structures.hubs.length} 中枢
          </span>
        </span>
      </div>

      <div
        ref={containerRef}
        className={`relative w-full overflow-hidden rounded-xl border border-zinc-800/70 bg-zinc-950 ${heightClass}`}
      />

      <p className="mt-1.5 text-[10px] text-zinc-600">
        滚轮缩放 · 拖动查看历史 · 红↑ 买入 / 绿↓ 卖出 · 紫色框为缠论中枢
      </p>
    </div>
  );
}
