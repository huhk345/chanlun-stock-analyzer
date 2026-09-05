import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, Activity, Waves, TrendingUp, LayoutGrid, ListOrdered, ChevronRight, AlertTriangle, Flame, Star, X, Trophy, Globe, Coins, Scale, SlidersHorizontal, Check } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts';
import {
  IndexQuote,
  MarketBreadth,
  MarketFlowToday,
  DailyFlowPoint,
  FlowItem,
  HotSector,
  MarketSentiment,
  StockQuote,
  GlobalIndexQuote,
  CryptoQuote,
  InstitutionPositionSummary,
  fetchIndexQuotes,
  fetchStockQuotes,
  fetchMarketBreadthAndFlow,
  fetchMarketFlowHistory,
  fetchSectorFlowTop,
  fetchStockFlowTop,
  fetchHotSectors,
  fetchMarketSentiment,
  fetchCryptoQuotes,
  fetchQuotesBySecids,
  subscribeCryptoQuotes,
  MARKET_QUOTE_CATALOG,
  DEFAULT_WORLD_CODES,
  DEFAULT_COMM_IDS,
  DEFAULT_CRYPTO_SYMBOLS,
  WORLD_CATALOG_CODES,
  COMM_CATALOG_CODES,
  CRYPTO_CATALOG,
  marketSecidsFor,
  sortQuotesByCodes,
  marketGroupOf,
  isCryptoSymbol,
  fetchInstitutionPositions,
  isCnMarketOpen,
  anyGlobalMarketOpen,
  getMarketSessions,
  marketIdForIndexCode,
  formatYi,
  formatSignedYi,
  formatVolume,
  formatCryptoPrice,
} from '../utils/marketApi';
import type { MarketId, MarketSessionInfo } from '../utils/marketApi';
import { WatchItem, loadWatchlist, removeFromWatchlist, toTencentSymbol } from '../utils/watchlistStorage';
import { TYPE_STYLE } from './IndexAnalysis';

interface MarketDashboardProps {
  onSelectStock: (code: string) => void;
}

// A股配色习惯: 红涨绿跌 / 红流入绿流出
const upClass = (v: number) => (v > 0 ? 'text-red-500' : v < 0 ? 'text-green-500' : 'text-zinc-400');

// 价格变动闪烁: 价格更新时短暂高亮卡片 (红=上涨, 绿=下跌)
function usePriceFlash(price: number): 'up' | 'down' | null {
  const prevRef = useRef<number | null>(null);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = price;
    if (prev === null || price === prev) return;
    setFlash(price > prev ? 'up' : 'down');
    const t = setTimeout(() => setFlash(null), 800);
    return () => clearTimeout(t);
  }, [price]);
  return flash;
}

// 闪烁样式: ring 高亮, 不与卡片原有边框冲突
const flashClass = (flash: 'up' | 'down' | null) =>
  flash === 'up' ? 'ring-1 ring-red-500/60' : flash === 'down' ? 'ring-1 ring-green-500/60' : '';

