export interface Kline {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MergedKline {
  high: number;
  low: number;
  direction: 'up' | 'down';
  originalIndices: number[]; // Index array of original Klines merged into this
  originalHigh: number;
  originalLow: number;
}

export type FractionType = 'TOP' | 'BOTTOM';

export interface Fraction {
  type: FractionType;
  price: number;
  index: number;         // Index in the *merged* K-line array
  originalIndex: number; // Index in the *original* K-line array
  date: string;
}

export interface Stroke {
  id: string;
  start: Fraction;
  end: Fraction;
  direction: 'up' | 'down';
}

export interface Segment {
  id: string;
  start: Fraction;
  end: Fraction;
  direction: 'up' | 'down';
}

export interface Hub {
  id: string;
  zg: number;       // 中枢高点 = min of the 3 stroke highs
  zd: number;       // 中枢低点 = max of the 3 stroke lows
  gg: number;       // 最高点 = max of all stroke highs in hub
  dd: number;       // 最低点 = min of all stroke lows in hub
  startIndex: number; // Start index in original Klines
  endIndex: number;   // End index in original Klines
  strokesCount: number;
  level: number;    // 中枢级别: 1=笔中枢, 2=线段中枢
}

export type BuySellSignalType = 'BUY_1' | 'BUY_2' | 'BUY_3' | 'SELL_1' | 'SELL_2' | 'SELL_3';

export interface BuySellPoint {
  id: string;
  type: BuySellSignalType;
  price: number;
  originalIndex: number;
  date: string;
  reason: string;
  /** MACD背驰辅助信息 */
  divergence?: {
    /** 是否存在MACD背驰 */
    hasMACDDivergence: boolean;
    /** 背驰类型描述 */
    description: string;
  };
  /** 关联的中枢ID（三买/三卖时使用） */
  hubId?: string;
  /** 趋势前提：该买卖点前是否存在至少两个同向中枢 */
  hasTrendPremise?: boolean;
}

export interface StockInfo {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
}

export interface BacktestTrade {
  id: string;
  type: 'BUY' | 'SELL';
  signalType: BuySellSignalType | 'STOP_LOSS' | 'TAKE_PROFIT' | 'MANUAL';
  price: number;
  date: string;
  shares: number;
  value: number;
  pnl?: number;      // Populated on SELL trades
  pnlPercent?: number;
}

export interface BacktestResult {
  id: string;
  userId: string;
  symbol: string;
  startDate: string;
  endDate: string;
  initialBalance: number;
  finalBalance: number;
  totalReturnPercent: number;
  totalTrades: number;
  winningTrades: number;
  winRate: number;
  trades: BacktestTrade[];
  createdAt: string;
}