// 交易状态圆点: 绿色呼吸 = 交易中, 灰色 = 已休市; 悬停显示当地时间
function SessionDot({ s }: { s?: MarketSessionInfo }) {
  if (!s) return null;
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
        s.open ? 'bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.9)] animate-pulse' : 'bg-zinc-600'
      }`}
      title={`${s.label}${s.open ? '交易中' : '已休市'} · 当地时间 ${s.localTime}`}
    />
  );
}

// ---------------------------------------------------------------------------
// 用户自选面板: 环球市场 / 大宗商品与加密货币的显示标的可自定义, 存 localStorage
// ---------------------------------------------------------------------------

const WORLD_SEL_KEY = 'chanlun_panel_world';
const COMM_SEL_KEY = 'chanlun_panel_comm';

// 自选对话框展示全目录 (所有可获取行情的指数/ETF/商品/加密货币);
// 默认展示保持精简头条, 避免首屏过载
const WORLD_VALID_IDS: string[] = WORLD_CATALOG_CODES;
const COMM_VALID_IDS: string[] = COMM_CATALOG_CODES;
const DEFAULT_COMM_ALL: string[] = [...DEFAULT_COMM_IDS, ...DEFAULT_CRYPTO_SYMBOLS];

/** 读取自选 id 列表: 缺失/损坏回退默认; 空数组视为用户清空, 予以尊重 */
export function loadIdSelection(key: string, valid: string[], fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return fallback;
    const set = new Set(valid);
    const ids = arr.filter((x: unknown): x is string => typeof x === 'string' && set.has(x));
    if (arr.length > 0 && ids.length === 0) return fallback;
    return ids;
  } catch {
    return fallback;
  }
}

export function persistIdSelection(key: string, ids: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(ids));
  } catch { /* ignore */ }
}

/** 按目录顺序整理自选 (布局稳定, 不随点击顺序漂移) */
export function orderIdsByCatalog(ids: string[], valid: string[]): string[] {
  const set = new Set(ids);
  return valid.filter((id) => set.has(id));
}

// 自选对话框条目: 左侧名称 + 右侧代码
export interface MarketPickEntry { id: string; name: string; sub: string }
export interface MarketPickGroup { label: string; items: MarketPickEntry[] }

// 自选对话框分组: code -> 选择器条目 (保持目录顺序)
function marketPickEntries(codes: string[]): MarketPickEntry[] {
  const byCode = new Map(MARKET_QUOTE_CATALOG.map((i) => [i.code, i]));
  return codes
    .map((c) => byCode.get(c))
    .filter((i): i is NonNullable<typeof i> => !!i)
    .map((i) => ({ id: i.code, name: i.label, sub: i.code }));
}

function cryptoPickEntries(symbols: string[]): MarketPickEntry[] {
  return CRYPTO_CATALOG.filter((c) => symbols.includes(c.symbol)).map((c) => ({
    id: c.symbol,
    name: c.label,
    sub: c.symbol.replace(/USDT$/, ''),
  }));
}

/** 环球市场自选分组: 亚太 / 美洲 / 欧洲 / 科技与ETF / 美股个股 */
function buildWorldPickGroups(): MarketPickGroup[] {
  return [
    { label: '亚太指数', items: marketPickEntries(['HSI', 'HSCEI', 'N225', 'TWII', 'KS11', 'SENSEX', 'STI', 'KLSE', 'JKSE', 'SET', 'PSI', 'VNINDEX', 'AORD']) },
    { label: '美洲指数', items: marketPickEntries(['DJIA', 'SPX', 'NDX', 'HXC', 'TSX', 'MXX', 'BVSP']) },
    { label: '欧洲指数', items: marketPickEntries(['FTSE', 'GDAXI', 'FCHI', 'SX5E', 'SSMI', 'AEX', 'MIB', 'IBEX', 'HEX', 'ATX', 'RTS', 'OMXC20', 'ISEQ', 'PSI20']) },
    { label: '科技与ETF', items: marketPickEntries(['HSTECH', 'SOXX', 'SMH', 'QQQ', 'SPY', 'DIA', 'IWM', 'XLK', 'VGT', 'ARKK', 'KWEB', 'TLT']) },
    { label: '美股 · 科技巨头', items: marketPickEntries(['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA']) },
    { label: '美股 · 芯片', items: marketPickEntries(['AVGO', 'AMD', 'QCOM', 'ARM', 'MU']) },
    { label: '美股 · 软件消费', items: marketPickEntries(['NFLX', 'ADBE', 'COST', 'PLTR', 'COIN', 'MSTR', 'PDD', 'JD']) },
    { label: '美股 · 金融医药', items: marketPickEntries(['V', 'MA', 'JPM', 'LLY', 'UNH', 'XOM', 'DIS', 'CRM', 'ORCL']) },
    { label: '美股 · 中概ADR', items: marketPickEntries(['BABA', 'TSM', 'NIO']) },
  ].filter((g) => g.items.length > 0);
}

/** 商品与加密货币自选分组: 金属 / 能源 / 农产品 / 汇率 / 主流币 / 更多币种 */
function buildCommPickGroups(): MarketPickGroup[] {
  const mainstream = new Set(DEFAULT_CRYPTO_SYMBOLS);
  const allCrypto = CRYPTO_CATALOG.map((c) => c.symbol);
  return [
    { label: '贵金属与金属', items: marketPickEntries(['GC00Y', 'SI00Y', 'HG00Y']) },
    { label: '能源', items: marketPickEntries(['CL00Y', 'B00Y', 'NG00Y', 'HO00Y', 'RB00Y']) },
    { label: '农产品', items: marketPickEntries(['ZS00Y', 'ZC00Y', 'ZW00Y', 'ZL00Y', 'ZM00Y', 'CT00Y', 'SB00Y']) },
    { label: '汇率', items: marketPickEntries(['UDI', 'USDCNH']) },
    { label: '主流加密货币', items: cryptoPickEntries(allCrypto.filter((s) => mainstream.has(s))) },
    { label: '更多加密货币', items: cryptoPickEntries(allCrypto.filter((s) => !mainstream.has(s))) },
  ].filter((g) => g.items.length > 0);
}

function MarketPickDialog({ title, subtitle, groups, selected, onToggle, onToggleGroup, onSelectAll, onClear, onReset, onClose }: {
  title: string;
  subtitle?: string;
  groups: MarketPickGroup[];
  selected: string[];
  onToggle: (id: string) => void;
  onToggleGroup: (ids: string[], select: boolean) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const selectedSet = new Set(selected);
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        onClick={e => e.stopPropagation()}
        className="relative bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl w-[92vw] max-w-xl p-4 md:p-5 max-h-[82vh] flex flex-col"
      >
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-blue-400" />
            {title}
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="h-4 w-4 text-zinc-500" />
          </button>
        </div>
        {subtitle && <p className="text-[11px] text-zinc-500 mb-3">{subtitle}</p>}
        <div className="overflow-y-auto pr-0.5 -mx-1 px-1">
          {groups.map(g => {
            const picked = g.items.filter(it => selectedSet.has(it.id)).length;
            const allOn = picked === g.items.length && g.items.length > 0;
            return (
              <div key={g.label} className="mb-3 last:mb-0">
                <div className="flex items-center justify-between gap-2 px-1 mb-1">
                  <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                    {g.label} · {picked}/{g.items.length}
                  </div>
                  <button
                    onClick={() => onToggleGroup(g.items.map(it => it.id), !allOn)}
                    className="text-[10px] text-zinc-500 hover:text-blue-400 transition-colors cursor-pointer shrink-0"
                  >
                    {allOn ? '取消本组' : '全选本组'}
                  </button>
                </div>
                <div className="divide-y divide-zinc-800/60 rounded-xl border border-zinc-800/80 bg-zinc-950/60 overflow-hidden">
                  {g.items.map(it => {
                    const active = selectedSet.has(it.id);
                    return (
                      <button
                        key={it.id}
                        onClick={() => onToggle(it.id)}
                        className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer ${
                          active ? 'bg-blue-500/[0.07] hover:bg-blue-500/[0.12]' : 'hover:bg-zinc-800/60'
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 items-center justify-center rounded border shrink-0 transition-colors ${
                            active ? 'border-blue-500 bg-blue-500' : 'border-zinc-700 bg-transparent'
                          }`}
                        >
                          {active && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
                        </span>
                        <span className={`text-xs truncate ${active ? 'text-zinc-100' : 'text-zinc-400'}`}>
                          {it.name}
                        </span>
                        <span className="ml-auto text-[10px] font-mono text-zinc-600 shrink-0 pl-2">
                          {it.sub}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex gap-2 mt-4 pt-4 border-t border-zinc-800/80">
          <button
            onClick={onSelectAll}
            className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-all cursor-pointer"
          >
            全选
          </button>
          <button
            onClick={onClear}
            className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-all cursor-pointer"
          >
            清空
          </button>
          <button
            onClick={onReset}
            className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-lg transition-all cursor-pointer"
          >
            恢复默认
          </button>
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-blue-500 hover:bg-blue-400 active:bg-blue-600 text-white text-xs font-bold rounded-lg transition-all cursor-pointer"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

function Panel({
  icon: Icon,
  title,
  subtitle,
  right,
  children,
  className = '',
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 md:p-5 ${className}`}>
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center justify-center h-7 w-7 rounded-lg bg-blue-500/10 border border-blue-500/20 shrink-0">
            <Icon className="h-3.5 w-3.5 text-blue-400" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-zinc-100 truncate">{title}</h3>
            {subtitle && <p className="text-[10px] text-zinc-500 mt-0.5 truncate">{subtitle}</p>}
          </div>
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

function IndexCard({ q, session, onOpen }: { q: IndexQuote; session?: MarketSessionInfo; onOpen?: (symbol: string) => void }) {
  const up = q.change >= 0;
  const amp = q.prevClose > 0 ? ((q.high - q.low) / q.prevClose) * 100 : 0;
  const flash = usePriceFlash(q.price);
  return (
    <div
      onClick={onOpen ? () => onOpen(`${q.code}.${q.symbol.toLowerCase().startsWith('sh') ? 'SS' : 'SZ'}`) : undefined}
      className={`bg-zinc-900/60 border border-zinc-800/80 rounded-xl p-2.5 md:p-3.5 hover:border-blue-500/50 transition-all duration-300 ${flashClass(flash)} ${onOpen ? 'cursor-pointer' : ''}`}
      title={onOpen ? `${q.name} · 点击查看缠论分析` : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-zinc-200 truncate">{q.name}</span>
          <SessionDot s={session} />
        </span>
        <span className="text-[9px] font-mono text-zinc-600 shrink-0">{q.code}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
        <span className={`font-mono font-bold text-lg md:text-xl tabular-nums ${up ? 'text-red-500' : 'text-green-500'}`}>
          {q.price.toFixed(2)}
        </span>
        <span className={`font-mono text-[11px] tabular-nums whitespace-nowrap ${up ? 'text-red-400' : 'text-green-400'}`}>
          昨收 {q.prevClose.toFixed(2)}
        </span>
      </div>
      <div className={`mt-1 flex items-baseline gap-2 font-mono text-xs tabular-nums ${up ? 'text-red-400' : 'text-green-400'}`}>
        <span>{up ? '+' : ''}{q.change.toFixed(2)}</span>
        <span className="font-semibold">{up ? '+' : ''}{q.changePercent.toFixed(2)}%</span>
      </div>
      {/* 开高低振量额: 3 行 x 2 列对齐网格 (mobile: tighter type) */}
      <div className="mt-3 grid grid-cols-[auto_1fr_auto_1fr] gap-x-2 gap-y-0.5 text-[9px] md:text-[10px] font-mono tabular-nums text-zinc-500">
        <span className="text-zinc-600">开</span><span>{q.open.toFixed(2)}</span>
        <span className="text-zinc-600">高</span><span>{q.high.toFixed(2)}</span>
        <span className="text-zinc-600">低</span><span>{q.low.toFixed(2)}</span>
        <span className="text-zinc-600">振</span><span>{amp.toFixed(2)}%</span>
        <span className="text-zinc-600">量</span><span>{formatVolume(q.volume)}</span>
        <span className="text-zinc-600">额</span><span>{formatYi(q.amount, 0)}</span>
      </div>
    </div>
  );
}

function GlobalIndexCard({ q, decimals = 2, prefix = '', session, onOpen }: { q: GlobalIndexQuote; decimals?: number; prefix?: string; session?: MarketSessionInfo; onOpen?: (symbol: string) => void }) {
  const up = q.change >= 0;
  const fmt = (v: number) => prefix + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const flash = usePriceFlash(q.price);
  return (
    <div
      onClick={onOpen ? () => onOpen(`GI.${q.code}`) : undefined}
      className={`bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2 hover:border-blue-500/50 transition-all duration-300 min-w-0 h-[90px] flex flex-col justify-center overflow-hidden ${flashClass(flash)} ${onOpen ? 'cursor-pointer' : ''}`}
      title={onOpen ? `${q.name} · 点击查看缠论分析` : `${q.name} (${q.code})`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-zinc-200 truncate">{q.name}</span>
          <SessionDot s={session} />
        </span>
        <span className="text-[9px] font-mono text-zinc-600 shrink-0">{q.code}</span>
      </div>
      <div className={`mt-1.5 font-mono font-bold text-base tabular-nums ${up ? 'text-red-500' : 'text-green-500'}`}>
        {fmt(q.price)}
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-xs tabular-nums">
        <span className={up ? 'text-red-400' : 'text-green-400'}>
          {up ? '+' : ''}{prefix}{q.change.toFixed(decimals)}
        </span>
        <span className={`font-semibold ${up ? 'text-red-400' : 'text-green-400'}`}>
          {up ? '+' : ''}{q.changePercent.toFixed(2)}%
        </span>
      </div>
    </div>
  );
}

function CryptoCard({ q, onOpen }: { q: CryptoQuote; onOpen?: (symbol: string) => void }) {
  const up = q.changePercent >= 0;
  const flash = usePriceFlash(q.price);
  return (
    <div
      onClick={onOpen ? () => onOpen(q.symbol) : undefined}
      className={`bg-zinc-900/60 border border-zinc-800/80 rounded-xl px-3 py-2 hover:border-blue-500/50 transition-all duration-300 min-w-0 h-[90px] flex flex-col justify-center overflow-hidden ${flashClass(flash)} ${onOpen ? 'cursor-pointer' : ''}`}
      title={onOpen ? `${q.name} · 点击查看缠论分析` : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-zinc-200 truncate">{q.name}</span>
        <span className="text-[9px] font-mono text-amber-500/80 shrink-0">{q.base}</span>
      </div>
      <div className={`mt-1.5 font-mono font-bold text-base tabular-nums ${up ? 'text-red-500' : 'text-green-500'}`}>
        ${formatCryptoPrice(q.price)}
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[10px] tabular-nums">
        <span className={`font-semibold text-xs ${up ? 'text-red-400' : 'text-green-400'}`}>
          24h {up ? '+' : ''}{q.changePercent.toFixed(2)}%
        </span>
        <span className="text-zinc-600 text-right" title={`24h 高 ${formatCryptoPrice(q.high)} / 低 ${formatCryptoPrice(q.low)}`}>
          额 {formatYi(q.quoteVolume, 1)}
        </span>
      </div>
    </div>
  );
}

function FlowTooltip({ active, payload }: any) {
  if (!active || !payload || !payload.length) return null;
  const p = payload[0].payload as DailyFlowPoint;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <p className="text-zinc-400 font-mono">{p.date}</p>
      <p className={`font-mono font-semibold mt-0.5 ${p.main >= 0 ? 'text-red-400' : 'text-green-400'}`}>
        主力净流入 {formatSignedYi(p.main)}
      </p>
    </div>
  );
}

export default function MarketDashboard({ onSelectStock }: MarketDashboardProps) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [fatalError, setFatalError] = useState('');
  const [indices, setIndices] = useState<IndexQuote[]>([]);
  const [breadth, setBreadth] = useState<MarketBreadth | null>(null);
  const [flow, setFlow] = useState<MarketFlowToday | null>(null);
  const [flowHistory, setFlowHistory] = useState<DailyFlowPoint[]>([]);
  const [sectorIn, setSectorIn] = useState<FlowItem[]>([]);
  const [sectorOut, setSectorOut] = useState<FlowItem[]>([]);
  const [stockTop, setStockTop] = useState<FlowItem[]>([]);
  const [hotSectors, setHotSectors] = useState<HotSector[]>([]);
  const [sentiment, setSentiment] = useState<MarketSentiment | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // 各市场交易时段状态: 每 5 秒重算一次 (分钟级精度足够)
  const [sessionTick, setSessionTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSessionTick(v => v + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const sessions = useMemo(() => getMarketSessions(), [sessionTick]);
  const sessOf = useCallback((code: string): MarketSessionInfo | undefined => {
    const mid = marketIdForIndexCode(code);
    return mid ? sessions[mid] : undefined;
  }, [sessions]);

  // 环球市场: 全球主要指数 + 主流加密货币 (加载失败不影响 A 股主数据)
  const [globalIndices, setGlobalIndices] = useState<GlobalIndexQuote[]>([]);
  const [cryptoQuotes, setCryptoQuotes] = useState<CryptoQuote[]>([]);
  const [techIndices, setTechIndices] = useState<GlobalIndexQuote[]>([]);
  const [usStocks, setUsStocks] = useState<GlobalIndexQuote[]>([]);
  const [commodities, setCommodities] = useState<GlobalIndexQuote[]>([]);
  const [instPositions, setInstPositions] = useState<InstitutionPositionSummary | null>(null);

  // 用户自选面板: 显示标的可自定义, 持久化于 localStorage
  const [worldSel, setWorldSel] = useState<string[]>(() => loadIdSelection(WORLD_SEL_KEY, WORLD_VALID_IDS, DEFAULT_WORLD_CODES));
  const [commSel, setCommSel] = useState<string[]>(() => loadIdSelection(COMM_SEL_KEY, COMM_VALID_IDS, DEFAULT_COMM_ALL));
  const worldSelRef = useRef<string[]>(worldSel);
  worldSelRef.current = worldSel;
  const commSelRef = useRef<string[]>(commSel);
  commSelRef.current = commSel;
  const [worldDialogOpen, setWorldDialogOpen] = useState(false);
  const [commDialogOpen, setCommDialogOpen] = useState(false);

  // 按自选拉取环球市场行情 (失败保留上次数据)
  const refreshWorld = useCallback(async (codes?: string[]) => {
    const sel = codes ?? worldSelRef.current;
    if (sel.length === 0) {
      setGlobalIndices([]);
      setTechIndices([]);
      setUsStocks([]);
      return;
    }
    try {
      const quotes = sortQuotesByCodes(await fetchQuotesBySecids(marketSecidsFor(sel), '环球市场'), sel);
      setGlobalIndices(quotes.filter((q) => marketGroupOf(q.code) === 'global'));
      setTechIndices(quotes.filter((q) => marketGroupOf(q.code) === 'tech'));
      setUsStocks(quotes.filter((q) => marketGroupOf(q.code) === 'us'));
    } catch {
      // 保留上次数据
    }
  }, []);

  // 按自选拉取大宗商品与汇率行情 (失败保留上次数据)
  const refreshComm = useCallback(async (ids?: string[]) => {
    const sel = (ids ?? commSelRef.current).filter((id) => !isCryptoSymbol(id));
    if (sel.length === 0) {
      setCommodities([]);
      return;
    }
    try {
      setCommodities(sortQuotesByCodes(await fetchQuotesBySecids(marketSecidsFor(sel), '商品汇率'), sel));
    } catch {
      // 保留上次数据
    }
  }, []);

  // 按自选拉取加密货币快照 (WS 实时流之外的兜底/全量刷新用)
  const refreshCryptoRest = useCallback(async (ids?: string[]) => {
    const sel = CRYPTO_CATALOG.map((c) => c.symbol)
      .filter((s) => (ids ?? commSelRef.current).includes(s));
    if (sel.length === 0) {
      setCryptoQuotes([]);
      return;
    }
    try {
      setCryptoQuotes(await fetchCryptoQuotes(sel));
    } catch {
      // 保留上次数据
    }
  }, []);

  const applyWorldSel = useCallback((next: string[]) => {
    const ordered = orderIdsByCatalog(next, WORLD_VALID_IDS);
    setWorldSel(ordered);
    persistIdSelection(WORLD_SEL_KEY, ordered);
    refreshWorld(ordered);
  }, [refreshWorld]);

  const applyCommSel = useCallback((next: string[]) => {
    const ordered = orderIdsByCatalog(next, COMM_VALID_IDS);
    setCommSel(ordered);
    persistIdSelection(COMM_SEL_KEY, ordered);
    refreshComm(ordered);
    // 加密货币部分由下方订阅 effect 跟随 commSel 自动重建 (含即时 REST 快照)
  }, [refreshComm]);

  // 自选股跟踪: 来自「缠论买卖点扫描」的自选, 跟踪自加入以来的涨跌
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [watchQuotes, setWatchQuotes] = useState<Record<string, StockQuote>>({});
  const [watchLoading, setWatchLoading] = useState(false);

  const refreshWatchQuotes = useCallback(async (items: WatchItem[]) => {
    if (items.length === 0) {
      setWatchQuotes({});
      return;
    }
    setWatchLoading(true);
    try {
      const quotes = await fetchStockQuotes(items.map(it => toTencentSymbol(it.symbolKey)));
      const map: Record<string, StockQuote> = {};
      for (const q of quotes) map[q.symbol] = q;
      setWatchQuotes(map);
    } catch {
      // 保留上次行情
    } finally {
      setWatchLoading(false);
    }
  }, []);

  // 进入页面时加载自选并拉取行情
  useEffect(() => {
    setWatchlist(loadWatchlist());
  }, []);

  useEffect(() => {
    refreshWatchQuotes(watchlist);
  }, [watchlist, refreshWatchQuotes]);

  const removeWatch = (symbolKey: string) => {
    setWatchlist(prev => removeFromWatchlist(prev, symbolKey));
  };

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setFatalError('');

    try {
      // 环球市场 / 商品 / 加密货币走自选刷新 (内部已处理失败保留与空自选清空)
      const [idxRes, bfRes, histRes, secInRes, secOutRes, stockRes, sentRes, hotSecRes, instRes] = await Promise.allSettled([
        fetchIndexQuotes(),
        fetchMarketBreadthAndFlow(),
        fetchMarketFlowHistory(30),
        fetchSectorFlowTop(1, 10),
        fetchSectorFlowTop(0, 10),
        fetchStockFlowTop(1, 10),
        fetchMarketSentiment(),
        fetchHotSectors(10),
        fetchInstitutionPositions(),
      ]);
      await Promise.allSettled([refreshWorld(), refreshComm(), refreshCryptoRest()]);

      if (idxRes.status === 'fulfilled') setIndices(idxRes.value);
      else setFatalError(idxRes.reason?.message || '指数行情加载失败');

      // 环球市场: 失败时保留上次数据, 不作为致命错误
      if (instRes.status === 'fulfilled') setInstPositions(instRes.value);

      if (bfRes.status === 'fulfilled') {
        setBreadth(bfRes.value.breadth);
        setFlow(bfRes.value.flow);
      } else {
        setBreadth(null);
        setFlow(null);
      }
      setFlowHistory(histRes.status === 'fulfilled' ? histRes.value : []);
      setSectorIn(secInRes.status === 'fulfilled' ? secInRes.value : []);
      setSectorOut(secOutRes.status === 'fulfilled' ? secOutRes.value : []);
      setStockTop(stockRes.status === 'fulfilled' ? stockRes.value : []);
      setHotSectors(hotSecRes.status === 'fulfilled' ? hotSecRes.value : []);
      setSentiment(sentRes.status === 'fulfilled' ? sentRes.value : null);
      setUpdatedAt(new Date());
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [refreshWorld, refreshComm, refreshCryptoRest]);

  useEffect(() => {
    load();
  }, [load]);

  // 指数实时刷新: 交易时段内高频轻量轮询 (对齐东财网页约 3 秒节奏), 页面隐藏时暂停
  // 自选标的经 ref 读取, 改自选即时生效无需重建定时器
  useEffect(() => {
    // A 股指数: 每 3 秒
    const cnTimer = setInterval(() => {
      if (document.hidden || !isCnMarketOpen()) return;
      fetchIndexQuotes().then(setIndices).catch(() => {});
    }, 3000);
    // 全球指数 + 科技指数 (自选): 每 5 秒
    const globalTimer = setInterval(() => {
      if (document.hidden || !anyGlobalMarketOpen()) return;
      refreshWorld();
    }, 5000);
    // 大宗商品与汇率 (自选): 近乎全天交易, 工作日每 10 秒
    const commTimer = setInterval(() => {
      if (document.hidden) return;
      const day = new Date().getDay();
      if (day >= 1 && day <= 5) {
        refreshComm();
      }
    }, 10000);
    return () => { clearInterval(cnTimer); clearInterval(globalTimer); clearInterval(commTimer); };
  }, [refreshWorld, refreshComm]);

  // A 股交易时段内每 60 秒全量刷新 (资金流/情绪等较重接口)
  useEffect(() => {
    const timer = setInterval(() => {
      if (!isCnMarketOpen()) return;
      load(true);
      refreshWatchQuotes(watchlist);
    }, 60000);
    return () => clearInterval(timer);
  }, [load, refreshWatchQuotes, watchlist]);

  // 加密货币 7x24 实时行情: WebSocket 每秒推送; 连接失败时回退为每 5 秒轮询
  // 跟随自选变化重建订阅 (自选为空时清空并停用)
  const cryptoSelKey = useMemo(
    () => CRYPTO_CATALOG.map((c) => c.symbol).filter((s) => commSel.includes(s)).join(','),
    [commSel],
  );
  useEffect(() => {
    if (cryptoSelKey === '') {
      setCryptoQuotes([]);
      return;
    }
    const symbols = cryptoSelKey.split(',');
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (pollTimer) return;
      fetchCryptoQuotes(symbols).then(setCryptoQuotes).catch(() => {});
      pollTimer = setInterval(() => {
        fetchCryptoQuotes(symbols).then(setCryptoQuotes).catch(() => {});
      }, 5000);
    };
    // 立即拉取一次, 避免等待首条推送
    fetchCryptoQuotes(symbols).then(setCryptoQuotes).catch(() => {});
    const unsub = subscribeCryptoQuotes(
      (quotes) => {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } // WS 正常则停用轮询
        setCryptoQuotes(quotes);
      },
      (live) => {
        if (!live) startPolling(); // WS 断开立即切换轮询, 不等 8 秒
      },
      symbols,
    );
    const fallbackTimer = setTimeout(startPolling, 8000); // 8 秒未收到推送则启用轮询
    return () => {
      unsub();
      clearTimeout(fallbackTimer);
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [cryptoSelKey]);

  // ---- 派生数据 ----
  const shIndex = indices.find((i) => i.symbol === 'sh000001');
  const szIndex = indices.find((i) => i.symbol === 'sz399001');
  const shAmount = shIndex?.amount || 0;
  const szAmount = szIndex?.amount || 0;
  const totalAmount = shAmount + szAmount;

  const dataDate =
    shIndex && shIndex.time.length >= 8
      ? `${shIndex.time.slice(0, 4)}-${shIndex.time.slice(4, 6)}-${shIndex.time.slice(6, 8)}`
      : sentiment?.date || (flowHistory.length > 0 ? flowHistory[flowHistory.length - 1].date : '');

  const totalStocks = breadth ? breadth.up + breadth.down + breadth.flat : 0;
  const upRatio = breadth && totalStocks > 0 ? breadth.up / (breadth.up + breadth.down) : 0.5;
  const strength =
    upRatio >= 0.55
      ? { label: '市场偏强', cls: 'bg-red-500/10 text-red-400 border-red-500/30' }
      : upRatio <= 0.45
        ? { label: '市场偏弱', cls: 'bg-green-500/10 text-green-400 border-green-500/30' }
        : { label: '涨跌均衡', cls: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30' };

  const flowLayers = flow
    ? [
        { label: '超大单', value: flow.superLarge },
        { label: '大单', value: flow.large },
        { label: '中单', value: flow.medium },
        { label: '小单', value: flow.small },
      ]
    : [];
  const flowMaxAbs = Math.max(1, ...flowLayers.map((l) => Math.abs(l.value)));
  const mainFlowRatio = flow && totalAmount > 0 ? (flow.main / totalAmount) * 100 : null;

  const chartData = flowHistory.map((p) => ({ date: p.date.slice(5), main: p.main }));
  const sectorInMax = Math.max(1, ...sectorIn.map((s) => Math.abs(s.mainInflow)));
  const sectorOutMax = Math.max(1, ...sectorOut.map((s) => Math.abs(s.mainInflow)));

  const zbRate =
    sentiment && sentiment.limitUp + sentiment.broken > 0
      ? (sentiment.broken / (sentiment.limitUp + sentiment.broken)) * 100
      : null;

  // 连板数 -> 徽章配色 (板数越高越热)
  const boardCls = (n: number) =>
    n >= 5
      ? 'bg-red-500/20 text-red-300 border-red-500/40'
      : n >= 3
        ? 'bg-orange-500/20 text-orange-300 border-orange-500/40'
        : n >= 2
          ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
          : 'bg-zinc-500/15 text-zinc-300 border-zinc-600/50';

  // ---- 错落双列布局: 左列 (机构持仓/涨跌停/板块) 与右列 (资金/趋势/个股榜/热门板块) 独立堆叠 ----
  const hasLeft = watchlist.length > 0 || !!sentiment || !!instPositions || sectorIn.length > 0 || sectorOut.length > 0;
  const hasRight = !!flow || chartData.length > 1 || stockTop.length > 0 || hotSectors.length > 0;

  const flowUnavailable =
    !breadth && !flow && sectorIn.length === 0 && sectorOut.length === 0 && stockTop.length === 0 && flowHistory.length === 0;

  if (loading) {
    return (
      <div className="p-6 md:p-12 text-center flex flex-col items-center justify-center">
        <div className="h-8 w-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin mb-4" />
        <h4 className="text-sm font-semibold text-zinc-200">加载市场全景数据</h4>
        <p className="text-xs text-zinc-400 mt-1">正在获取指数行情、涨跌家数与资金流向...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 md:gap-6">

      {/* ---- 页头 ---- */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center justify-center h-10 w-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-600/5 border border-blue-500/30 shrink-0">
            <Activity className="h-5 w-5 text-blue-400" />
          </div>
          <div>
            <h2 className="text-base md:text-lg font-bold text-zinc-50">市场总览</h2>
            <p className="text-[10px] md:text-[11px] text-zinc-500 mt-0.5 font-mono">
              {dataDate ? `数据日期 ${dataDate}` : '最新交易日'}
              {updatedAt && ` · 更新于 ${updatedAt.toLocaleTimeString('zh-CN', { hour12: false })}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {/* A股交易状态徽标 */}
          <span
            className={`hidden sm:inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-xs font-mono font-semibold transition-colors ${
              sessions.cn.open
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                : 'bg-zinc-900/70 border-zinc-800/80 text-zinc-500'
            }`}
            title={`北京时间 ${sessions.cn.localTime}${sessions.cn.open ? ' · 集合竞价/连续竞盘中' : ' · 休市, 显示最近收盘数据'}`}
          >
            <SessionDot s={sessions.cn} />
            A股 {sessions.cn.open ? '交易中' : '休市'} {sessions.cn.localTime}
          </span>
          {flow && (
            <span className={`hidden sm:inline-flex items-center h-8 px-3 rounded-lg border text-xs font-semibold ${strength.cls}`}>
              {strength.label}
            </span>
          )}
          <button
            type="button"
            onClick={() => { load(true); refreshWatchQuotes(watchlist); }}
            disabled={refreshing}
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg bg-zinc-900/70 border border-zinc-800 text-xs text-zinc-300 hover:border-blue-500/50 hover:text-blue-400 transition-colors cursor-pointer disabled:opacity-50"
            title="刷新数据"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">刷新</span>
          </button>
        </div>
      </div>

      {fatalError && (
        <div className="px-4 py-3 bg-red-950/20 border border-red-900/30 text-red-400 rounded-xl flex items-center gap-3 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{fatalError}</span>
          <button
            type="button"
            onClick={() => load()}
            className="px-2.5 py-1 rounded-md bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 transition-colors cursor-pointer shrink-0"
          >
            重试
          </button>
        </div>
      )}

      {/* ---- 指数行情 ---- */}
      {indices.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2.5 md:gap-3">
          {indices.map((q) => (
            <IndexCard key={q.symbol} q={q} session={sessions.cn} onOpen={onSelectStock} />
          ))}
        </div>
      )}

      {/* ---- 整体动向: 第二行整行横条 ---- */}
      {breadth && (
        <Panel icon={Activity} title="整体动向" subtitle="沪深两市涨跌家数与成交">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="shrink-0">
              <div className="text-[10px] text-zinc-500 font-mono">上涨家数</div>
              <div className="text-xl font-bold font-mono text-red-500 tabular-nums leading-tight">{breadth.up}</div>
            </div>
            <div className="shrink-0">
              <div className="text-[10px] text-zinc-500 font-mono">下跌家数</div>
              <div className="text-xl font-bold font-mono text-green-500 tabular-nums leading-tight">{breadth.down}</div>
            </div>
            <div className="shrink-0">
              <div className="text-[10px] text-zinc-500 font-mono">平盘</div>
              <div className="text-xl font-bold font-mono text-zinc-300 tabular-nums leading-tight">{breadth.flat}</div>
            </div>

            {/* 涨跌家数占比条 */}
            <div className="flex-1 min-w-[100px]">
              <div className="flex h-2 rounded-full overflow-hidden bg-zinc-800">
                <div className="bg-red-500" style={{ width: `${totalStocks > 0 ? (breadth.up / totalStocks) * 100 : 0}%` }} />
                <div className="bg-zinc-600" style={{ width: `${totalStocks > 0 ? (breadth.flat / totalStocks) * 100 : 0}%` }} />
                <div className="bg-green-500" style={{ width: `${totalStocks > 0 ? (breadth.down / totalStocks) * 100 : 0}%` }} />
              </div>
              <div className="mt-1.5 flex items-center justify-between text-[10px] font-mono text-zinc-500">
                <span className="text-red-400/80">上涨占比 {(upRatio * 100).toFixed(1)}%</span>
                <span className="hidden sm:inline">共 {totalStocks} 家</span>
                <span className="text-green-400/80">下跌占比 {((1 - upRatio) * 100).toFixed(1)}%</span>
              </div>
            </div>

            <div className="hidden lg:block h-9 w-px bg-zinc-800/80 shrink-0" />

            <div className="shrink-0">
              <div className="text-[10px] text-zinc-500 font-mono">两市成交额</div>
              <div className="text-xl font-bold font-mono text-zinc-100 tabular-nums leading-tight">
                {totalAmount > 0 ? formatYi(totalAmount) : '--'}
              </div>
            </div>

            {shIndex && szIndex && totalAmount > 0 && (
              <div className="shrink-0 w-32">
                <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                  <span className="text-sky-400">沪 {((shAmount / totalAmount) * 100).toFixed(0)}%</span>
                  <span className="text-violet-400">深 {((szAmount / totalAmount) * 100).toFixed(0)}%</span>
                </div>
                <div className="flex h-1.5 rounded-full overflow-hidden bg-zinc-800">
                  <div className="bg-sky-500/70" style={{ width: `${(shAmount / totalAmount) * 100}%` }} />
                  <div className="bg-violet-500/70" style={{ width: `${(szAmount / totalAmount) * 100}%` }} />
                </div>
              </div>
            )}

            {flow && (
              <>
                <div className="hidden lg:block h-9 w-px bg-zinc-800/80 shrink-0" />
                <div className="shrink-0">
                  <div className="text-[10px] text-zinc-500 font-mono">主力净流入</div>
                  <div className={`text-xl font-bold font-mono tabular-nums leading-tight ${upClass(flow.main)}`}>
                    {formatSignedYi(flow.main)}
                    {mainFlowRatio !== null && (
                      <span className="text-[11px] font-medium ml-1.5 text-zinc-500">
                        净占比 {mainFlowRatio >= 0 ? '+' : ''}{mainFlowRatio.toFixed(2)}%
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </Panel>
      )}

      {/* ---- 环球市场 (左) + 商品汇率与加密货币 (右): 独立高度双栏, 标的可自选 ---- */}
      {(globalIndices.length > 0 || cryptoQuotes.length > 0 || techIndices.length > 0 || commodities.length > 0 || worldSel.length > 0 || commSel.length > 0) && (
        <div className="grid lg:grid-cols-2 gap-4 md:gap-6 items-start">
          <Panel
            icon={Globe}
            title="环球市场"
            subtitle="全球指数 · 科技ETF · 美股个股"
            right={(
              <button
                type="button"
                onClick={() => setWorldDialogOpen(true)}
                className="flex items-center gap-1 h-6 px-2 rounded-md bg-zinc-900/70 border border-zinc-800 text-[10px] text-zinc-400 hover:text-blue-400 hover:border-blue-500/40 transition-colors cursor-pointer"
                title="自定义显示标的 (保存于浏览器本地)"
              >
                <SlidersHorizontal className="h-3 w-3" />
                自选
              </button>
            )}
          >
            {(globalIndices.length > 0 || techIndices.length > 0 || usStocks.length > 0) ? (
              <section className="min-w-0">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 auto-rows-[90px]">
                  {globalIndices.map((q) => (
                    <GlobalIndexCard key={q.code} q={q} session={sessOf(q.code)} onOpen={onSelectStock} />
                  ))}
                  {techIndices.map((q) => (
                    <GlobalIndexCard key={q.code} q={q} session={sessOf(q.code)} onOpen={onSelectStock} />
                  ))}
                  {usStocks.map((q) => (
                    <GlobalIndexCard key={q.code} q={q} prefix="$" session={sessOf(q.code)} onOpen={onSelectStock} />
                  ))}
                </div>
              </section>
            ) : (
              <p className="text-[11px] text-zinc-500 py-6 text-center">
                {worldSel.length === 0 ? '未选择任何标的, 点击右上角「自选」添加关注指数' : '暂无行情数据, 请稍后刷新重试'}
              </p>
            )}

            <div className="mt-3 pt-3 border-t border-zinc-800/60">
              {/* 各市场交易时段状态一览 */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1.5">
                {(Object.keys(sessions) as MarketId[]).map((id) => (
                  <span
                    key={id}
                    className={`inline-flex items-center gap-1 text-[10px] font-mono ${sessions[id].open ? 'text-emerald-400' : 'text-zinc-600'}`}
                    title={`${sessions[id].label}${sessions[id].open ? '交易中' : '已休市'} · 当地时间 ${sessions[id].localTime}`}
                  >
                    <SessionDot s={sessions[id]} />
                    {sessions[id].label}
                  </span>
                ))}
              </div>
              <p className="text-[10px] text-zinc-600 font-mono">
                各市场交易时段不同, 休市时显示最近收盘数据 · 费半以 iShares 半导体 ETF (SOXX) 为参考 · 数据来源: 东方财富
              </p>
            </div>
          </Panel>

          {(commodities.length > 0 || cryptoQuotes.length > 0 || commSel.length > 0) && (
            <Panel
              icon={Coins}
              title="大宗商品与加密货币"
              subtitle="贵金属 · 能源 · 农产品 · 汇率 · 加密货币"
              right={(
                <button
                  type="button"
                  onClick={() => setCommDialogOpen(true)}
                  className="flex items-center gap-1 h-6 px-2 rounded-md bg-zinc-900/70 border border-zinc-800 text-[10px] text-zinc-400 hover:text-blue-400 hover:border-blue-500/40 transition-colors cursor-pointer"
                  title="自定义显示标的 (保存于浏览器本地)"
                >
                  <SlidersHorizontal className="h-3 w-3" />
                  自选
                </button>
              )}
            >
              {(commodities.length > 0 || cryptoQuotes.length > 0) ? (
              <section className="min-w-0">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 auto-rows-[90px]">
                  {commodities.map((q) => (
                    <GlobalIndexCard
                      key={q.code}
                      q={q}
                      decimals={q.code === 'USDCNH' ? 4 : 2}
                      onOpen={onSelectStock}
                    />
                  ))}
                  {cryptoQuotes.map((q) => (
                    <CryptoCard key={q.symbol} q={q} onOpen={onSelectStock} />
                  ))}
                </div>
              </section>
              ) : (
                <p className="text-[11px] text-zinc-500 py-6 text-center">
                  {commSel.length === 0 ? '未选择任何标的, 点击右上角「自选」添加' : '暂无行情数据, 请稍后刷新重试'}
                </p>
              )}

              <p className="mt-3 pt-3 border-t border-zinc-800/60 text-[10px] text-zinc-600 font-mono">
                黄金为 COMEX 主力 · 原油/天然气为 NYMEX/ICE 连续合约 · 农产品为 CBOT/ICE 连续合约 · 汇率为美元兑离岸人民币 · 数据来源: 东方财富 / Binance
              </p>
            </Panel>
          )}
        </div>
      )}

      {/* 自选标的对话框: 全目录 (所有可获取行情的标的, 按区域/资产分组) */}
      {worldDialogOpen && (
        <MarketPickDialog
          title="自选 · 环球市场"
          subtitle={`全球指数与科技ETF全目录 (${WORLD_VALID_IDS.length} 个) · 选择要显示的指数, 修改即时生效并保存于浏览器本地`}
          groups={buildWorldPickGroups()}
          selected={worldSel}
          onToggle={(id) => applyWorldSel(worldSel.includes(id) ? worldSel.filter((x) => x !== id) : [...worldSel, id])}
          onToggleGroup={(ids, select) => {
            const set = new Set(worldSel);
            ids.forEach((id) => { if (select) set.add(id); else set.delete(id); });
            applyWorldSel([...set]);
          }}
          onSelectAll={() => applyWorldSel(WORLD_VALID_IDS)}
          onClear={() => applyWorldSel([])}
          onReset={() => applyWorldSel(DEFAULT_WORLD_CODES)}
          onClose={() => setWorldDialogOpen(false)}
        />
      )}
      {commDialogOpen && (
        <MarketPickDialog
          title="自选 · 大宗商品与加密货币"
          subtitle={`商品/汇率/加密货币全目录 (${COMM_VALID_IDS.length} 个) · 选择要显示的标的, 修改即时生效并保存于浏览器本地`}
          groups={buildCommPickGroups()}
          selected={commSel}
          onToggle={(id) => applyCommSel(commSel.includes(id) ? commSel.filter((x) => x !== id) : [...commSel, id])}
          onToggleGroup={(ids, select) => {
            const set = new Set(commSel);
            ids.forEach((id) => { if (select) set.add(id); else set.delete(id); });
            applyCommSel([...set]);
          }}
          onSelectAll={() => applyCommSel(COMM_VALID_IDS)}
          onClear={() => applyCommSel([])}
          onReset={() => applyCommSel(DEFAULT_COMM_ALL)}
          onClose={() => setCommDialogOpen(false)}
        />
      )}

      {flowUnavailable && !fatalError && (
        <div className="px-4 py-3 bg-amber-950/20 border border-amber-900/30 text-amber-400 rounded-xl flex items-center gap-3 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>资金流向数据暂不可用 (行情接口可能受限), 稍后可点击刷新重试。</span>
        </div>
      )}

      {/* ---- 错落双列: 左右两列独立堆叠, 右列整体下沉形成错落 ---- */}
      {(hasLeft || hasRight) && (
        <div className="grid lg:grid-cols-12 gap-4 md:gap-6 items-start">

          {/* 左列: 自选股跟踪 + 机构多空持仓 + 涨跌停梯队 + 板块资金流向 */}
          {hasLeft && (
            <div className={`order-2 lg:order-1 ${hasRight ? 'lg:col-span-7' : 'lg:col-span-12'} min-w-0 flex flex-col gap-4 md:gap-6`}>

              {/* 自选股跟踪: 自加入以来的涨跌 */}
              <Panel
                icon={Star}
                title="自选股跟踪"
                subtitle="来自缠论买卖点扫描 · 自加入以来的涨跌"
                right={
                  watchlist.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => refreshWatchQuotes(watchlist)}
                      disabled={watchLoading}
                      className="flex items-center gap-1 h-6 px-2 rounded-md bg-zinc-900/70 border border-zinc-800 text-[10px] text-zinc-400 hover:text-blue-400 hover:border-blue-500/40 transition-colors cursor-pointer disabled:opacity-50"
                      title="刷新自选行情"
                    >
                      <RefreshCw className={`h-3 w-3 ${watchLoading ? 'animate-spin' : ''}`} />
                      行情
                    </button>
                  ) : undefined
                }
              >
                {watchlist.length === 0 ? (
                  <p className="text-[11px] text-zinc-500 py-0.5 text-center leading-relaxed">
                    暂无自选股 · 前往「缠论买卖点扫描」点击 ☆ 自选 可将信号股加入跟踪, 并记录加入理由
                  </p>
                ) : (
                  <div className="space-y-px -my-1">
                    {watchlist.map((it) => {
                      const q = watchQuotes[toTencentSymbol(it.symbolKey)];
                      const price = q?.price || 0;
                      const chg = price > 0 && it.basePrice > 0 ? ((price - it.basePrice) / it.basePrice) * 100 : null;
                      const days = Math.floor((Date.now() - it.addedAt) / 86400000);
                      const displayName = q?.name || it.name || '—';
                      return (
                        <div key={it.symbolKey} className="flex items-center gap-0.5 md:gap-1 group">
                          <button
                            type="button"
                            onClick={() => onSelectStock(it.symbolKey.replace('.SH', '.SS'))}
                            className="flex-1 min-w-0 flex items-center gap-1.5 md:gap-2.5 px-1.5 md:px-2 py-1.5 md:py-1 rounded-md hover:bg-blue-500/10 border border-transparent hover:border-blue-500/20 transition-colors cursor-pointer text-left"
                            title={`查看 ${displayName} (${it.code}) 缠论分析 · ${it.baseDate} 以 ${it.basePrice.toFixed(2)} 加入`}
                          >
                            <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-bold shrink-0 ${TYPE_STYLE[it.signalType]}`}>
                              {it.signalLabel}
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-zinc-200 truncate group-hover:text-blue-400 transition-colors">{displayName}</span>
                                <span className="text-[9px] font-mono text-zinc-600 shrink-0">{it.code}</span>
                              </div>
                              {it.reason && (
                                <p className="text-[10px] text-zinc-500 truncate mt-0.5" title={it.reason}>{it.reason}</p>
                              )}
                            </div>
                            <div className="ml-auto flex items-center gap-1.5 md:gap-2.5 font-mono text-xs tabular-nums shrink-0">
                              <span className="hidden sm:flex flex-col items-end leading-tight">
                                <span className="text-[9px] text-zinc-600">{it.baseDate} 加入</span>
                                <span className="text-zinc-400">{it.basePrice.toFixed(2)}</span>
                              </span>
                              <span className="w-12 md:w-14 text-right text-zinc-200">{price > 0 ? price.toFixed(2) : '--'}</span>
                              <span className={`w-14 md:w-16 text-right font-semibold ${chg === null ? 'text-zinc-600' : upClass(chg)}`}>
                                {chg === null ? '--' : `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`}
                              </span>
                              <span className="hidden md:inline w-9 text-right text-zinc-500 text-[10px]">
                                {days === 0 ? '今日' : `${days}天`}
                              </span>
                            </div>
                            <ChevronRight className="h-3.5 w-3.5 text-zinc-700 group-hover:text-blue-400 transition-colors shrink-0" />
                          </button>
                          <button
                            type="button"
                            onClick={() => removeWatch(it.symbolKey)}
                            className="p-1.5 rounded-md text-zinc-600 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer opacity-100 md:opacity-0 md:group-hover:opacity-100 shrink-0"
                            title="移出自选"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Panel>

              {/* 机构多空持仓 */}
              {instPositions && instPositions.list.length > 0 && (
                <Panel
                  icon={Scale}
                  title="机构多空持仓"
                  subtitle={`股指期货 IF/IH/IC/IM 前20会员 · ${instPositions.date}`}
                >
                  <div className="overflow-x-auto -mx-1 px-1">
                    <table className="w-full min-w-[620px] text-xs font-mono tabular-nums border-collapse">
                      <thead>
                        <tr className="text-zinc-500 text-right">
                          <th className="py-1 pr-2 font-normal text-left">机构席位</th>
                          <th className="py-1 px-1 font-normal text-red-500/80">多单</th>
                          <th className="py-1 px-1 font-normal">多增减</th>
                          <th className="py-1 px-1 font-normal text-green-500/80">空单</th>
                          <th className="py-1 px-1 font-normal">空增减</th>
                          <th className="py-1 px-1 font-normal">净多单</th>
                          <th className="py-1 px-1 font-normal">今日净增</th>
                          <th className="py-1 pl-1 font-normal">近7日净增</th>
                        </tr>
                      </thead>
                      <tbody>
                        {instPositions.list.slice(0, 12).map((r) => (
                          <tr key={r.name} className="border-t border-zinc-800/60 text-right">
                            <td className="py-[3px] pr-2 text-left text-zinc-200 truncate max-w-[110px]">{r.name}</td>
                            <td className="py-[3px] px-1 text-red-400">{r.long.toLocaleString('en-US')}</td>
                            <td className={`py-[3px] px-1 ${upClass(r.longChange)}`}>{r.longChange > 0 ? '+' : ''}{r.longChange.toLocaleString('en-US')}</td>
                            <td className="py-[3px] px-1 text-green-400">{r.short.toLocaleString('en-US')}</td>
                            <td className={`py-[3px] px-1 ${r.shortChange > 0 ? 'text-green-400' : r.shortChange < 0 ? 'text-red-400' : 'text-zinc-400'}`}>{r.shortChange > 0 ? '+' : ''}{r.shortChange.toLocaleString('en-US')}</td>
                            <td className={`py-[3px] px-1 font-semibold ${upClass(r.netLong)}`}>{r.netLong > 0 ? '+' : ''}{r.netLong.toLocaleString('en-US')}</td>
                            <td className={`py-[3px] px-1 font-semibold ${upClass(r.longChange - r.shortChange)}`}>{r.longChange - r.shortChange > 0 ? '+' : ''}{(r.longChange - r.shortChange).toLocaleString('en-US')}</td>
                            <td className={`py-[3px] pl-1 font-semibold ${upClass(r.net7d)}`}>{r.net7d > 0 ? '+' : ''}{r.net7d.toLocaleString('en-US')}</td>
                          </tr>
                        ))}
                        <tr className="border-t border-zinc-700/60 text-right">
                          <td className="py-1 pr-2 text-left text-zinc-400 font-semibold">前20会员合计</td>
                          <td className="py-1 px-1 text-red-400 font-semibold">{instPositions.totalLong.toLocaleString('en-US')}</td>
                          <td className="py-1 px-1" />
                          <td className="py-1 px-1 text-green-400 font-semibold">{instPositions.totalShort.toLocaleString('en-US')}</td>
                          <td className="py-1 px-1" />
                          <td className={`py-1 px-1 font-bold ${upClass(instPositions.totalLong - instPositions.totalShort)}`}>
                            {instPositions.totalLong - instPositions.totalShort > 0 ? '+' : ''}{(instPositions.totalLong - instPositions.totalShort).toLocaleString('en-US')}
                          </td>
                          {(() => {
                            const net1d = instPositions.list.slice(0, 20).reduce((s, r) => s + r.longChange - r.shortChange, 0);
                            return (
                              <td className={`py-1 px-1 font-bold ${upClass(net1d)}`}>
                                {net1d > 0 ? '+' : ''}{net1d.toLocaleString('en-US')}
                              </td>
                            );
                          })()}
                          <td className="py-1 pl-1" />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-[10px] text-zinc-600 font-mono">
                    多/空单为会员持买仓量/持卖仓量 (IF/IH/IC/IM 主力品种合计) · 净多单 = 多单 - 空单 · 今日净增 = 多增 - 空增 · 近7日净增 = 7个交易日累计(多增 - 空增) · 数据来源: 中金所/东方财富Choice · 席位数据含全部客户, 仅供参考
                  </p>
                </Panel>
              )}

              {/* 涨跌停与连板梯队 */}
              {sentiment && (
                <Panel
                  icon={Flame}
                  title="涨跌停与连板梯队"
                  subtitle={`${sentiment.date} · 打板情绪与空间高度`}
                >
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: '涨停', v: String(sentiment.limitUp), c: 'text-red-500' },
                      { label: '跌停', v: String(sentiment.limitDown), c: 'text-green-500' },
                      { label: '炸板', v: String(sentiment.broken), c: 'text-amber-400' },
                      { label: '最高连板', v: `${sentiment.maxBoards}板`, c: 'text-purple-400' },
                    ].map((s) => (
                      <div key={s.label} className="rounded-lg bg-zinc-800/40 border border-zinc-800 px-1.5 py-1.5 text-center">
                        <div className="text-[9px] text-zinc-500">{s.label}</div>
                        <div className={`text-base font-bold font-mono tabular-nums ${s.c}`}>{s.v}</div>
                      </div>
                    ))}
                  </div>

                  {zbRate !== null && (
                    <div className="mt-3">
                      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mb-1">
                        <span>炸板率</span>
                        <span className={zbRate >= 40 ? 'text-green-400' : zbRate <= 20 ? 'text-red-400' : 'text-amber-400'}>
                          {zbRate.toFixed(1)}%
                        </span>
                      </div>
                      <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-red-500/70 to-amber-500/70"
                          style={{ width: `${Math.min(zbRate, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}

                  {sentiment.ladder.length > 0 && (
                    <>
                      <div className="mt-3 pt-3 border-t border-zinc-800/70 mb-1 text-[10px] font-semibold text-zinc-500 font-mono uppercase tracking-wider">
                        连板梯队 TOP {sentiment.ladder.length}
                      </div>
                      <div className="space-y-0.5">
                        {sentiment.ladder.map((s) => (
                          <button
                            type="button"
                            key={s.code}
                            onClick={() => onSelectStock(s.code)}
                            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-blue-500/10 border border-transparent hover:border-blue-500/20 transition-colors cursor-pointer text-left group"
                            title={`查看 ${s.name} (${s.code}) 缠论分析`}
                          >
                            <span className={`inline-flex items-center justify-center h-5 min-w-[36px] px-1.5 rounded border text-[10px] font-bold font-mono shrink-0 ${boardCls(s.lbc)}`}>
                              {s.lbc}板
                            </span>
                            <span className="text-xs text-zinc-200 truncate group-hover:text-blue-400 transition-colors">{s.name}</span>
                            <span className="ml-auto text-[10px] font-mono text-zinc-600 truncate hidden md:inline">{s.industry}</span>
                            <ChevronRight className="h-3 w-3 text-zinc-700 group-hover:text-blue-400 transition-colors shrink-0" />
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </Panel>
              )}

              {/* 板块资金流向 */}
              {(sectorIn.length > 0 || sectorOut.length > 0) && (
                <Panel
                  icon={LayoutGrid}
                  title="板块资金流向"
                  subtitle="行业板块 · 今日主力净流入排行"
                >
                  <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
                    {[
                      { title: '净流入 TOP', items: sectorIn, max: sectorInMax },
                      { title: '净流出 TOP', items: sectorOut, max: sectorOutMax },
                    ].map((group) => (
                      <div key={group.title}>
                        <div className="text-[10px] font-semibold text-zinc-500 font-mono uppercase tracking-wider mb-1.5 px-2">
                          {group.title}
                        </div>
                        <div className="space-y-0.5">
                          {group.items.map((item, idx) => {
                            const inflow = item.mainInflow >= 0;
                            const w = (Math.abs(item.mainInflow) / group.max) * 100;
                            return (
                              <div
                                key={item.code}
                                className="relative flex items-center justify-between gap-2 px-2 py-1.5 rounded-md overflow-hidden hover:bg-zinc-800/40 transition-colors"
                              >
                                <div
                                  className={`absolute inset-y-0 left-0 rounded-sm ${inflow ? 'bg-red-500/10' : 'bg-green-500/10'}`}
                                  style={{ width: `${w}%` }}
                                />
                                <div className="relative flex items-center gap-2 min-w-0">
                                  <span className="text-[10px] font-mono text-zinc-600 w-4 shrink-0">{idx + 1}</span>
                                  <span className="text-xs text-zinc-200 truncate">{item.name}</span>
                                </div>
                                <div className="relative flex items-center gap-1.5 md:gap-2.5 font-mono text-xs tabular-nums shrink-0">
                                  <span className={`w-12 text-right ${upClass(item.changePercent)}`}>
                                    {item.changePercent >= 0 ? '+' : ''}{item.changePercent.toFixed(2)}%
                                  </span>
                                  <span className={`w-16 md:w-[68px] text-right font-semibold ${upClass(item.mainInflow)}`}>
                                    {formatSignedYi(item.mainInflow)}
                                  </span>
                                  <span className={`hidden min-[400px]:inline w-11 text-right ${upClass(item.mainPercent)}`}>
                                    {item.mainPercent >= 0 ? '+' : ''}{item.mainPercent.toFixed(1)}%
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-[10px] text-zinc-600 font-mono">右侧百分比为主力净流入占比 (主力净流入 / 板块成交额)</p>
                </Panel>
              )}
            </div>
          )}

          {/* 右列: 今日资金流向 + 主力趋势 + 个股榜, 下沉错位 */}
          {hasRight && (
            <div className={`order-1 lg:order-2 ${hasLeft ? 'lg:col-span-5' : 'lg:col-span-12'} min-w-0 flex flex-col gap-4 md:gap-6`}>

              {/* 今日大盘资金流向 */}
              {flow && (
                <Panel
                  icon={Waves}
                  title="今日大盘资金流向"
                  subtitle="沪深两市合计 · 按单笔委托规模分层"
                  right={
                    <span className={`font-mono font-bold text-base md:text-lg tabular-nums ${upClass(flow.main)}`}>
                      {formatSignedYi(flow.main)}
                    </span>
                  }
                >
                  <div className="flex-1 flex flex-col justify-center gap-3 py-1 min-h-[120px]">
                    {flowLayers.map((layer) => {
                      const pos = layer.value >= 0;
                      const w = (Math.abs(layer.value) / flowMaxAbs) * 50;
                      return (
                        <div key={layer.label} className="flex items-center gap-3">
                          <span className="text-xs text-zinc-400 w-11 shrink-0">{layer.label}</span>
                          <div className="relative flex-1 h-2.5 rounded-full bg-zinc-800/60 overflow-hidden">
                            <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-700/80 z-10" />
                            <div
                              className={`absolute inset-y-0 ${pos ? 'left-1/2 bg-red-500/80' : 'right-1/2 bg-green-500/80'}`}
                              style={{ width: `${w}%` }}
                            />
                          </div>
                          <span className={`font-mono text-xs tabular-nums w-24 text-right shrink-0 ${upClass(layer.value)}`}>
                            {formatSignedYi(layer.value)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-4 text-[10px] text-zinc-600 font-mono leading-relaxed">
                    主力 = 超大单 + 大单 · 正值表示净流入, 负值表示净流出 · 数据来源: 东方财富
                  </p>
                </Panel>
              )}

              {/* 近30日主力资金趋势 */}
              {chartData.length > 1 && (
                <Panel
                  icon={TrendingUp}
                  title="大盘主力资金动向"
                  subtitle={`近 ${chartData.length} 个交易日 · 沪深两市主力净流入`}
                  right={
                    <span className="text-[10px] font-mono text-zinc-500">
                      区间合计{' '}
                      <span className={upClass(chartData.reduce((acc, d) => acc + d.main, 0))}>
                        {formatSignedYi(chartData.reduce((acc, d) => acc + d.main, 0))}
                      </span>
                    </span>
                  }
                >
                  <div className="h-[220px] -ml-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                        <CartesianGrid vertical={false} stroke="#27272a" strokeDasharray="3 3" />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: '#71717a', fontSize: 10 }}
                          axisLine={{ stroke: '#3f3f46' }}
                          tickLine={false}
                          interval={Math.max(0, Math.floor(chartData.length / 6))}
                        />
                        <YAxis
                          tick={{ fill: '#71717a', fontSize: 10 }}
                          axisLine={false}
                          tickLine={false}
                          width={56}
                          tickFormatter={(v: number) => `${v >= 0 ? '' : '-'}${Math.abs(v / 1e8).toFixed(0)}亿`}
                        />
                        <Tooltip content={<FlowTooltip />} cursor={{ fill: 'rgba(63, 63, 70, 0.25)' }} />
                        <Bar dataKey="main" radius={[2, 2, 0, 0]} maxBarSize={18}>
                          {chartData.map((d, i) => (
                            <Cell key={i} fill={d.main >= 0 ? '#ef4444' : '#22c55e'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Panel>
              )}

              {/* 个股主力净流入榜 */}
              {stockTop.length > 0 && (
                <Panel
                  icon={ListOrdered}
                  title="个股主力净流入榜"
                  subtitle="沪深A股 TOP 10 · 点击查看缠论分析"
                >
                  <div className="space-y-0.5">
                    {stockTop.map((item, idx) => (
                      <button
                        type="button"
                        key={item.code}
                        onClick={() => onSelectStock(item.code)}
                        className="w-full flex items-center justify-between gap-2 px-2 py-2 rounded-md hover:bg-blue-500/10 border border-transparent hover:border-blue-500/20 transition-colors cursor-pointer text-left group"
                        title={`查看 ${item.name} (${item.code}) 缠论分析`}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[10px] font-mono text-zinc-600 w-4 shrink-0">{idx + 1}</span>
                          <div className="min-w-0">
                            <div className="text-xs text-zinc-200 truncate group-hover:text-blue-400 transition-colors">{item.name}</div>
                            <div className="text-[9px] font-mono text-zinc-600">{item.code}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 md:gap-2.5 font-mono text-xs tabular-nums shrink-0">
                          <span className="w-12 md:w-14 text-right text-zinc-300">{item.price.toFixed(2)}</span>
                          <span className={`w-12 text-right ${upClass(item.changePercent)}`}>
                            {item.changePercent >= 0 ? '+' : ''}{item.changePercent.toFixed(2)}%
                          </span>
                          <span className={`w-16 md:w-[68px] text-right font-semibold ${upClass(item.mainInflow)}`}>
                            {formatSignedYi(item.mainInflow)}
                          </span>
                          <span className={`hidden xl:inline w-11 text-right ${upClass(item.mainPercent)}`}>
                            {item.mainPercent >= 0 ? '+' : ''}{item.mainPercent.toFixed(1)}%
                          </span>
                          <ChevronRight className="h-3.5 w-3.5 text-zinc-700 group-hover:text-blue-400 transition-colors shrink-0" />
                        </div>
                      </button>
                     ))}
                   </div>
                </Panel>
              )}

              {/* 热门板块与领涨龙头 */}
              {hotSectors.length > 0 && (
                <Panel
                  icon={Trophy}
                  title="热门板块与龙头"
                  subtitle="行业板块涨幅榜 · 点击龙头股查看缠论分析"
                >
                  <div className="space-y-0.5">
                    {hotSectors.map((s, idx) => (
                      <div
                        key={s.code}
                        className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-zinc-800/40 transition-colors"
                      >
                        <span className="text-[10px] font-mono text-zinc-600 w-4 shrink-0">{idx + 1}</span>
                        <div className="w-[76px] sm:w-[88px] min-w-0 shrink-0">
                          <span className="block text-xs text-zinc-200 truncate" title={s.name}>{s.name}</span>
                          <span className={`block font-mono text-xs tabular-nums ${upClass(s.changePercent)}`}>
                            {s.changePercent >= 0 ? '+' : ''}{s.changePercent.toFixed(2)}%
                          </span>
                        </div>
                        <div className="hidden sm:flex flex-col items-end leading-tight shrink-0">
                          <span className="text-[9px] text-zinc-600">主力净流入</span>
                          <span className={`font-mono text-xs tabular-nums ${upClass(s.mainInflow)}`}>
                            {formatSignedYi(s.mainInflow)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => onSelectStock(s.leaderCode)}
                          className="ml-auto min-w-0 flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 rounded-md hover:bg-blue-500/10 border border-transparent hover:border-blue-500/20 transition-colors cursor-pointer group"
                          title={`查看 ${s.leaderName} (${s.leaderCode}) 缠论分析`}
                        >
                          <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1 py-px shrink-0">龙头</span>
                          <span className="text-xs text-zinc-200 truncate group-hover:text-blue-400 transition-colors">{s.leaderName}</span>
                          <span className={`font-mono text-xs tabular-nums shrink-0 ${upClass(s.leaderChangePercent)}`}>
                            {s.leaderChangePercent >= 0 ? '+' : ''}{s.leaderChangePercent.toFixed(2)}%
                          </span>
                          <ChevronRight className="h-3 w-3 text-zinc-700 group-hover:text-blue-400 transition-colors shrink-0" />
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-[10px] text-zinc-600 font-mono">按板块涨跌幅排序 · 龙头为该板块今日领涨个股</p>
                </Panel>
              )}
            </div>
          )}
        </div>
      )}

      <p className="text-[10px] font-mono text-zinc-600 text-center">
        数据来源: 腾讯行情 / 东方财富 (含涨跌停池) / Binance (加密货币) · 仅供参考, 不构成投资建议
      </p>
    </div>
  );
}
